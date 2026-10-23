"""Small, dependency-free building blocks that keep the API stable under stress.

* CircuitBreaker  - stop calling a failing provider for a short cooldown
* RateLimiter     - per-client request cap so one browser cannot drain the quota
* ResponseCache   - remember finished pages so a retry or double-click is free
* model_slot      - cap simultaneous provider calls and queue the rest briefly
"""
from __future__ import annotations

import asyncio
import contextvars
import copy
import hashlib
import threading
import time
import weakref
from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from typing import Any, Callable

from app.config import settings
from app.errors import ServerBusyError

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class CircuitBreaker:
    """closed -> (N consecutive failures) -> open -> (cooldown) -> half-open -> closed/open.

    While open, ``allow()`` is False so callers fail instantly instead of each
    waiting out a timeout. After the cooldown exactly one trial call is allowed.
    """

    def __init__(self, threshold: int, cooldown: float, clock: Callable[[], float] = time.monotonic):
        self.threshold = threshold
        self.cooldown = cooldown
        self._clock = clock
        self._lock = threading.Lock()
        self._failures = 0
        self._opened_at: float | None = None
        self._trial = False

    @property
    def state(self) -> str:
        with self._lock:
            if self._opened_at is None:
                return "closed"
            return "half-open" if self._clock() - self._opened_at >= self.cooldown else "open"

    def retry_after(self) -> int:
        with self._lock:
            if self._opened_at is None:
                return 0
            return max(1, int(self.cooldown - (self._clock() - self._opened_at)) + 1)

    def allow(self) -> bool:
        with self._lock:
            if self._opened_at is None:
                return True
            if self._clock() - self._opened_at >= self.cooldown and not self._trial:
                self._trial = True
                return True
            return False

    def record_success(self) -> None:
        with self._lock:
            self._failures, self._opened_at, self._trial = 0, None, False

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._opened_at is not None or self._failures >= self.threshold:
                self._opened_at = self._clock()  # (re)open
            self._trial = False

    def release(self) -> None:
        """The call ended without telling us anything about provider health."""
        with self._lock:
            self._trial = False


class RateLimiter:
    def __init__(self, limit: int, window: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.limit = limit
        self.window = window
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str) -> int:
        """Return 0 if the request may proceed, else seconds until it may."""
        if self.limit <= 0:
            return 0
        now = self._clock()
        with self._lock:
            if len(self._hits) > 1000:  # keep memory bounded
                self._hits = {k: v for k, v in self._hits.items() if v and now - v[-1] < self.window}
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] >= self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return max(1, int(self.window - (now - hits[0])) + 1)
            hits.append(now)
            return 0


class ResponseCache:
    def __init__(self, size: int, ttl: float, clock: Callable[[], float] = time.monotonic):
        self.size = size
        self.ttl = ttl
        self._clock = clock
        self._data: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Any | None:
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            expires, value = entry
            if self._clock() >= expires:
                del self._data[key]
                return None
            self._data.move_to_end(key)
            return copy.deepcopy(value)

    def put(self, key: str, value: Any) -> None:
        if self.size <= 0:
            return
        with self._lock:
            self._data[key] = (self._clock() + self.ttl, copy.deepcopy(value))
            self._data.move_to_end(key)
            while len(self._data) > self.size:
                self._data.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


def cache_key(image_bytes: bytes, mime_type: str, prompt: str) -> str:
    digest = hashlib.sha256()
    for part in (image_bytes, mime_type.encode(), prompt.strip().encode(), settings.gemma_model.encode()):
        digest.update(len(part).to_bytes(8, "big"))
        digest.update(part)
    return digest.hexdigest()


# One semaphore per event loop (a semaphore must not be shared across loops).
_gates: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


@asynccontextmanager
async def model_slot():
    loop = asyncio.get_running_loop()
    gate = _gates.get(loop)
    if gate is None:
        gate = _gates[loop] = asyncio.Semaphore(settings.max_concurrent_requests)
    try:
        await asyncio.wait_for(gate.acquire(), timeout=settings.queue_timeout_seconds)
    except asyncio.TimeoutError:
        raise ServerBusyError("No free generation slot.") from None
    try:
        yield
    finally:
        gate.release()


breaker = CircuitBreaker(settings.breaker_threshold, settings.breaker_cooldown_seconds)
rate_limiter = RateLimiter(settings.rate_limit_per_minute)
page_cache = ResponseCache(settings.cache_size, settings.cache_ttl_seconds)


def reset_all() -> None:
    """Restore a clean slate (used by tests)."""
    breaker.record_success()
    rate_limiter._hits.clear()
    page_cache.clear()
    _gates.clear()
