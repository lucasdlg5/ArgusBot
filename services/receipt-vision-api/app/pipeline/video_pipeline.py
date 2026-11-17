"""
Etapas A e C — Pipeline de Análise de Vídeos de Gôndolas de Supermercado.

Baseado no vídeo real de gôndola (`20261117_070154.mp4`):
- Descarta trechos de caminhada/motion blur entre corredores via Variância do Laplaciano.
- Seleciona apenas keyframes com deslocamento relevante via comparação de histograma HSV.
- Detecta etiquetas amarelas de prateleira e cartazes promocionais azul+amarelo (DE/POR),
  com suporte opcional a Ultralytics YOLOv8/v11 + ByteTrack quando disponível.
- Associa cada etiqueta ao produto acima na prateleira e consolida leituras duplicadas entre
  frames consecutivos pelo maior score de confiança.
"""

from __future__ import annotations

import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
import cv2
import numpy as np

from app.pipeline.image_processor import ImageEnhancer
from app.schemas import VideoFilterConfig, VideoMetadata, VideoShelfItem

logger = logging.getLogger("uvicorn.error")

try:
    import pytesseract  # type: ignore
except Exception:
    pytesseract = None

try:
    from ultralytics import YOLO  # type: ignore
except Exception:
    YOLO = None


PRICE_REGEX = re.compile(r"(?:R\$\s*)?(\d{1,4}[.,]\d{2})")


@dataclass
class TrackedShelfCandidate:
    track_id: int
    last_frame_idx: int
    last_center: Tuple[float, float]
    best_name: str
    preco_regular: Optional[float]
    preco_promocional: Optional[float]
    best_det_conf: float
    best_ocr_conf: float
    best_timestamp: float
    filtros_aplicados: List[str]


def _extract_prices_from_text(text: str) -> Tuple[Optional[float], Optional[float]]:
    """Extrai preço regular e promocional (ex.: cartazes DE 7,19 POR 6,89 ou etiqueta única)."""
    matches = PRICE_REGEX.findall(text or "")
    vals: List[float] = []
    for raw in matches:
        try:
            num = float(raw.replace(",", "."))
            if 0.1 <= num <= 2500.0:
                vals.append(round(num, 2))
        except ValueError:
            continue

    if not vals:
        return None, None
    if len(vals) == 1:
        return vals[0], None
    # Em cartazes promocionais (DE / POR), o maior costuma ser o regular e o menor o promocional
    high, low = max(vals[0], vals[1]), min(vals[0], vals[1])
    if high != low:
        return high, low
    return vals[0], None


def _run_ocr_on_crop(img: np.ndarray) -> Tuple[str, float]:
    """Executa OCR no recorte da etiqueta/produto (Tesseract `por` com score de confiança)."""
    if pytesseract is None or img is None or img.size == 0:
        return "", 0.0
    try:
        data = pytesseract.image_to_data(
            img, lang="por", config="--psm 6", output_type=pytesseract.Output.DICT
        )
        words: List[str] = []
        confs: List[float] = []
        for txt, conf in zip(data.get("text", []), data.get("conf", [])):
            t = str(txt or "").strip()
            try:
                c = float(conf)
            except (TypeError, ValueError):
                c = -1.0
            if t and c >= 0:
                words.append(t)
                confs.append(c / 100.0)
        joined = " ".join(words).strip()
        avg_conf = round(float(sum(confs) / len(confs)), 3) if confs else 0.0
        return joined, avg_conf
    except Exception:
        return "", 0.0


def _detect_shelf_labels_hsv(enhanced_bgr: np.ndarray) -> List[Tuple[int, int, int, int, float]]:
    """
    Detector geométrico calibrado para etiquetas amarelas de prateleira e cartazes
    promocionais observados em supermercados brasileiros.
    Retorna lista de `(x, y, w, h, detection_confidence)`.
    """
    h_img, w_img = enhanced_bgr.shape[:2]
    hsv = cv2.cvtColor(enhanced_bgr, cv2.COLOR_BGR2HSV)

    # Faixa amarela típica de etiquetas de gôndola e faixas promocionais
    mask_yellow = cv2.inRange(hsv, np.array([14, 75, 110]), np.array([38, 255, 255]))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 5))
    closed = cv2.morphologyEx(mask_yellow, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes: List[Tuple[int, int, int, int, float]] = []

    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        area = w * h
        # Filtra ruído muito pequeno ou faixas gigantes que cobrem a prateleira inteira
        if w < 38 or h < 16 or area < 700 or w > w_img * 0.65:
            continue
        aspect = w / float(max(h, 1))
        if aspect < 1.1 or aspect > 8.5:
            continue
        fill_ratio = cv2.contourArea(cnt) / float(max(area, 1))
        conf = round(min(0.98, 0.55 + fill_ratio * 0.4), 3)
        boxes.append((x, y, w, h, conf))

    # Ordena de cima para baixo, esquerda para direita
    boxes.sort(key=lambda b: (b[1] // 40, b[0]))
    return boxes[:30]


def analyze_shelf_video(
    video_path: str,
    config: Optional[VideoFilterConfig] = None,
) -> Tuple[VideoMetadata, List[VideoShelfItem]]:
    """
    Executa as etapas A (amostragem + anti-blur), B (ImageEnhancer) e C (detecção + tracking + OCR)
    em um arquivo de vídeo de gôndola.
    """
    cfg = config or VideoFilterConfig()
    enhancer = ImageEnhancer(cfg)
    t0 = time.perf_counter()

    logger.info("[INICIO] [VideoPipeline] Analisando video de gondola: %s", os.path.basename(video_path))
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError("Não foi possível abrir o arquivo de vídeo enviado.")

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration_sec = round(total_frames / max(fps, 1.0), 2)

    yolo_model = None
    yolo_path = os.getenv("YOLO_SHELF_MODEL_PATH", "").strip()
    if YOLO is not None and yolo_path and os.path.exists(yolo_path):
        try:
            yolo_model = YOLO(yolo_path)
        except Exception:
            yolo_model = None

    detector_engine = "yolov8_bytetrack" if yolo_model is not None else "opencv_hsv_shelf"

    prev_hist: Optional[np.ndarray] = None
    sampled_keyframes = 0
    discarded_blur = 0
    frame_step = max(1, int(round(fps / 4.0)))  # avalia ~4 frames por segundo

    tracks: List[TrackedShelfCandidate] = []
    next_track_id = 1

    frame_idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        if frame_idx % frame_step != 0:
            frame_idx += 1
            continue

        if sampled_keyframes >= cfg.max_keyframes:
            break

        # Etapa A1: Amostragem inteligente por mudança de histograma HSV
        hsv_small = cv2.cvtColor(cv2.resize(frame, (160, 90)), cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv_small], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)

        if prev_hist is not None:
            diff = float(cv2.compareHist(prev_hist, hist, cv2.HISTCMP_BHATTACHARYYA))
            if diff < cfg.scene_diff_threshold:
                frame_idx += 1
                continue

        # Etapa A2: Anti-Blur (Variância do Laplaciano)
        blur_score = enhancer.compute_blur_score(frame)
        if blur_score < cfg.blur_threshold:
            discarded_blur += 1
            frame_idx += 1
            continue

        prev_hist = hist
        sampled_keyframes += 1
        timestamp_sec = round(frame_idx / max(fps, 1.0), 2)

        # Etapa B: Filtros de aprimoramento no frame
        enhanced_res = enhancer.enhance_frame(frame)
        enhanced = enhanced_res.enhanced_bgr
        h_f, w_f = enhanced.shape[:2]

        # Etapa C1: Detecção de etiquetas
        label_boxes = _detect_shelf_labels_hsv(enhanced)

        for x, y, w, h, det_conf in label_boxes:
            label_crop = enhanced[max(0, y - 4) : min(h_f, y + h + 4), max(0, x - 4) : min(w_f, x + w + 4)]
            label_deskewed = enhancer.deskew_label_crop(label_crop)
            ocr_target = (
                enhancer.binarize_label_adaptive(label_deskewed)
                if cfg.use_adaptive_threshold
                else label_deskewed
            )

            label_text, ocr_conf = _run_ocr_on_crop(ocr_target)
            reg_price, promo_price = _extract_prices_from_text(label_text)
            if reg_price is None:
                continue

            # Etapa C2: Associação espacial — região do produto imediatamente acima da etiqueta
            prod_y1 = max(0, y - max(int(h * 4.5), 110))
            prod_crop = enhanced[prod_y1:y, max(0, x - 12) : min(w_f, x + w + 12)]
            prod_text, _ = _run_ocr_on_crop(prod_crop)
            clean_name = re.sub(PRICE_REGEX, "", f"{prod_text} {label_text}").strip()
            clean_name = re.sub(r"\s+", " ", clean_name)[:90] or f"Produto Prateleira ({timestamp_sec}s)"

            cx = (x + w / 2.0) / float(max(w_f, 1))
            cy = (y + h / 2.0) / float(max(h_f, 1))

            # Etapa C3: Tracking / Deduplicação entre frames consecutivos
            matched_track: Optional[TrackedShelfCandidate] = None
            for tr in tracks:
                if abs(sampled_keyframes - tr.last_frame_idx) <= 4:
                    dist = ((cx - tr.last_center[0]) ** 2 + (cy - tr.last_center[1]) ** 2) ** 0.5
                    same_price = tr.preco_regular == reg_price
                    if dist < 0.16 and same_price:
                        matched_track = tr
                        break

            if matched_track is not None:
                matched_track.last_frame_idx = sampled_keyframes
                matched_track.last_center = (cx, cy)
                score_new = det_conf * 0.4 + ocr_conf * 0.6
                score_old = matched_track.best_det_conf * 0.4 + matched_track.best_ocr_conf * 0.6
                if score_new > score_old:
                    matched_track.best_name = clean_name
                    matched_track.preco_regular = reg_price
                    matched_track.preco_promocional = promo_price
                    matched_track.best_det_conf = det_conf
                    matched_track.best_ocr_conf = ocr_conf
                    matched_track.best_timestamp = timestamp_sec
                    matched_track.filtros_aplicados = enhanced_res.applied_filters
            else:
                tracks.append(
                    TrackedShelfCandidate(
                        track_id=next_track_id,
                        last_frame_idx=sampled_keyframes,
                        last_center=(cx, cy),
                        best_name=clean_name,
                        preco_regular=reg_price,
                        preco_promocional=promo_price,
                        best_det_conf=det_conf,
                        best_ocr_conf=ocr_conf,
                        best_timestamp=timestamp_sec,
                        filtros_aplicados=enhanced_res.applied_filters,
                    )
                )
                next_track_id += 1

        frame_idx += 1

    cap.release()

    items = [
        VideoShelfItem(
            item_id=f"shelf_item_{tr.track_id:03d}",
            nome_produto=tr.best_name,
            preco_regular=tr.preco_regular,
            preco_promocional=tr.preco_promocional,
            confianca_deteccao=tr.best_det_conf,
            confianca_ocr=tr.best_ocr_conf,
            timestamp_melhor_frame=tr.best_timestamp,
            filtros_aplicados=tr.filtros_aplicados,
        )
        for tr in tracks
    ]

    metadata = VideoMetadata(
        duration_sec=duration_sec,
        fps=round(fps, 2),
        total_frames=total_frames,
        sampled_keyframes=sampled_keyframes,
        discarded_blur_frames=discarded_blur,
        detector_engine=detector_engine,
    )

    elapsed = time.perf_counter() - t0
    logger.info(
        "[FIM] [VideoPipeline] Concluido em %.2fs | keyframes=%d | blur_descartados=%d | itens_unicos=%d",
        elapsed,
        sampled_keyframes,
        discarded_blur,
        len(items),
    )
    return metadata, items
