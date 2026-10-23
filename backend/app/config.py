from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Load backend/.env regardless of the shell's current working directory.
BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _number(name: str, default: float, minimum: float, cast=int):
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = cast(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a number") from exc
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}")
    return value


@dataclass
class Settings:
    gemini_api_key: str | None
    gemma_model: str
    mock_model: bool
    cors_origins: list[str]
    max_image_bytes: int
    model_timeout_seconds: int
    # Reliability controls (all optional; defaults suit a single small server).
    total_timeout_seconds: int = 110       # whole request budget, incl. retries
    max_concurrent_requests: int = 3       # simultaneous Gemini calls
    queue_timeout_seconds: float = 20.0    # how long a request may wait for a slot
    rate_limit_per_minute: int = 20        # per client IP; 0 disables
    cache_size: int = 32                   # finished pages kept; 0 disables
    cache_ttl_seconds: int = 600
    breaker_threshold: int = 5             # consecutive provider failures before fail-fast
    breaker_cooldown_seconds: int = 30
    max_image_dimension: int = 1600        # larger sketches are downscaled before upload


def load_settings() -> Settings:
    origins = os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173",
    )
    try:
        max_image_mb = int(os.getenv("MAX_IMAGE_MB", "8"))
        timeout_seconds = int(os.getenv("MODEL_TIMEOUT_SECONDS", "60"))
    except ValueError as exc:
        raise RuntimeError("MAX_IMAGE_MB and MODEL_TIMEOUT_SECONDS must be integers") from exc

    if max_image_mb < 1 or timeout_seconds < 1:
        raise RuntimeError("MAX_IMAGE_MB and MODEL_TIMEOUT_SECONDS must be positive")

    api_key = os.getenv("GEMINI_API_KEY", "").strip() or None
    return Settings(
        gemini_api_key=api_key,
        gemma_model=os.getenv("GEMMA_MODEL", "gemma-4-26b-a4b-it").strip(),
        mock_model=_as_bool(os.getenv("MOCK_MODEL"), default=True),
        cors_origins=[origin.strip() for origin in origins.split(",") if origin.strip()],
        max_image_bytes=max_image_mb * 1024 * 1024,
        model_timeout_seconds=timeout_seconds,
        total_timeout_seconds=_number("TOTAL_TIMEOUT_SECONDS", 110, 10),
        max_concurrent_requests=_number("MAX_CONCURRENT_REQUESTS", 3, 1),
        queue_timeout_seconds=_number("QUEUE_TIMEOUT_SECONDS", 20.0, 0.0, float),
        rate_limit_per_minute=_number("RATE_LIMIT_PER_MINUTE", 20, 0),
        cache_size=_number("CACHE_SIZE", 32, 0),
        cache_ttl_seconds=_number("CACHE_TTL_SECONDS", 600, 1),
        breaker_threshold=_number("BREAKER_THRESHOLD", 5, 1),
        breaker_cooldown_seconds=_number("BREAKER_COOLDOWN_SECONDS", 30, 1),
        max_image_dimension=_number("MAX_IMAGE_DIMENSION", 1600, 256),
    )


settings = load_settings()
