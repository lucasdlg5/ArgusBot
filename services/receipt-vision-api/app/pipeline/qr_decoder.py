"""
Camada 0 — Decodificação de QR Code e Chave de Acesso SEFAZ (44 dígitos).

Motivação observada nas notas reais:
- Cupons NFC-e (Shibata, Comercial Matrit) e Contingência (Marcelo de Toledo / Athos)
  trazem QR Code no rodapé contendo a URL oficial da SEFAZ e/ou a chave de 44 dígitos.
- Cupons internos ("PEDIDO" do Mercado Souza) não possuem QR Code nem chave SEFAZ.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional
import cv2
import numpy as np

try:
    from pyzbar.pyzbar import decode as pyzbar_decode  # type: ignore
except Exception:
    pyzbar_decode = None


SEFAZ_KEY_RE = re.compile(r"(?<!\d)(\d{44})(?!\d)")
SEFAZ_GROUPED_KEY_RE = re.compile(r"(?:\d{4}[\s.-]*){11}")


@dataclass
class QrExtractionResult:
    qr_url: Optional[str] = None
    access_key_44: Optional[str] = None
    is_contingency: bool = False


def extract_access_key_from_text(text: str) -> Optional[str]:
    """Extrai chave SEFAZ de 44 dígitos (contínua ou agrupada em blocos de 4)."""
    if not text:
        return None
    direct = SEFAZ_KEY_RE.search(text)
    if direct:
        return direct.group(1)

    for match in SEFAZ_GROUPED_KEY_RE.finditer(text):
        digits = re.sub(r"\D", "", match.group(0))
        if len(digits) == 44:
            return digits
    return None


def decode_qr_from_image(image_bgr_or_gray: np.ndarray) -> QrExtractionResult:
    """
    Tenta decodificar QR Code em múltiplas escalas/níveis de contraste.
    Usa pyzbar (se instalado) com fallback para cv2.QRCodeDetector.
    """
    result = QrExtractionResult()
    if image_bgr_or_gray is None or image_bgr_or_gray.size == 0:
        return result

    gray = (
        cv2.cvtColor(image_bgr_or_gray, cv2.COLOR_BGR2GRAY)
        if len(image_bgr_or_gray.shape) == 3
        else image_bgr_or_gray
    )

    candidates = [gray]
    # Foca no terço inferior (onde o QR Code aparece em NFC-e) em 2x de escala para QR denso
    h, _ = gray.shape
    bottom = gray[int(h * 0.55) :, :]
    if bottom.size > 0:
        upscaled = cv2.resize(bottom, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
        candidates.append(upscaled)
        _, otsu = cv2.threshold(upscaled, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        candidates.append(otsu)

    raw_payloads: list[str] = []

    if pyzbar_decode is not None:
        for img in candidates:
            decoded = pyzbar_decode(img)
            for item in decoded:
                payload = item.data.decode("utf-8", errors="ignore").strip()
                if payload:
                    raw_payloads.append(payload)
            if raw_payloads:
                break

    if not raw_payloads:
        detector = cv2.QRCodeDetector()
        for img in candidates:
            data, _, _ = detector.detectAndDecode(img)
            if data and data.strip():
                raw_payloads.append(data.strip())
                break

    for payload in raw_payloads:
        if payload.startswith("http"):
            result.qr_url = payload
        key = extract_access_key_from_text(payload)
        if key:
            result.access_key_44 = key
        # Na URL NFC-e, tpEmis=9 (ou parâmetro |9| no QR v2) indica contingência offline
        if "|9|" in payload or "tpEmis=9" in payload:
            result.is_contingency = True

    return result
