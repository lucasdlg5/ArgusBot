"""
Pipeline de Processamento de Imagem para Cupons Fiscais / NFC-e / Pedidos (OpenCV).

Camadas projetadas a partir da análise real de 14 cupons térmicos:
1. Detecção e Recorte do Papel + Transformação de Perspectiva (Four-Point Warp).
2. Correção de Orientação Global (0°/90°/180°/270° — ex.: cupons invertidos em 180°).
3. Deskew fino (±15°) via Transformada de Hough Probabilística.
4. Detecção de Desfoque (Laplaciano) + Unsharp Mask adaptativo.
5. Remoção de Sombras, Vincos e Transparência do Verso (Bleed-Through) via
   Dilatação Morfológica + Median Blur + Divisão Normalizada.
6. Recuperação de Tinta Térmica Desbotada via CLAHE.
7. Redução de Ruído preservando bordas (Non-Local Means Denoising).
8. Binarização Adaptativa (Sauvola / Adaptive Gaussian) gerando dupla saída:
   - `grayscale_clean`: ideal para LLMs multimodais (Gemini / GPT-4o-mini).
   - `binary`: preto no branco de alto contraste ideal para OCR clássico (PaddleOCR/Tesseract).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple
import cv2
import numpy as np

from app.config import settings
from app.schemas import ImageQualityReport

try:
    from skimage.filters import threshold_sauvola  # type: ignore
except Exception:
    threshold_sauvola = None

try:
    import pytesseract  # type: ignore
except Exception:
    pytesseract = None


@dataclass
class ProcessedReceiptImage:
    part_index: int
    grayscale_clean: np.ndarray
    binary: np.ndarray
    quality: ImageQualityReport


def _order_quad_points(pts: np.ndarray) -> np.ndarray:
    """Ordena 4 vértices no sentido: top-left, top-right, bottom-right, bottom-left."""
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1)
    rect[0] = pts[np.argmin(s)]      # top-left (menor x+y)
    rect[2] = pts[np.argmax(s)]      # bottom-right (maior x+y)
    rect[1] = pts[np.argmin(diff)]   # top-right (menor y-x)
    rect[3] = pts[np.argmax(diff)]   # bottom-left (maior y-x)
    return rect


def four_point_perspective_warp(image: np.ndarray) -> Tuple[np.ndarray, bool]:
    """
    Etapa 1: Detecção do contorno do papel térmico e Four-Point Perspective Transform.
    Remove o fundo (tecido, mesa, mão, balcão) deixando o cupom retangular.
    """
    h, w = image.shape[:2]
    img_area = float(h * w)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image.copy()

    # Suavização + Otsu/Canny para destacar a folha clara sobre fundo escuro ou texturizado
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Fecha pequenos rasgos ou vincos na borda do cupom
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (11, 11))
    closed = cv2.morphologyEx(otsu, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return image, False

    largest = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(largest)
    # Só recorta se o contorno representar entre 25% e 97% da foto (evita recortar texto interno)
    if area < img_area * 0.25 or area > img_area * 0.97:
        return image, False

    peri = cv2.arcLength(largest, True)
    approx = cv2.approxPolyDP(largest, 0.02 * peri, True)

    if len(approx) == 4:
        pts = approx.reshape(4, 2).astype("float32")
    else:
        # Fallback: retângulo mínimo rotacionado caso a borda esteja rasgada/curvada
        rect_box = cv2.minAreaRect(largest)
        pts = cv2.boxPoints(rect_box).astype("float32")

    ordered = _order_quad_points(pts)
    tl, tr, br, bl = ordered

    width_top = np.linalg.norm(tr - tl)
    width_bottom = np.linalg.norm(br - bl)
    max_width = int(max(width_top, width_bottom))

    height_left = np.linalg.norm(bl - tl)
    height_right = np.linalg.norm(br - tr)
    max_height = int(max(height_left, height_right))

    if max_width < 200 or max_height < 200:
        return image, False

    dst = np.array(
        [[0, 0], [max_width - 1, 0], [max_width - 1, max_height - 1], [0, max_height - 1]],
        dtype="float32",
    )
    matrix = cv2.getPerspectiveTransform(ordered, dst)
    warped = cv2.warpPerspective(
        image, matrix, (max_width, max_height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
    )
    return warped, True


def detect_and_fix_global_orientation(image: np.ndarray) -> Tuple[np.ndarray, int]:
    """
    Etapa 1.5 (Multi-camada): Detecta rotação macro (90°, 180°, 270°).
    Resolve cupons fotografados de cabeça para baixo (180°) ou deitados (90°/270°).
    """
    h, w = image.shape[:2]
    applied_deg = 0
    working = image

    # Cupons térmicos são verticais (altura > largura); se w > h * 1.15, gira 90°
    if w > h * 1.15:
        working = cv2.rotate(working, cv2.ROTATE_90_CLOCKWISE)
        applied_deg = 90

    # Tentativa 1: Tesseract OSD (quando disponível no ambiente)
    if pytesseract is not None:
        try:
            osd = pytesseract.image_to_osd(working)
            for line in osd.splitlines():
                if line.lower().startswith("rotate:"):
                    rot = int(line.split(":")[1].strip())
                    if rot == 180:
                        working = cv2.rotate(working, cv2.ROTATE_180)
                        applied_deg = (applied_deg + 180) % 360
                    elif rot == 90:
                        working = cv2.rotate(working, cv2.ROTATE_90_CLOCKWISE)
                        applied_deg = (applied_deg + 90) % 360
                    elif rot == 270:
                        working = cv2.rotate(working, cv2.ROTATE_90_COUNTERCLOCKWISE)
                        applied_deg = (applied_deg + 270) % 360
                    return working, applied_deg
        except Exception:
            pass

    # Tentativa 2 (heurística sem OCR): se houver QR Code no topo (y < 35%), a nota está de cabeça para baixo
    gray = cv2.cvtColor(working, cv2.COLOR_BGR2GRAY) if len(working.shape) == 3 else working
    detector = cv2.QRCodeDetector()
    ok, bbox = detector.detect(gray)
    if ok and bbox is not None and len(bbox) > 0:
        cy = float(np.mean(bbox[:, :, 1]))
        if cy < gray.shape[0] * 0.35:
            working = cv2.rotate(working, cv2.ROTATE_180)
            applied_deg = (applied_deg + 180) % 360

    return working, applied_deg


def deskew_image(gray: np.ndarray) -> Tuple[np.ndarray, float]:
    """
    Etapa 2: Correção de rotação fina (Deskew) usando Transformada de Hough Probabilística
    sobre linhas horizontais de texto / separadores pontilhados (=== / ---).
    """
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180.0,
        threshold=100,
        minLineLength=max(40, gray.shape[1] // 6),
        maxLineGap=15,
    )

    angles: List[float] = []
    if lines is not None:
        for line in lines[:, 0, :]:
            x1, y1, x2, y2 = line
            dx = float(x2 - x1)
            dy = float(y2 - y1)
            if abs(dx) < 1e-3:
                continue
            angle = np.degrees(np.arctan2(dy, dx))
            # Considera apenas linhas quase horizontais (±15°)
            if -15.0 <= angle <= 15.0:
                angles.append(angle)

    if not angles:
        return gray, 0.0

    median_angle = float(np.median(angles))
    if abs(median_angle) < 0.25:
        return gray, 0.0

    h, w = gray.shape[:2]
    center = (w / 2.0, h / 2.0)
    rot_mat = cv2.getRotationMatrix2D(center, median_angle, 1.0)
    rotated = cv2.warpAffine(
        gray, rot_mat, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
    )
    return rotated, round(median_angle, 2)


def remove_shadows_and_bleedthrough(gray: np.ndarray) -> np.ndarray:
    """
    Etapa 3b: Remoção de Sombras, Vincos e Marca d'Água do Verso (Bleed-Through).
    1. Aplica dilatação morfológica para apagar os caracteres escuros e manter apenas o papel.
    2. Aplica Median Blur para suavizar a estimativa do fundo iluminado.
    3. Divide a imagem original pelo fundo estimado (normalização de iluminação).
    """
    # Kernel proporcional à largura para não apagar letras largas de cabeçalho
    k = max(21, (min(gray.shape[:2]) // 35) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    dilated = cv2.dilate(gray, kernel)
    background = cv2.medianBlur(dilated, min(31, k if k % 2 == 1 else k + 1))

    # Divisão normalizada: fundo vira branco (~255), sombras/vincos e bleed-through suavizam
    normalized = cv2.divide(gray, background, scale=255)
    return normalized


def enhance_contrast_clahe(gray: np.ndarray) -> np.ndarray:
    """
    Etapa 3c: Aumento de Contraste Adaptativo (CLAHE) para recuperar tinta térmica desbotada.
    """
    clahe = cv2.createCLAHE(
        clipLimit=settings.clahe_clip_limit,
        tileGridSize=(settings.clahe_tile_grid_size, settings.clahe_tile_grid_size),
    )
    return clahe.apply(gray)


def denoise_preserving_edges(gray: np.ndarray, blur_score: float) -> np.ndarray:
    """
    Etapa 3d: Redução de ruído com Non-Local Means Denoising preservando contornos de dígitos.
    Se a imagem tiver desfoque (blur_score baixo), aplica Unsharp Mask leve antes.
    """
    working = gray
    if blur_score < settings.blur_laplacian_threshold:
        gaussian = cv2.GaussianBlur(working, (0, 0), sigmaX=1.5)
        working = cv2.addWeighted(working, 1.45, gaussian, -0.45, 0)

    return cv2.fastNlMeansDenoising(working, None, h=7, templateWindowSize=7, searchWindowSize=21)


def binarize_receipt(gray_clean: np.ndarray) -> np.ndarray:
    """
    Etapa 3e: Binarização Adaptativa (Sauvola preferencial; Adaptive Gaussian como fallback).
    Gera imagem preto-no-branco de alto contraste ideal para Tesseract / PaddleOCR.
    """
    if threshold_sauvola is not None:
        win = settings.sauvola_window_size | 1
        thresh = threshold_sauvola(gray_clean, window_size=win, k=settings.sauvola_k)
        binary = (gray_clean > thresh).astype(np.uint8) * 255
        return binary

    return cv2.adaptiveThreshold(
        gray_clean,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        blockSize=25,
        C=11,
    )


def run_image_pipeline(image_bytes: bytes, part_index: int = 0) -> ProcessedReceiptImage:
    """Executa todas as etapas obrigatórias do pipeline OpenCV em uma imagem recebida."""
    np_buf = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(np_buf, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"Não foi possível decodificar a imagem da parte {part_index}.")

    warnings: List[str] = []

    # 1. Recorte do documento e transformação de perspectiva (Four-Point Warp)
    warped, cropped = four_point_perspective_warp(bgr)

    # 2. Correção de orientação macro (0°/90°/180°/270°)
    oriented, rot_deg = detect_and_fix_global_orientation(warped)
    if rot_deg != 0:
        warnings.append(f"Orientação corrigida automaticamente em {rot_deg}°.")

    # 3a. Conversão para escala de cinza
    gray = cv2.cvtColor(oriented, cv2.COLOR_BGR2GRAY) if len(oriented.shape) == 3 else oriented

    # Avaliação objetiva de nitidez (Variância do Laplaciano)
    blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    is_blurry = blur_score < settings.blur_laplacian_threshold
    if is_blurry:
        warnings.append(
            f"Desfoque moderado/alto detectado (Laplacian={blur_score:.1f} < {settings.blur_laplacian_threshold}). Aplicado Unsharp Mask."
        )

    # 2b. Correção de inclinação fina (Deskew)
    deskewed, deskew_angle = deskew_image(gray)

    # 3b. Remoção de sombras, vincos e bleed-through
    illum_norm = remove_shadows_and_bleedthrough(deskewed)

    # 3c. CLAHE para texto térmico desbotado
    contrasted = enhance_contrast_clahe(illum_norm)

    # 3d. Denoising preservando bordas (versão grayscale limpa para LLMs multimodais)
    grayscale_clean = denoise_preserving_edges(contrasted, blur_score)

    # 3e. Binarização Sauvola / Adaptive Gaussian (versão de alto contraste para OCR)
    binary = binarize_receipt(grayscale_clean)

    h, w = grayscale_clean.shape[:2]
    quality = ImageQualityReport(
        part_index=part_index,
        width=w,
        height=h,
        blur_score=round(blur_score, 2),
        is_blurry=is_blurry,
        detected_rotation_deg=rot_deg,
        deskew_angle_deg=deskew_angle,
        cropped_document=cropped,
        contrast_recovered=True,
        warnings=warnings,
    )
    return ProcessedReceiptImage(
        part_index=part_index,
        grayscale_clean=grayscale_clean,
        binary=binary,
        quality=quality,
    )
