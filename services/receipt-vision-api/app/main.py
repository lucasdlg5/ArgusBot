"""
API REST FastAPI para Leitura, Aprimoramento e Costura de Cupons Fiscais.

Endpoints principais:
- POST /v1/receipts/process : recebe 1..N fotos da mesma nota (List[UploadFile]),
  executa o pipeline OpenCV + Stitching + Extração Multi-Layout + Self-Healing Math Check.
- GET  /v1/receipts/jobs/{job_id} : consulta status/resultado quando processado via Celery.
- GET  /v1/receipts/artifacts/{artifact_id}.png : serve a imagem final unificada via URL.
"""

from __future__ import annotations

import base64
import uuid
from pathlib import Path
from typing import List

from celery.result import AsyncResult
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.config import settings
from app.schemas import ReceiptProcessResponse
from app.workers.celery_app import (
    celery_app,
    process_receipt_batch_sync,
    process_receipt_batch_task,
)

ARTIFACTS_DIR = Path("/tmp/argus_receipt_artifacts")
ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="Microsserviço de Visão Computacional para NFC-e, SAT, Contingência e Pedidos.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check() -> dict:
    return {"status": "ok", "service": settings.app_name, "version": settings.app_version}


@app.post("/v1/receipts/process", response_model=ReceiptProcessResponse)
async def process_receipt(
    files: List[UploadFile] = File(..., description="Uma ou mais partes da mesma nota fiscal"),
    include_images_base64: bool = Form(True),
    async_mode: bool = Form(False),
):
    if not files:
        raise HTTPException(status_code=400, detail="Envie ao menos uma imagem.")

    images_bytes: List[bytes] = []
    for f in files:
        if f.content_type and not f.content_type.startswith("image/"):
            raise HTTPException(
                status_code=415, detail=f"Arquivo inválido ({f.filename}): envie apenas imagens."
            )
        data = await f.read()
        if not data:
            raise HTTPException(status_code=400, detail=f"Arquivo vazio: {f.filename}")
        images_bytes.append(data)

    if async_mode or settings.use_async_queue:
        payload_b64 = [base64.b64encode(b).decode("ascii") for b in images_bytes]
        task = process_receipt_batch_task.delay(payload_b64, include_images_base64)
        raise HTTPException(
            status_code=202,
            detail={"status": "queued", "job_id": task.id, "poll_url": f"/v1/receipts/jobs/{task.id}"},
        )

    try:
        response = process_receipt_batch_sync(
            images_bytes, include_images_base64=include_images_base64
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Salva artefato PNG unificado para acesso direto por URL além do base64
    if response.final_image_base64:
        artifact_name = f"{uuid.uuid4().hex}.png"
        artifact_path = ARTIFACTS_DIR / artifact_name
        artifact_path.write_bytes(base64.b64decode(response.final_image_base64))
        response.final_image_url = f"/v1/receipts/artifacts/{artifact_name}"

    return response


@app.get("/v1/receipts/jobs/{job_id}")
async def get_job_status(job_id: str) -> dict:
    res = AsyncResult(job_id, app=celery_app)
    if res.state == "PENDING":
        return {"job_id": job_id, "status": "pending"}
    if res.state == "FAILURE":
        return {"job_id": job_id, "status": "failed", "error": str(res.info)}
    if res.state == "SUCCESS":
        return {"job_id": job_id, "status": "completed", "result": res.result}
    return {"job_id": job_id, "status": res.state.lower()}


@app.get("/v1/receipts/artifacts/{filename}")
async def get_artifact(filename: str):
    safe_name = Path(filename).name
    target = ARTIFACTS_DIR / safe_name
    if not target.exists():
        raise HTTPException(status_code=404, detail="Artefato não encontrado.")
    return FileResponse(target, media_type="image/png")
