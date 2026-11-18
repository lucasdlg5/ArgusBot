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
import tempfile
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from celery.result import AsyncResult
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.config import settings
from app.pipeline.video_pipeline import analyze_shelf_video
from app.schemas import (
    ReceiptProcessResponse,
    VideoFilterConfig,
    VideoJobSubmitResponse,
    VideoStatusResponse,
)
from app.workers.celery_app import (
    celery_app,
    process_receipt_batch_sync,
    process_receipt_batch_task,
)

ARTIFACTS_DIR = Path("/tmp/argus_receipt_artifacts")
ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD_PARTS = 5


def _cleanup_old_artifacts(ttl_seconds: int = 1800) -> None:
    cutoff = time.time() - ttl_seconds
    for item in ARTIFACTS_DIR.iterdir():
        try:
            if item.is_file() and item.stat().st_mtime < cutoff:
                item.unlink(missing_ok=True)
        except OSError:
            pass

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
    return {
        "status": "ok",
        "service": settings.app_name,
        "version": settings.app_version,
        "gemini_configured": bool(settings.gemini_api_key.strip()),
        "gemini_model": settings.gemini_model,
    }


@app.post("/v1/receipts/process", response_model=ReceiptProcessResponse)
async def process_receipt(
    files: List[UploadFile] = File(..., description="Uma ou mais partes da mesma nota fiscal"),
    include_images_base64: bool = Form(True),
    extract_semantic: bool = Form(True),
    async_mode: bool = Form(False),
):
    if not files:
        raise HTTPException(status_code=400, detail="Envie ao menos uma imagem.")
    if len(files) > MAX_UPLOAD_PARTS:
        raise HTTPException(
            status_code=400,
            detail=f"Máximo de {MAX_UPLOAD_PARTS} partes por requisição para evitar estouro de memória.",
        )
    _cleanup_old_artifacts()

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
            images_bytes,
            include_images_base64=include_images_base64,
            extract_semantic=extract_semantic,
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


# --- Endpoints de Análise de Vídeos de Gôndola ---
VIDEO_JOBS: Dict[str, VideoStatusResponse] = {}


def _run_video_job(job_id: str, temp_video_path: str, cfg: VideoFilterConfig) -> None:
    try:
        metadata, items = analyze_shelf_video(temp_video_path, config=cfg)
        VIDEO_JOBS[job_id] = VideoStatusResponse(
            job_id=job_id,
            status="completed",
            metadata=metadata,
            items=items,
        )
    except Exception as exc:
        VIDEO_JOBS[job_id] = VideoStatusResponse(
            job_id=job_id,
            status="failed",
            error=str(exc)[:400],
        )
    finally:
        try:
            Path(temp_video_path).unlink(missing_ok=True)
        except Exception:
            pass


@app.post("/api/v1/videos/analyze", response_model=VideoJobSubmitResponse, status_code=202)
async def analyze_shelf_video_endpoint(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(..., description="Vídeo da gôndola (.mp4, .mov, .avi)"),
    clahe_clip_limit: float = Form(2.4),
    gamma: Optional[float] = Form(None),
    denoise_strength: int = Form(7),
    sharpen_amount: float = Form(1.35),
    blur_threshold: float = Form(85.0),
    use_adaptive_threshold: bool = Form(True),
):
    ext = Path(file.filename or "video.mp4").suffix.lower() or ".mp4"
    if ext not in {".mp4", ".mov", ".avi", ".mkv"}:
        raise HTTPException(
            status_code=415,
            detail="Formato não suportado. Envie .mp4, .mov ou .avi.",
        )

    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Arquivo de vídeo vazio.")

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    tmp.write(raw_bytes)
    tmp.close()

    cfg = VideoFilterConfig(
        clahe_clip_limit=clahe_clip_limit,
        gamma=gamma,
        denoise_strength=denoise_strength,
        sharpen_amount=sharpen_amount,
        blur_threshold=blur_threshold,
        use_adaptive_threshold=use_adaptive_threshold,
    )

    job_id = uuid.uuid4().hex
    VIDEO_JOBS[job_id] = VideoStatusResponse(job_id=job_id, status="processing")
    background_tasks.add_task(_run_video_job, job_id, tmp.name, cfg)

    return VideoJobSubmitResponse(
        job_id=job_id,
        status="processing",
        status_url=f"/api/v1/videos/status/{job_id}",
    )


@app.get("/api/v1/videos/status/{job_id}", response_model=VideoStatusResponse)
async def get_video_job_status(job_id: str):
    job = VIDEO_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job de vídeo não encontrado.")
    return job
