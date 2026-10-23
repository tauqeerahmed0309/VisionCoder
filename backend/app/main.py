from __future__ import annotations

import logging
import re
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.errors import (
    APIError,
    InvalidModelOutputError,
    ModelConfigurationError,
    ModelProviderError,
    ModelTimeoutError,
    ServerBusyError,
)
from app.generation import generate_page
from app.image_validation import validate_image_bytes
from app.reliability import breaker, rate_limiter, request_id_var

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s [%(request_id)s]: %(message)s")


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True


for _handler in logging.getLogger().handlers:
    _handler.addFilter(_RequestIdFilter())
logger = logging.getLogger("visioncoder.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.info(
        "Starting: model=%s mock=%s key=%s concurrency=%d rate_limit=%d/min",
        settings.gemma_model, settings.mock_model, "set" if settings.gemini_api_key else "MISSING",
        settings.max_concurrent_requests, settings.rate_limit_per_minute,
    )
    if not settings.mock_model and not settings.gemini_api_key:
        logger.warning("MOCK_MODEL is false but GEMINI_API_KEY is empty: every generation will fail. Run `python check_model.py`.")
    yield


app = FastAPI(title="Visioncoder API", version="1.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Request-ID"],
    expose_headers=["X-Request-ID", "Retry-After"],
)

_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


@app.middleware("http")
async def request_context(request: Request, call_next):
    supplied = request.headers.get("x-request-id", "")
    request_id = supplied if _SAFE_REQUEST_ID.match(supplied) else uuid.uuid4().hex[:12]
    token = request_id_var.set(request_id)
    started = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        response.headers["X-Request-ID"] = request_id
        return response
    finally:
        if request.url.path != "/health":
            logger.info("%s %s -> %s in %.0f ms", request.method, request.url.path, status, (time.perf_counter() - started) * 1000)
        request_id_var.reset(token)


@app.exception_handler(APIError)
async def api_error_handler(_: Request, exc: APIError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message, "requestId": request_id_var.get()}},
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def request_validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    # Avoid exposing internal validation details. The frontend receives a stable format.
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "VALIDATION_ERROR", "message": "Check the request fields and try again.", "requestId": request_id_var.get()}},
    )


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "model": settings.gemma_model,
        "mockMode": settings.mock_model,
        "modelConfigured": bool(settings.gemini_api_key) or settings.mock_model,
        "breaker": breaker.state,
    }


@app.get("/ready")
async def ready() -> JSONResponse:
    """Readiness: can this instance serve generations right now?"""
    problems: list[str] = []
    if not settings.mock_model and not settings.gemini_api_key:
        problems.append("GEMINI_API_KEY is not set")
    if breaker.state == "open":
        problems.append(f"model calls are paused after repeated failures (retry in {breaker.retry_after()}s)")
    return JSONResponse(status_code=503 if problems else 200, content={"ready": not problems, "problems": problems})


@app.post("/api/generate")
async def generate(
    request: Request,
    image: UploadFile = File(...),
    prompt: str = Form(default="", max_length=5000),
) -> dict:
    wait = rate_limiter.check(request.client.host if request.client else "unknown")
    if wait:
        raise APIError(429, "RATE_LIMITED", f"Too many requests. Try again in {wait} seconds.", headers={"Retry-After": str(wait)})

    image_bytes = await image.read(settings.max_image_bytes + 1)
    if len(image_bytes) > settings.max_image_bytes:
        raise APIError(413, "IMAGE_TOO_LARGE", f"Image must be {settings.max_image_bytes // (1024 * 1024)} MB or smaller.")

    mime_type = validate_image_bytes(image_bytes, image.content_type or "")
    try:
        return await generate_page(image_bytes, mime_type, prompt)
    except ModelConfigurationError:
        raise APIError(503, "MODEL_ERROR", "Gemma is not configured. Add GEMINI_API_KEY to backend/.env or enable MOCK_MODEL for local testing.") from None
    except ModelTimeoutError:
        raise APIError(504, "MODEL_TIMEOUT", "The model took too long to respond. Please retry.") from None
    except ServerBusyError:
        raise APIError(503, "BUSY", "The server is busy generating other pages. Try again in a few seconds.", headers={"Retry-After": "5"}) from None
    except ModelProviderError as exc:
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
        raise APIError(exc.http_status, exc.code, exc.public_message, headers=headers) from None
    except InvalidModelOutputError:
        raise APIError(502, "INVALID_MODEL_OUTPUT", "The model response could not be converted into a valid page. Try a clearer sketch.") from None
    except Exception:  # noqa: BLE001
        # Handle here (not in a global handler) so the JSON reply still passes
        # through the CORS middleware; otherwise the browser reports a CORS error
        # and hides the real problem.
        logger.exception("Unexpected error while generating a page")
        raise APIError(500, "INTERNAL_ERROR", "Something went wrong on the server. Check the backend log.") from None
