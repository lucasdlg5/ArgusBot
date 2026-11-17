from __future__ import annotations

from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field


class ReceiptDocumentType(str, Enum):
    NFCE = "nfce"
    NFCE_CONTINGENCY = "nfce_contingency"
    SAT = "sat"
    ORDER_SLIP = "order_slip"  # Ex.: PEDIDO Mercado Souza (sem QR/SEFAZ)
    UNKNOWN = "unknown"


class ImageQualityReport(BaseModel):
    part_index: int
    width: int
    height: int
    blur_score: float = Field(description="Variância do Laplaciano; menor = mais desfocado")
    is_blurry: bool = False
    detected_rotation_deg: int = Field(0, description="Correção global aplicada: 0, 90, 180, 270")
    deskew_angle_deg: float = 0.0
    cropped_document: bool = False
    contrast_recovered: bool = True
    warnings: List[str] = Field(default_factory=list)


class ReceiptHeader(BaseModel):
    store_name: str = ""
    cnpj: Optional[str] = None
    address: Optional[str] = None
    issued_at: Optional[str] = None
    order_or_nfce_number: Optional[str] = None
    document_type: ReceiptDocumentType = ReceiptDocumentType.UNKNOWN


class ReceiptItem(BaseModel):
    sequence_number: Optional[int] = None
    code: Optional[str] = None
    description: str
    quantity: float = 1.0
    unit: str = "UN"
    unit_price: float = 0.0
    total_price: float = 0.0
    confidence_warning: bool = False
    warning_reason: Optional[str] = None


class ReceiptTotals(BaseModel):
    items_count_declared: Optional[int] = None
    subtotal: float = 0.0
    discounts: float = 0.0
    total_paid: float = 0.0
    payment_methods: List[str] = Field(default_factory=list)
    sefaz_access_key: Optional[str] = Field(
        None, description="Chave de Acesso SEFAZ com 44 dígitos, quando presente"
    )
    qr_code_url: Optional[str] = None


class MathValidationReport(BaseModel):
    items_sum: float
    expected_total: float
    declared_total: float
    discrepancy_brl: float
    is_consistent: bool
    confidence_warning: bool = False
    suspect_items: List[str] = Field(default_factory=list)


class StitchSummary(BaseModel):
    parts_received: int
    ordered_indices: List[int]
    stitch_mode: str = Field(description="single | feature_overlap | sequential_fallback")
    overlaps_detected: int = 0
    deduplicated_items_count: int = 0


class ReceiptProcessResponse(BaseModel):
    status: str = "completed"
    job_id: Optional[str] = None
    quality_reports: List[ImageQualityReport]
    stitch_summary: StitchSummary
    header: ReceiptHeader
    items: List[ReceiptItem]
    totals: ReceiptTotals
    math_validation: MathValidationReport
    final_image_base64: Optional[str] = Field(
        None, description="Imagem unificada grayscale_clean em PNG base64"
    )
    final_binary_base64: Optional[str] = Field(
        None, description="Imagem unificada binarizada (Sauvola/Adaptive) em PNG base64"
    )
    final_image_url: Optional[str] = None
    raw_ocr_text: Optional[str] = None
