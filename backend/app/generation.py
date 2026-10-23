from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
import time

from pydantic import ValidationError

from app.config import settings
from app.errors import InvalidModelOutputError
from app.image_prep import prepare_image
from app.model_adapter import interpret_sketch
from app.normalize import normalize_page
from app.reliability import cache_key, model_slot, page_cache
from app.schemas import PageSpec

logger = logging.getLogger("visioncoder.generation")

# Only ask the model to fix its answer if there is still a useful amount of time left.
MIN_SECONDS_FOR_REPAIR = 20

# Identical requests that arrive together (double-click, retry) share one model call.
_inflight: dict[str, asyncio.Task] = {}


def _extract_json(raw_text: str) -> str:
    text = raw_text.strip()
    # Accept a surrounding Markdown fence if the model accidentally emits one.
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, count=1, flags=re.IGNORECASE)
        text = re.sub(r"\s*```\s*$", "", text, count=1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise InvalidModelOutputError("The model response did not contain a JSON object.")
    return text[start : end + 1]


def _parse(raw_text: str) -> dict:
    """Raw model text -> validated page dict. Raises InvalidModelOutputError with a short reason."""
    try:
        payload = json.loads(_extract_json(raw_text))
        page = PageSpec.model_validate(normalize_page(payload))
    except json.JSONDecodeError as exc:
        reason = f"invalid JSON ({exc.msg} at position {exc.pos})"
    except ValidationError as exc:
        first = exc.errors()[0]
        reason = f"schema error at {'.'.join(str(p) for p in first['loc'])}: {first['msg']}"
    except InvalidModelOutputError as exc:
        reason = str(exc)
    else:
        return page.model_dump(mode="json", by_alias=True)
    # Log *why* so a bad generation can be diagnosed, but never the image.
    logger.warning("Model output rejected: %s | start of output: %r", reason, raw_text[:300])
    raise InvalidModelOutputError(reason)


async def _generate(image_bytes: bytes, mime_type: str, prompt: str, key: str, use_cache: bool) -> dict:
    deadline = time.monotonic() + settings.total_timeout_seconds
    async with model_slot():
        correction = ""
        for attempt in (1, 2):
            raw_text = await interpret_sketch(image_bytes, mime_type, prompt, deadline=deadline, correction=correction)
            try:
                result = _parse(raw_text)
                break
            except InvalidModelOutputError as exc:
                if attempt == 2 or deadline - time.monotonic() < MIN_SECONDS_FOR_REPAIR:
                    raise
                logger.info("Asking the model to correct its output (%s)", exc)
                correction = (
                    f"Your previous reply was rejected because of: {exc}. "
                    "Reply again with ONLY one corrected JSON object that follows every rule in the instructions."
                )
    if use_cache:
        page_cache.put(key, result)
    return result


async def generate_page(image_bytes: bytes, mime_type: str, prompt: str) -> dict:
    # Image preparation is CPU work; keep it off the event loop.
    image_bytes, mime_type = await asyncio.to_thread(prepare_image, image_bytes, mime_type)

    use_cache = not settings.mock_model  # mock output is free, so never cache it
    key = cache_key(image_bytes, mime_type, prompt)
    if use_cache:
        cached = page_cache.get(key)
        if cached is not None:
            logger.info("Served from cache")
            return cached

    task = _inflight.get(key)
    if task is None:
        task = asyncio.create_task(_generate(image_bytes, mime_type, prompt, key, use_cache))
        _inflight[key] = task

        def _cleanup(done: asyncio.Task, key: str = key) -> None:
            _inflight.pop(key, None)
            if not done.cancelled():
                done.exception()  # mark retrieved even if every waiter went away

        task.add_done_callback(_cleanup)
    else:
        logger.info("Joined an identical in-flight request")
    # shield: if one caller disconnects, the others still get the shared result.
    return copy.deepcopy(await asyncio.shield(task))
