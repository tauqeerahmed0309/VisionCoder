import asyncio
import json
from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from google import genai
from PIL import Image

from app import model_adapter
from app.config import settings
from app.errors import InvalidModelOutputError, ModelProviderError, ServerBusyError
from app.generation import generate_page
from app.image_prep import prepare_image
from app.main import app
from app.reliability import CircuitBreaker, RateLimiter, ResponseCache, breaker, rate_limiter

client = TestClient(app)

GOOD = {
    "schemaVersion": "1.0", "pageTitle": "T", "themeHint": "professional",
    "components": [{"id": "hero-1", "type": "hero", "props": {"heading": "Hi", "body": "b", "buttonLabel": "Go", "alignment": "left"}}],
    "detectedElements": [], "uncertainties": [],
}


def png_bytes(size=(320, 240)) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size, "white").save(buffer, format="PNG")
    return buffer.getvalue()


def post_image():
    return client.post("/api/generate", files={"image": ("s.png", png_bytes(), "image/png")}, data={"prompt": ""})


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


# ---------------- circuit breaker ----------------

def test_breaker_opens_then_recovers_through_a_single_trial():
    clock = Clock()
    b = CircuitBreaker(threshold=3, cooldown=30, clock=clock)
    for _ in range(2):
        b.record_failure()
    assert b.state == "closed" and b.allow()
    b.record_failure()
    assert b.state == "open" and not b.allow() and 1 <= b.retry_after() <= 31
    clock.now += 31
    assert b.state == "half-open"
    assert b.allow()          # the one trial
    assert not b.allow()      # everyone else still fails fast
    b.record_success()
    assert b.state == "closed" and b.allow()


def test_failed_trial_reopens_and_neutral_trial_does_not_get_stuck():
    clock = Clock()
    b = CircuitBreaker(threshold=1, cooldown=10, clock=clock)
    b.record_failure()
    clock.now += 11
    assert b.allow()
    b.record_failure()
    assert b.state == "open"
    clock.now += 11
    assert b.allow()
    b.release()               # trial ended with e.g. a bad-key error
    assert b.allow()          # a new trial is possible, breaker not wedged


def test_only_transient_failures_open_the_global_breaker(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", False)
    monkeypatch.setattr(breaker, "threshold", 2)
    calls = []

    def fake_call(*_a, **_k):
        calls.append(1)
        raise ModelProviderError("x", retryable=transient[0])

    monkeypatch.setattr(model_adapter, "_call_gemma", fake_call)
    transient = [False]
    for _ in range(4):
        with pytest.raises(ModelProviderError):
            asyncio.run(model_adapter.interpret_sketch(b"x", "image/png", ""))
    assert breaker.state == "closed" and len(calls) == 4   # bad-key style errors never trip it

    transient[0] = True
    for _ in range(2):
        with pytest.raises(ModelProviderError):
            asyncio.run(model_adapter.interpret_sketch(b"x", "image/png", ""))
    assert breaker.state == "open"
    before = len(calls)
    with pytest.raises(ModelProviderError) as info:
        asyncio.run(model_adapter.interpret_sketch(b"x", "image/png", ""))
    assert len(calls) == before                      # failed fast, provider not called
    assert info.value.code == "MODEL_UNAVAILABLE" and info.value.http_status == 503 and info.value.retry_after


# ---------------- rate limiter / cache ----------------

def test_rate_limiter_window():
    clock = Clock()
    limiter = RateLimiter(limit=2, window=60, clock=clock)
    assert limiter.check("a") == 0 and limiter.check("a") == 0
    assert limiter.check("a") > 0
    assert limiter.check("b") == 0                    # other clients unaffected
    clock.now += 61
    assert limiter.check("a") == 0
    assert RateLimiter(limit=0).check("a") == 0       # 0 disables


def test_cache_ttl_lru_and_isolation():
    clock = Clock()
    cache = ResponseCache(size=2, ttl=10, clock=clock)
    cache.put("a", {"v": 1}); cache.put("b", {"v": 2})
    got = cache.get("a"); got["v"] = 99
    assert cache.get("a") == {"v": 1}                 # callers cannot mutate stored data
    cache.put("c", {"v": 3})                          # evicts least recently used ("b")
    assert cache.get("b") is None and cache.get("a") and cache.get("c")
    clock.now += 11
    assert cache.get("a") is None


# ---------------- image preparation ----------------

def test_large_image_is_downscaled():
    out, mime = prepare_image(png_bytes((4000, 3000)), "image/png")
    assert mime == "image/png"
    assert max(Image.open(BytesIO(out)).size) <= settings.max_image_dimension


def test_transparency_is_flattened_to_white():
    buffer = BytesIO()
    Image.new("RGBA", (50, 50), (0, 0, 0, 0)).save(buffer, format="PNG")
    out, _ = prepare_image(buffer.getvalue(), "image/png")
    image = Image.open(BytesIO(out))
    assert image.mode == "RGB" and image.getpixel((5, 5)) == (255, 255, 255)


def test_webp_becomes_jpeg_and_garbage_is_passed_through():
    buffer = BytesIO()
    Image.new("RGB", (60, 60), "white").save(buffer, format="WEBP")
    _, mime = prepare_image(buffer.getvalue(), "image/webp")
    assert mime == "image/jpeg"
    assert prepare_image(b"not an image", "image/png") == (b"not an image", "image/png")


# ---------------- corrective retry ----------------

def test_model_gets_one_chance_to_correct_bad_output(monkeypatch):
    seen = []

    async def fake(*_a, correction="", **_k):
        seen.append(correction)
        return "sorry, no json here" if len(seen) == 1 else json.dumps(GOOD)

    monkeypatch.setattr("app.generation.interpret_sketch", fake)
    page = asyncio.run(generate_page(png_bytes(), "image/png", ""))
    assert page["pageTitle"] == "T"
    assert seen[0] == "" and "rejected" in seen[1]


def test_gives_up_after_one_correction(monkeypatch):
    calls = []

    async def fake(*_a, **_k):
        calls.append(1)
        return "still not json"

    monkeypatch.setattr("app.generation.interpret_sketch", fake)
    with pytest.raises(InvalidModelOutputError):
        asyncio.run(generate_page(png_bytes(), "image/png", ""))
    assert len(calls) == 2


def test_no_correction_when_time_is_nearly_up(monkeypatch):
    monkeypatch.setattr(settings, "total_timeout_seconds", 5)
    calls = []

    async def fake(*_a, **_k):
        calls.append(1)
        return "nope"

    monkeypatch.setattr("app.generation.interpret_sketch", fake)
    with pytest.raises(InvalidModelOutputError):
        asyncio.run(generate_page(png_bytes(), "image/png", ""))
    assert len(calls) == 1


# ---------------- dedupe, cache, concurrency ----------------

def test_identical_requests_share_one_call_and_are_then_cached(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", False)
    calls = []

    async def fake(*_a, **_k):
        calls.append(1)
        await asyncio.sleep(0.05)
        return json.dumps(GOOD)

    monkeypatch.setattr("app.generation.interpret_sketch", fake)

    async def scenario():
        img = png_bytes()
        a, b = await asyncio.gather(generate_page(img, "image/png", ""), generate_page(img, "image/png", ""))
        a["pageTitle"] = "mutated"
        c = await generate_page(img, "image/png", "")          # cache hit
        d = await generate_page(img, "image/png", "other")      # different prompt -> new call
        return b, c, d

    b, c, _ = asyncio.run(scenario())
    assert len(calls) == 2 and b["pageTitle"] == "T" and c["pageTitle"] == "T"


def test_failed_generation_is_not_cached(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", False)
    outcomes = ["garbage", "garbage", json.dumps(GOOD)]

    async def fake(*_a, **_k):
        return outcomes.pop(0)

    monkeypatch.setattr("app.generation.interpret_sketch", fake)
    with pytest.raises(InvalidModelOutputError):
        asyncio.run(generate_page(png_bytes(), "image/png", ""))
    assert asyncio.run(generate_page(png_bytes(), "image/png", ""))["pageTitle"] == "T"


def test_concurrency_cap_turns_overflow_into_busy(monkeypatch):
    monkeypatch.setattr(settings, "max_concurrent_requests", 1)
    monkeypatch.setattr(settings, "queue_timeout_seconds", 0.05)

    async def slow(*_a, **_k):
        await asyncio.sleep(0.3)
        return json.dumps(GOOD)

    monkeypatch.setattr("app.generation.interpret_sketch", slow)

    async def scenario():
        img = png_bytes()
        return await asyncio.gather(generate_page(img, "image/png", "one"), generate_page(img, "image/png", "two"), return_exceptions=True)

    results = asyncio.run(scenario())
    assert sum(isinstance(r, ServerBusyError) for r in results) == 1
    assert sum(isinstance(r, dict) for r in results) == 1


# ---------------- provider call: backoff, Retry-After, deadline ----------------

class RateLimited(Exception):
    code, status = 429, "RESOURCE_EXHAUSTED"

    def __init__(self, retry_after):
        super().__init__("quota")
        self.response = SimpleNamespace(headers={"retry-after": str(retry_after)})


def fake_client(outcomes, calls):
    class Models:
        def generate_content(self, **_k):
            calls.append(1)
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return SimpleNamespace(text=outcome, prompt_feedback=None, candidates=[])

    class Client:
        def __init__(self, *a, **k):
            self.models = Models()

    return Client


@pytest.fixture
def real_model(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", False)
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    slept = []
    monkeypatch.setattr(model_adapter.time, "sleep", lambda s: slept.append(s))
    return slept


def test_short_retry_after_is_honoured(monkeypatch, real_model):
    calls = []
    monkeypatch.setattr(genai, "Client", fake_client([RateLimited(4), "{}"], calls))
    assert model_adapter._call_gemma(b"x", "image/png", "") == "{}"
    assert len(calls) == 2 and real_model[0] >= 4


def test_long_retry_after_is_reported_not_slept_through(monkeypatch, real_model):
    calls = []
    monkeypatch.setattr(genai, "Client", fake_client([RateLimited(45), "{}"], calls))
    with pytest.raises(ModelProviderError) as info:
        model_adapter._call_gemma(b"x", "image/png", "")
    assert len(calls) == 1 and real_model == [] and info.value.retry_after == 45


def test_backoff_grows_and_is_capped():
    d1, d2, d3, d9 = (model_adapter._backoff_delay(n, None) for n in (1, 2, 3, 9))
    assert 1.5 <= d1 <= 2.0 and 3.0 <= d2 <= 3.5 and 6.0 <= d3 <= 6.5 and d9 <= 8.5
    assert model_adapter._backoff_delay(1, 7) >= 7


def test_expired_deadline_never_calls_provider(monkeypatch, real_model):
    calls = []
    monkeypatch.setattr(genai, "Client", fake_client(["{}"], calls))
    with pytest.raises(ModelProviderError) as info:
        model_adapter._call_gemma(b"x", "image/png", "", deadline=model_adapter.time.monotonic() - 1)
    assert not calls and info.value.code == "MODEL_TIMEOUT"


# ---------------- HTTP surface ----------------

def test_rate_limit_returns_429_with_retry_after(monkeypatch):
    monkeypatch.setattr(rate_limiter, "limit", 2)
    assert post_image().status_code == 200 and post_image().status_code == 200
    response = post_image()
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "RATE_LIMITED"
    assert int(response.headers["retry-after"]) >= 1


def test_open_breaker_fails_fast_with_retry_after(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", False)
    monkeypatch.setattr(breaker, "threshold", 1)
    breaker.record_failure()
    response = post_image()
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "MODEL_UNAVAILABLE"
    assert int(response.headers["retry-after"]) >= 1


def test_busy_maps_to_503(monkeypatch):
    async def busy(*_a, **_k):
        raise ServerBusyError("full")

    monkeypatch.setattr("app.main.generate_page", busy)
    response = post_image()
    assert response.status_code == 503 and response.json()["error"]["code"] == "BUSY"
    assert response.headers["retry-after"] == "5"


def test_request_ids_are_returned_echoed_and_sanitised():
    assert client.get("/health").headers["x-request-id"]
    assert client.get("/health", headers={"X-Request-ID": "trace-123"}).headers["x-request-id"] == "trace-123"
    assert client.get("/health", headers={"X-Request-ID": "bad id with spaces!"}).headers["x-request-id"] != "bad id with spaces!"


def test_error_body_carries_the_request_id(monkeypatch):
    async def busy(*_a, **_k):
        raise ServerBusyError("full")

    monkeypatch.setattr("app.main.generate_page", busy)
    response = client.post("/api/generate", files={"image": ("s.png", png_bytes(), "image/png")},
                           headers={"X-Request-ID": "abc-1"})
    assert response.json()["error"]["requestId"] == "abc-1"


def test_ready_and_health(monkeypatch):
    assert client.get("/ready").json() == {"ready": True, "problems": []}
    assert client.get("/health").json()["breaker"] == "closed"
    monkeypatch.setattr(settings, "mock_model", False)
    monkeypatch.setattr(settings, "gemini_api_key", None)
    response = client.get("/ready")
    assert response.status_code == 503 and "GEMINI_API_KEY" in response.json()["problems"][0]
