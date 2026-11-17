"""
Fila assíncrona Celery + Redis para processamento em background de lotes grandes
ou notas com múltiplas partes de alta resolução.
"""

from __future__ import annotations

import base64
import logging
import time
from typing import List
import cv2
from celery import Celery

from app.config import settings
from app.pipeline.image_pipeline import run_image_pipeline
from app.pipeline.qr_decoder import QrExtractionResult, decode_qr_from_image
from app.pipeline.receipt_stitcher import stitch_receipt_parts
from app.pipeline.semantic_parser import extract_structured_receipt
from app.schemas import ReceiptProcessResponse

logger = logging.getLogger("uvicorn.error")

celery_app = Celery(
    "receipt_vision_worker",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)
celery_app.conf.update(task_serializer="json", result_serializer="json", accept_content=["json"])


def process_receipt_batch_sync(
    images_bytes: List[bytes], include_images_base64: bool = True
) -> ReceiptProcessResponse:
    """Executa o pipeline completo de ponta a ponta (usado no modo síncrono ou pelo worker Celery)."""
    t0 = time.perf_counter()
    total_bytes = sum(len(b) for b in images_bytes)
    logger.info(
        "[INICIO] Processamento de Nota Fiscal | partes=%d | bytes_totais=%d",
        len(images_bytes),
        total_bytes,
    )

    logger.info("[1/4] Executando pipeline OpenCV (crop 4 pontos, orientacao 180, deskew, sombras/bleed-through, CLAHE, Sauvola)")
    processed_parts = []
    for i, raw in enumerate(images_bytes):
        part = run_image_pipeline(raw, part_index=i)
        processed_parts.append(part)
        logger.info(
            "[1/4] Parte %d/%d tratada | dimensoes=%dx%d | blur=%.1f | rotacao=%d deg | deskew=%.2f deg | crop=%s",
            i + 1,
            len(images_bytes),
            part.quality.width,
            part.quality.height,
            part.quality.blur_score,
            part.quality.detected_rotation_deg,
            part.quality.deskew_angle_deg,
            part.quality.cropped_document,
        )

    logger.info("[2/4] Executando costura multi-parte (SIFT/AKAZE + Linear Blending)")
    stitch_res = stitch_receipt_parts(processed_parts)
    uh, uw = stitch_res.unified_grayscale.shape[:2]
    logger.info(
        "[2/4] Costura concluida | modo=%s | overlaps=%d | ordem=%s | imagem_final=%dx%d",
        stitch_res.summary.stitch_mode,
        stitch_res.summary.overlaps_detected,
        stitch_res.summary.ordered_indices,
        uw,
        uh,
    )

    logger.info("[3/4] Decodificando Camada 0 (QR Code SEFAZ / chave 44 digitos)")
    qr_info = decode_qr_from_image(stitch_res.unified_grayscale)
    if not qr_info.qr_url and not qr_info.access_key_44:
        for part in reversed(processed_parts):
            candidate_qr = decode_qr_from_image(part.grayscale_clean)
            if candidate_qr.qr_url or candidate_qr.access_key_44:
                qr_info = candidate_qr
                break
    logger.info(
        "[3/4] QR/SEFAZ concluido | qr_encontrado=%s | chave_44=%s | contingencia=%s",
        bool(qr_info.qr_url),
        qr_info.access_key_44 or "nenhuma",
        qr_info.is_contingency,
    )

    logger.info("[4/4] Executando extracao semantica multi-layout e validacao matematica Self-Healing")
    header, items, totals, math_report, ocr_text = extract_structured_receipt(
        unified_grayscale=stitch_res.unified_grayscale,
        unified_binary=stitch_res.unified_binary,
        qr_info=qr_info,
        stitch_mode=stitch_res.summary.stitch_mode,
    )
    logger.info(
        "[4/4] Extracao concluida | loja=%s | doc_type=%s | itens=%d | total=R$%.2f | divergencia=R$%.2f | warning=%s",
        header.store_name or "N/A",
        header.document_type.value,
        len(items),
        totals.total_paid,
        math_report.discrepancy_brl,
        math_report.confidence_warning,
    )

    gray_b64 = None
    bin_b64 = None
    if include_images_base64:
        ok_g, buf_g = cv2.imencode(".png", stitch_res.unified_grayscale)
        if ok_g:
            gray_b64 = base64.b64encode(buf_g.tobytes()).decode("ascii")
        ok_b, buf_b = cv2.imencode(".png", stitch_res.unified_binary)
        if ok_b:
            bin_b64 = base64.b64encode(buf_b.tobytes()).decode("ascii")

    elapsed = time.perf_counter() - t0
    logger.info(
        "[FIM] Processamento de Nota Fiscal finalizado em %.2fs | status=completed | itens=%d",
        elapsed,
        len(items),
    )

    return ReceiptProcessResponse(
        status="completed",
        quality_reports=[p.quality for p in processed_parts],
        stitch_summary=stitch_res.summary,
        header=header,
        items=items,
        totals=totals,
        math_validation=math_report,
        final_image_base64=gray_b64,
        final_binary_base64=bin_b64,
        raw_ocr_text=ocr_text or None,
    )


@celery_app.task(name="process_receipt_batch")
def process_receipt_batch_task(images_b64: List[str], include_images_base64: bool = True) -> dict:
    raw_list = [base64.b64decode(item) for item in images_b64]
    result = process_receipt_batch_sync(raw_list, include_images_base64=include_images_base64)
    return result.model_dump()
