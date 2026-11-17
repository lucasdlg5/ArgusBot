"""
Camada 5 — Extrator Semântico Multi-Layout e Validador Matemático (Self-Healing).

Lida com os 3 layouts reais identificados nas 14 notas analisadas:
1. NFC-e / SAT 1 linha: `01 0789... CHOCOLATE NESTLE KIT 1 UN x 4,79 F 4,79`
2. NFC-e / Contingência 2 linhas (pesáveis):
   Linha 1: `95 02067423000000 PEITO PERU DEF SEARA`
   Linha 2: `0,318 KG x 69,90 F 22,23`
3. Pedido / Cupom Não-Fiscal tabular (ex.: Mercado Souza):
   `PANCO DELICIOSOS SALG Q   1   10,49   10,49`

Inclui também:
- Normalização de sequência truncada na margem esquerda (98, 99, 00, 01 -> 98, 99, 100, 101).
- Validação matemática por item e do cupom inteiro (`Soma(Itens) - Descontos == Total Pago`),
  sinalizando `confidence_warning = True` e apontando os itens suspeitos.
"""

from __future__ import annotations

import json
import re
from typing import List, Optional, Tuple
import cv2
import numpy as np

from app.config import settings
from app.pipeline.qr_decoder import QrExtractionResult, extract_access_key_from_text
from app.pipeline.receipt_stitcher import deduplicate_sequential_items
from app.schemas import (
    MathValidationReport,
    ReceiptDocumentType,
    ReceiptHeader,
    ReceiptItem,
    ReceiptTotals,
)

try:
    import pytesseract  # type: ignore
except Exception:
    pytesseract = None

try:
    from google import genai  # type: ignore
    from google.genai import types as genai_types  # type: ignore
except Exception:
    genai = None
    genai_types = None


def normalize_truncated_sequences(items: List[ReceiptItem]) -> List[ReceiptItem]:
    """
    Corrige numeração de 2 dígitos truncada na margem esquerda de cupons longos (>99 itens),
    ex.: 98, 99, 00, 01, ..., 11 -> 98, 99, 100, 101, ..., 111.
    """
    if not items:
        return items

    offset = 0
    prev_raw: Optional[int] = None
    for item in items:
        if item.sequence_number is None:
            continue
        raw = item.sequence_number
        if prev_raw is not None and raw < prev_raw and prev_raw >= 90 and raw < 20:
            offset += 100
        item.sequence_number = raw + offset
        prev_raw = raw
    return items


def validate_receipt_math(
    items: List[ReceiptItem],
    totals: ReceiptTotals,
    tolerance: float = settings.math_tolerance_brl,
) -> MathValidationReport:
    """
    Valida matematicamente:
    1) Para cada item: `abs(quantity * unit_price - total_price) <= 0.03`
    2) Para o cupom: `abs((sum(items.total_price) - discounts) - total_paid) <= tolerance`
    Marca `confidence_warning = True` nos itens e no relatório quando houver divergência.
    """
    suspect_items: List[str] = []
    items_sum = 0.0

    for idx, item in enumerate(items, start=1):
        items_sum += float(item.total_price or 0.0)
        if item.quantity > 0 and item.unit_price > 0:
            calc = round(item.quantity * item.unit_price, 2)
            diff_item = abs(calc - round(item.total_price, 2))
            if diff_item > 0.03:
                item.confidence_warning = True
                item.warning_reason = (
                    f"Qtd ({item.quantity}) x Unit ({item.unit_price:.2f}) = {calc:.2f}, "
                    f"mas total lido foi {item.total_price:.2f}"
                )
                label = f"#{item.sequence_number or idx} {item.description}"
                suspect_items.append(f"{label}: {item.warning_reason}")

    items_sum = round(items_sum, 2)
    expected_total = round(items_sum - float(totals.discounts or 0.0), 2)
    declared_total = round(float(totals.total_paid or totals.subtotal or expected_total), 2)
    discrepancy = round(abs(expected_total - declared_total), 2)
    is_consistent = discrepancy <= tolerance

    if not is_consistent and not suspect_items:
        # Heurística de Self-Healing: sugere itens cujo valor tem dígitos propensos a confusão térmica (3<->8, 5<->6)
        for idx, item in enumerate(items, start=1):
            price_str = f"{item.total_price:.2f}"
            if any(ch in price_str for ch in ("3", "8", "5", "6")):
                item.confidence_warning = True
                item.warning_reason = (
                    f"Divergência global de R$ {discrepancy:.2f}; verificar dígitos térmicos ({price_str})."
                )
                suspect_items.append(f"#{item.sequence_number or idx} {item.description} ({price_str})")
                if len(suspect_items) >= 5:
                    break

    return MathValidationReport(
        items_sum=items_sum,
        expected_total=expected_total,
        declared_total=declared_total,
        discrepancy_brl=discrepancy,
        is_consistent=is_consistent,
        confidence_warning=not is_consistent or len(suspect_items) > 0,
        suspect_items=suspect_items,
    )


def _extract_ocr_text_local(binary_image: np.ndarray) -> str:
    if pytesseract is None:
        return ""
    try:
        return pytesseract.image_to_string(binary_image, lang="por", config="--psm 6")
    except Exception:
        try:
            return pytesseract.image_to_string(binary_image, config="--psm 6")
        except Exception:
            return ""


def _parse_brl_float(raw: str) -> float:
    cleaned = raw.strip().replace(".", "").replace(",", ".")
    return float(cleaned)


def _parse_receipt_text_deterministic(
    ocr_text: str, qr_info: QrExtractionResult
) -> Tuple[ReceiptHeader, List[ReceiptItem], ReceiptTotals]:
    """
    Parser determinístico multi-layout para fallback offline (quando sem Gemini API Key).
    Suporta linhas NFC-e 1-linha, NFC-e 2-linhas (KG) e tabela PEDIDO.
    """
    lines = [ln.strip() for ln in ocr_text.splitlines() if ln.strip()]
    joined = "\n".join(lines)

    cnpj_match = re.search(r"CNPJ[:\s]*(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}|\d{14})", joined, re.I)
    date_match = re.search(r"(\d{2}/\d{2}/\d{2,4}\s+\d{2}:\d{2}(?::\d{2})?)", joined)
    total_match = re.search(
        r"(?:VALOR\s+TOTAL(?:\s*\(R\$\))?|VALOR\s+A\s+PAGAR\s*R\$|TOTAL\s*:)\s*(\d[\d.]*,\d{2})",
        joined,
        re.I,
    )
    disc_match = re.search(r"DESCONTOS?\s*:?\s*(\d[\d.]*,\d{2})", joined, re.I)
    access_key = qr_info.access_key_44 or extract_access_key_from_text(joined)

    doc_type = ReceiptDocumentType.UNKNOWN
    if re.search(r"CONTING[ÊE]NCIA", joined, re.I) or qr_info.is_contingency:
        doc_type = ReceiptDocumentType.NFCE_CONTINGENCY
    elif access_key or qr_info.qr_url or re.search(r"NOTA FISCAL DE CONSUMIDOR|NFC-e", joined, re.I):
        doc_type = ReceiptDocumentType.NFCE
    elif re.search(r"\bPEDIDO\b", joined, re.I):
        doc_type = ReceiptDocumentType.ORDER_SLIP

    store_name = lines[0] if lines else ""
    for ln in lines[:6]:
        if len(ln) >= 4 and not re.match(r"^(PEDIDO|CNPJ|R\.|RUA|AV\.|DOCUMENTO)", ln, re.I):
            store_name = ln
            break

    items: List[ReceiptItem] = []
    # Padrão 1: `01 07891000248760 CHOCOLATE NESTLE KIT 1 UN x 4,79 F 4,79`
    nfce_single_re = re.compile(
        r"^(\d{1,3})\s+(\d{4,14})\s+(.+?)\s+(\d+(?:[.,]\d+)?)\s+(UN|KG|G|L|ML|PC|CX)\s*[xX]\s*(\d+[.,]\d{2})\s*[A-Z0-9]{0,4}\s+(\d+[.,]\d{2})$"
    )
    # Padrão 3: `PANCO DELICIOSOS SALG Q 1 10,49 10,49`
    order_row_re = re.compile(
        r"^([A-Z0-9][A-Z0-9\s/.\-]{2,}?)\s+(\d+(?:[.,]\d{1,3})?)\s+(\d+[.,]\d{2})\s+(\d+[.,]\d{2})$"
    )

    for ln in lines:
        m1 = nfce_single_re.match(ln)
        if m1:
            items.append(
                ReceiptItem(
                    sequence_number=int(m1.group(1)),
                    code=m1.group(2),
                    description=m1.group(3).strip(),
                    quantity=_parse_brl_float(m1.group(4)),
                    unit=m1.group(5).upper(),
                    unit_price=_parse_brl_float(m1.group(6)),
                    total_price=_parse_brl_float(m1.group(7)),
                )
            )
            continue

        m3 = order_row_re.match(ln)
        if m3 and not re.search(r"\b(TOTAL|CREDITO|DEBITO|TROCO|ALIMENTACAO|REFEICAO)\b", ln, re.I):
            items.append(
                ReceiptItem(
                    description=m3.group(1).strip(),
                    quantity=_parse_brl_float(m3.group(2)),
                    unit="UN",
                    unit_price=_parse_brl_float(m3.group(3)),
                    total_price=_parse_brl_float(m3.group(4)),
                )
            )

    total_paid = _parse_brl_float(total_match.group(1)) if total_match else sum(i.total_price for i in items)
    discounts = _parse_brl_float(disc_match.group(1)) if disc_match else 0.0

    header = ReceiptHeader(
        store_name=store_name,
        cnpj=cnpj_match.group(1) if cnpj_match else None,
        issued_at=date_match.group(1) if date_match else None,
        document_type=doc_type,
    )
    totals = ReceiptTotals(
        subtotal=round(sum(i.total_price for i in items), 2),
        discounts=discounts,
        total_paid=round(total_paid, 2),
        sefaz_access_key=access_key,
        qr_code_url=qr_info.qr_url,
    )
    return header, items, totals


def extract_structured_receipt(
    unified_grayscale: np.ndarray,
    unified_binary: np.ndarray,
    qr_info: QrExtractionResult,
    stitch_mode: str,
) -> Tuple[ReceiptHeader, List[ReceiptItem], ReceiptTotals, MathValidationReport, str]:
    """
    Executa extração semântica via Gemini Multimodal (quando configurado) com fallback
    para OCR local + parser determinístico, seguida de deduplicação e validação matemática.
    """
    ocr_text = _extract_ocr_text_local(unified_binary)

    header: Optional[ReceiptHeader] = None
    items: List[ReceiptItem] = []
    totals: Optional[ReceiptTotals] = None

    if settings.gemini_api_key and genai is not None and genai_types is not None:
        try:
            ok, buf = cv2.imencode(".png", unified_grayscale)
            if ok:
                client = genai.Client(api_key=settings.gemini_api_key)
                prompt = (
                    "Você é um extrator especialista em cupons fiscais brasileiros (NFC-e, SAT, Contingência e PEDIDO não-fiscal).\n"
                    f"Modo de junção das fotos: {stitch_mode}.\n"
                    "Regras:\n"
                    "1. Se houver faixa '--- CONTINUACAO DA NOTA ---', continue a leitura sequencial e NÃO duplique itens repetidos na transição.\n"
                    "2. Itens pesáveis podem ocupar 2 linhas (código+descrição na linha 1; QTD KG x VL.UNIT TOTAL na linha 2).\n"
                    "3. Se a numeração da margem esquerda estiver truncada em 2 dígitos (98, 99, 00, 01), preserve ou normalize sequencialmente.\n"
                    "4. Retorne APENAS JSON válido no formato:\n"
                    '{"header":{"store_name":"","cnpj":null,"address":null,"issued_at":null,"order_or_nfce_number":null,"document_type":"nfce|nfce_contingency|sat|order_slip|unknown"},'
                    '"items":[{"sequence_number":1,"code":null,"description":"","quantity":1.0,"unit":"UN","unit_price":0.0,"total_price":0.0}],'
                    '"totals":{"items_count_declared":null,"subtotal":0.0,"discounts":0.0,"total_paid":0.0,"payment_methods":[],"sefaz_access_key":null}}'
                )
                resp = client.models.generate_content(
                    model=settings.gemini_model,
                    contents=[
                        genai_types.Part.from_bytes(data=buf.tobytes(), mime_type="image/png"),
                        prompt,
                    ],
                    config=genai_types.GenerateContentConfig(response_mime_type="application/json"),
                )
                raw_json = (resp.text or "").strip()
                parsed = json.loads(raw_json)
                header = ReceiptHeader(**(parsed.get("header") or {}))
                items = [ReceiptItem(**it) for it in (parsed.get("items") or [])]
                totals = ReceiptTotals(**(parsed.get("totals") or {}))
        except Exception:
            header = None

    if header is None or totals is None:
        header, items, totals = _parse_receipt_text_deterministic(ocr_text, qr_info)

    # Injeta dados de QR Code / SEFAZ se o parser textual não os capturou
    if qr_info.qr_url and not totals.qr_code_url:
        totals.qr_code_url = qr_info.qr_url
    if qr_info.access_key_44 and not totals.sefaz_access_key:
        totals.sefaz_access_key = qr_info.access_key_44
    if qr_info.is_contingency:
        header.document_type = ReceiptDocumentType.NFCE_CONTINGENCY

    items = normalize_truncated_sequences(items)
    items, _ = deduplicate_sequential_items(items)
    math_report = validate_receipt_math(items, totals)

    return header, items, totals, math_report, ocr_text
