from __future__ import annotations

import asyncio
import json
import logging
import math
import random
import time

from app.config import settings
from app.errors import ModelConfigurationError, ModelProviderError, ModelTimeoutError
from app.prompt_templates import SYSTEM_PROMPT, make_user_prompt
from app.reliability import breaker

logger = logging.getLogger("visioncoder.model")

# Up to three tries for transient failures (rate-limit blips, 5xx, dropped
# connections) with exponential backoff + jitter, all inside one shared deadline.
MAX_ATTEMPTS = 3
RETRY_BASE_DELAY_SECONDS = 1.5
RETRY_MAX_DELAY_SECONDS = 8.0
MAX_RETRY_AFTER_SECONDS = 10  # a longer server-requested wait is reported, not slept through
MIN_USEFUL_ATTEMPT_SECONDS = 5
# Gemma 4 can "think" before answering and thinking tokens count against the
# output limit, which truncates the JSON. We want a direct answer.
MAX_OUTPUT_TOKENS = 8192


def _mock_page() -> str:
    """Deterministic response for integration testing; it does not inspect the image."""
    page = {
        "schemaVersion": "1.0",
        "pageTitle": "Campus Event",
        "themeHint": "professional",
        "components": [
            {
                "id": "navbar-1",
                "type": "navbar",
                "props": {"brand": "CampusFest", "links": ["Home", "Events", "Contact"]},
            },
            {
                "id": "hero-1",
                "type": "hero",
                "props": {
                    "heading": "Build Something Great",
                    "body": "Join our campus event.",
                    "buttonLabel": "Get Started",
                    "alignment": "center",
                },
            },
            {
                "id": "grid-1",
                "type": "cardGrid",
                "props": {
                    "cards": [
                        {"id": "card-1", "title": "Learn", "body": "Explore new skills."},
                        {"id": "card-2", "title": "Build", "body": "Create a prototype."},
                        {"id": "card-3", "title": "Share", "body": "Show your work."},
                    ]
                },
            },
            {
                "id": "footer-1",
                "type": "footer",
                "props": {"text": "Built with Visioncoder", "links": []},
            },
        ],
        "detectedElements": [
            {"label": "Top navigation bar", "componentId": "navbar-1"},
            {"label": "Large heading and call-to-action", "componentId": "hero-1"},
            {"label": "Three content cards", "componentId": "grid-1"},
        ],
        "uncertainties": ["Mock mode is enabled: this is sample output and does not reflect the uploaded image."],
    }
    return json.dumps(page)


def _redact(text: str) -> str:
    key = settings.gemini_api_key
    return text.replace(key, "[REDACTED]") if key else text


def classify_provider_error(exc: Exception) -> ModelProviderError:
    """Turn an SDK/network exception into a ModelProviderError with a helpful public message.

    The full original error is logged server-side so the real cause is never hidden.
    """
    code = getattr(exc, "code", None)
    status = str(getattr(exc, "status", "") or "")
    detail = _redact(f"{type(exc).__name__}: {exc}")
    lowered = detail.lower()

    if code in (401, 403) or "api key" in lowered or "api_key" in lowered or status in {"UNAUTHENTICATED", "PERMISSION_DENIED"}:
        result = ModelProviderError(
            detail,
            http_status=503,
            public_message="Gemini rejected the API key. Check GEMINI_API_KEY in backend/.env (no quotes or spaces), confirm it is enabled in Google AI Studio, then restart the backend.",
        )
    elif code == 404 or status == "NOT_FOUND":
        result = ModelProviderError(
            detail,
            http_status=503,
            public_message=f"The model '{settings.gemma_model}' was not found for this API key. Check GEMMA_MODEL in backend/.env.",
        )
    elif code == 429 or status == "RESOURCE_EXHAUSTED":
        result = ModelProviderError(
            detail,
            retryable=True,
            http_status=429,
            code="RATE_LIMITED",
            public_message="The Gemini quota or rate limit was reached. Wait a minute and try again, or check your plan and quota in Google AI Studio.",
        )
    elif isinstance(code, int) and code >= 500:
        result = ModelProviderError(
            detail,
            retryable=True,
            http_status=502,
            public_message="The Gemini service is temporarily unavailable. Please try again in a moment.",
        )
    elif isinstance(code, int) and 400 <= code < 500:
        result = ModelProviderError(
            detail,
            http_status=502,
            public_message="Gemini rejected the request. Check the server log for the exact reason (run `python check_model.py` to diagnose).",
        )
    elif "timeout" in lowered or "timed out" in lowered:
        result = ModelProviderError(
            detail,
            retryable=True,
            http_status=504,
            code="MODEL_TIMEOUT",
            public_message="The model took too long to respond. Please retry.",
        )
    else:
        # No HTTP status: usually a network problem (DNS, proxy, firewall, offline).
        result = ModelProviderError(
            detail,
            retryable=True,
            http_status=502,
            public_message="Could not reach the Gemini API from the backend. Check the server's internet connection, proxy or firewall.",
        )
    return result


def _build_config(types, *, with_thinking_control: bool, timeout_seconds: float | None = None):
    timeout = timeout_seconds if timeout_seconds is not None else settings.model_timeout_seconds
    kwargs = dict(
        system_instruction=SYSTEM_PROMPT,
        temperature=0.2,
        max_output_tokens=MAX_OUTPUT_TOKENS,
        http_options=types.HttpOptions(timeout=max(1, int(timeout * 1000))),
    )
    if with_thinking_control:
        kwargs["thinking_config"] = types.ThinkingConfig(thinking_level=types.ThinkingLevel.MINIMAL)
    return types.GenerateContentConfig(**kwargs)


def _extract_text(response) -> str:
    text = response.text
    if text and text.strip():
        return text

    feedback = getattr(response, "prompt_feedback", None)
    block_reason = getattr(feedback, "block_reason", None)
    finish_reason = None
    candidates = getattr(response, "candidates", None) or []
    if candidates:
        finish_reason = getattr(candidates[0], "finish_reason", None)
    logger.error("Empty model response (block_reason=%s, finish_reason=%s)", block_reason, finish_reason)

    if block_reason or str(finish_reason or "").endswith(("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII")):
        raise ModelProviderError(
            "Response blocked by safety filters.",
            http_status=422,
            public_message="The model declined to process this image. Try a different sketch.",
        )
    raise ModelProviderError(
        "The model returned an empty response.",
        public_message="The model returned an empty response. Please try again or use a clearer sketch.",
    )


def _retry_after_seconds(exc: Exception) -> float | None:
    """Seconds the provider asked us to wait (Retry-After header), if any."""
    try:
        headers = exc.response.headers  # type: ignore[attr-defined]
        value = headers.get("retry-after") if headers else None
        return float(value) if value is not None else None
    except Exception:  # noqa: BLE001
        return None


def _backoff_delay(attempt: int, retry_after: float | None) -> float:
    delay = min(RETRY_MAX_DELAY_SECONDS, RETRY_BASE_DELAY_SECONDS * 2 ** (attempt - 1)) + random.uniform(0, 0.5)
    return max(delay, retry_after) if retry_after else delay


def _call_gemma(image_bytes: bytes, mime_type: str, prompt: str, deadline: float | None = None, correction: str = "") -> str:
    if not settings.gemini_api_key:
        raise ModelConfigurationError("GEMINI_API_KEY is not configured.")

    from google import genai
    from google.genai import types

    if deadline is None:
        deadline = time.monotonic() + settings.total_timeout_seconds
    client = genai.Client(api_key=settings.gemini_api_key)
    contents = [types.Part.from_bytes(data=image_bytes, mime_type=mime_type), make_user_prompt(prompt, correction)]
    thinking_control = True

    for attempt in range(1, MAX_ATTEMPTS + 1):
        remaining = deadline - time.monotonic()
        if remaining < 1:
            raise ModelProviderError(
                "Request budget exhausted.",
                http_status=504,
                code="MODEL_TIMEOUT",
                public_message="The model took too long to respond. Please retry.",
                retryable=True,
            )
        try:
            response = client.models.generate_content(
                model=settings.gemma_model,
                contents=contents,
                config=_build_config(
                    types,
                    with_thinking_control=thinking_control,
                    timeout_seconds=min(settings.model_timeout_seconds, remaining),
                ),
            )
            return _extract_text(response)
        except ModelProviderError:
            raise
        except Exception as exc:  # noqa: BLE001 - classified below
            detail = _redact(f"{type(exc).__name__}: {exc}")
            # If this endpoint does not accept the thinking setting, retry once without it.
            if thinking_control and getattr(exc, "code", None) == 400 and "think" in detail.lower():
                logger.warning("Thinking control rejected; retrying without it. %s", detail[:300])
                thinking_control = False
                continue
            classified = classify_provider_error(exc)
            logger.error("Gemini call failed (attempt %d/%d, model=%s): %s", attempt, MAX_ATTEMPTS, settings.gemma_model, detail[:800])

            wait_hint = _retry_after_seconds(exc)
            if wait_hint:
                classified.retry_after = math.ceil(wait_hint)
            delay = _backoff_delay(attempt, wait_hint)
            can_retry = (
                classified.retryable
                and attempt < MAX_ATTEMPTS
                and (wait_hint is None or wait_hint <= MAX_RETRY_AFTER_SECONDS)
                and deadline - time.monotonic() > delay + MIN_USEFUL_ATTEMPT_SECONDS
            )
            if can_retry:
                time.sleep(delay)
                continue
            raise classified from exc

    raise ModelProviderError("Exhausted attempts without a response.")  # pragma: no cover


async def interpret_sketch(
    image_bytes: bytes,
    mime_type: str,
    prompt: str,
    *,
    deadline: float | None = None,
    correction: str = "",
) -> str:
    if settings.mock_model:
        return _mock_page()

    if not breaker.allow():
        wait = breaker.retry_after()
        raise ModelProviderError(
            "Circuit breaker open.",
            http_status=503,
            code="MODEL_UNAVAILABLE",
            public_message=f"The model service is failing repeatedly, so requests are paused briefly. Try again in {wait} seconds.",
            retry_after=wait,
        )

    if deadline is None:
        deadline = time.monotonic() + settings.total_timeout_seconds
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(_call_gemma, image_bytes, mime_type, prompt, deadline, correction),
            timeout=max(1.0, deadline - time.monotonic()) + 5,
        )
    except asyncio.TimeoutError as exc:
        breaker.record_failure()
        raise ModelTimeoutError("The model request timed out.") from exc
    except ModelProviderError as exc:
        # Only transient provider trouble counts against the breaker; a bad key
        # or a bad request fails fast on its own and says nothing about health.
        breaker.record_failure() if exc.retryable else breaker.release()
        raise
    except BaseException:  # config errors, cancellation, anything unexpected
        breaker.release()
        raise
    breaker.record_success()
    return result
