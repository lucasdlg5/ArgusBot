from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Argus Receipt Vision API"
    app_version: str = "1.0.0"

    # Gemini Multimodal (opcional: se ausente, usa parser determinístico + OCR local)
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"

    # Celery + Redis (opcional para processamento assíncrono em lote)
    celery_broker_url: str = "redis://localhost:6379/0"
    celery_result_backend: str = "redis://localhost:6379/1"
    use_async_queue: bool = False

    # Parâmetros do Pipeline OpenCV
    blur_laplacian_threshold: float = 75.0
    clahe_clip_limit: float = 2.5
    clahe_tile_grid_size: int = 8
    sauvola_window_size: int = 25
    sauvola_k: float = 0.2
    math_tolerance_brl: float = 0.05


settings = Settings()
