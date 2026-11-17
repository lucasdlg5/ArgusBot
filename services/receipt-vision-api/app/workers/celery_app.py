"""
Fila assíncrona Celery + Redis para processamento em background de lotes grandes
ou notas com múltiplas partes de alta resolução.
"""

from __future__ import annotations

import base64
from typing import List
import cv2
from celery import Celery

from app.config import settings
from app.pipeline.image_pipeline import run_image_pipeline
from app.pipeline.qr_decoder import QrExtractionResult, decode_qr_from_image
from app.pipeline.receipt_stitcher import stitch_receipt_parts
from app.pipeline.semantic_parser import extract_structured_receipt
from app.schemas import ReceiptProcessResponse

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
    processed_parts = [run_image_pipeline(raw, part_index=i) for i, raw in enumerate(images_bytes)]
    stitch_res = stitch_receipt_parts(processed_parts)

    # Tenta decodificar QR Code na imagem unificada (e nas partes finais se necessário)
    qr_info = decode_qr_from_image(stitch_res.unified_grayscale)
    if not qr_info.qr_url and not qr_info.access_key_44:
        for part in reversed(processed_parts):
            candidate_qr = decode_qr_from_image(part.grayscale_clean)
            if candidate_qr.qr_url or candidate_qr.access_key_44:
                qr_info = candidate_qr
                break

    header, items, totals, math_report, ocr_text = extract_structured_receipt(
        unified_grayscale=stitch_res.unified_grayscale,
        unified_binary=stitch_res.unified_binary,
        qr_info=qr_info,
        stitch_mode=stitch_res.summary.stitch_mode,
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
