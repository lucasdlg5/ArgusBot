"""
Etapa B — Pipeline de Filtros e Aprimoramento de Legibilidade para Gôndolas (Pré-OCR).

Classe modular `ImageEnhancer` calibrada com base em vídeos reais de corredor de supermercado:
1. CLAHE no canal L (espaço LAB) -> neutraliza reflexos fluorescentes em garrafas PET/vidro e sombras de prateleira.
2. Correção Gama dinâmica -> compensa corredores escuros ou trechos superexpostos.
3. Redução de ruído preservando bordas (Bilateral Filter / NLM).
4. Unsharp Masking -> realça dígitos pequenos em etiquetas amarelas e cartazes promocionais.
5. Correção de Perspectiva (Deskewing) em recortes de etiquetas inclinadas.
6. Binarização Adaptativa Gaussiana opcional para o recorte final de OCR.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple
import cv2
import numpy as np

from app.schemas import VideoFilterConfig


@dataclass
class EnhancedFrameResult:
    enhanced_bgr: np.ndarray
    applied_filters: List[str]
    blur_score: float


class ImageEnhancer:
    def __init__(self, config: VideoFilterConfig | None = None) -> None:
        self.config = config or VideoFilterConfig()

    @staticmethod
    def compute_blur_score(image_bgr: np.ndarray) -> float:
        """Calcula a Variância do Laplaciano (quanto menor, maior o motion blur)."""
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())

    def apply_clahe_lab(self, bgr: np.ndarray) -> np.ndarray:
        """Aplica CLAHE apenas no canal L (luminosidade) do espaço LAB para preservar cores das etiquetas."""
        lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
        l_ch, a_ch, b_ch = cv2.split(lab)
        clahe = cv2.createCLAHE(
            clipLimit=self.config.clahe_clip_limit,
            tileGridSize=(self.config.clahe_grid_size, self.config.clahe_grid_size),
        )
        l_eq = clahe.apply(l_ch)
        merged = cv2.merge((l_eq, a_ch, b_ch))
        return cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)

    def apply_dynamic_gamma(self, bgr: np.ndarray) -> Tuple[np.ndarray, float]:
        """Ajusta gama automaticamente pela luminância média (alvo ~128) ou usa valor fixo."""
        if self.config.gamma is not None:
            gamma = self.config.gamma
        else:
            gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            mean_val = float(np.mean(gray))
            if 105.0 <= mean_val <= 155.0:
                return bgr, 1.0
            # Clampa entre 0.7 (clarear) e 1.45 (reduzir superexposição)
            gamma = float(np.clip(np.log(0.5) / np.log(max(mean_val, 15.0) / 255.0), 0.7, 1.45))

        inv_gamma = 1.0 / max(gamma, 0.1)
        lut = np.array([((i / 255.0) ** inv_gamma) * 255 for i in range(256)], dtype=np.uint8)
        return cv2.LUT(bgr, lut), round(gamma, 2)

    def apply_edge_preserving_denoise(self, bgr: np.ndarray) -> np.ndarray:
        """Bilateral Filter remove granulação de câmera mantendo bordas nítidas de números."""
        d = 5 if self.config.denoise_strength <= 8 else 7
        sigma = float(self.config.denoise_strength * 5)
        return cv2.bilateralFilter(bgr, d=d, sigmaColor=sigma, sigmaSpace=sigma)

    def apply_unsharp_mask(self, bgr: np.ndarray) -> np.ndarray:
        """Unsharp Masking realça fontes pequenas de etiquetas (ex.: R$ 12,99)."""
        if self.config.sharpen_amount <= 0.05:
            return bgr
        blurred = cv2.GaussianBlur(bgr, (0, 0), sigmaX=1.2)
        alpha = 1.0 + (self.config.sharpen_amount * 0.45)
        beta = -(self.config.sharpen_amount * 0.45)
        return cv2.addWeighted(bgr, alpha, blurred, beta, 0)

    def deskew_label_crop(self, crop_bgr: np.ndarray) -> np.ndarray:
        """Detecta o contorno retangular da etiqueta e corrige inclinação antes do OCR."""
        if crop_bgr.size == 0 or min(crop_bgr.shape[:2]) < 20:
            return crop_bgr

        gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 40, 140)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return crop_bgr

        largest = max(contours, key=cv2.contourArea)
        if cv2.contourArea(largest) < crop_bgr.shape[0] * crop_bgr.shape[1] * 0.25:
            return crop_bgr

        rect = cv2.minAreaRect(largest)
        angle = rect[2]
        if angle < -45:
            angle += 90
        elif angle > 45:
            angle -= 90

        if abs(angle) < 1.0 or abs(angle) > 20.0:
            return crop_bgr

        h, w = crop_bgr.shape[:2]
        mat = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle, 1.0)
        return cv2.warpAffine(crop_bgr, mat, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)

    def binarize_label_adaptive(self, crop_bgr: np.ndarray) -> np.ndarray:
        """Binarização Adaptativa Gaussiana específica para dígitos pequenos no recorte da etiqueta."""
        gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
        upscaled = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
        return cv2.adaptiveThreshold(
            upscaled,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            blockSize=21,
            C=9,
        )

    def enhance_frame(self, frame_bgr: np.ndarray) -> EnhancedFrameResult:
        """Executa a cadeia de aprimoramento no frame inteiro."""
        applied: List[str] = []
        blur_score = self.compute_blur_score(frame_bgr)

        working, gamma_used = self.apply_dynamic_gamma(frame_bgr)
        if gamma_used != 1.0:
            applied.append(f"gamma({gamma_used})")

        working = self.apply_clahe_lab(working)
        applied.append(f"clahe_lab(clip={self.config.clahe_clip_limit})")

        working = self.apply_edge_preserving_denoise(working)
        applied.append(f"bilateral(str={self.config.denoise_strength})")

        working = self.apply_unsharp_mask(working)
        if self.config.sharpen_amount > 0.05:
            applied.append(f"unsharp({self.config.sharpen_amount})")

        return EnhancedFrameResult(
            enhanced_bgr=working,
            applied_filters=applied,
            blur_score=round(blur_score, 2),
        )
