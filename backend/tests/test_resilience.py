import json
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from google import genai
from google.genai import errors as genai_errors
from PIL import Image

from app import model_adapter
from app.config import settings
from app.errors import InvalidModelOutputError, ModelProviderError, ModelTimeoutError
from app.main import app
from app.normalize import normalize_page
from app.schemas import PageSpec

client = TestClient(app)


def png_bytes() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (320, 240), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def post_image():
    return client.post("/api/generate", files={"image": ("s.png", png_bytes(), "image/png")}, data={"prompt": ""})


def api_error(cls, code, status, message):
    return cls(code, {"error": {"code": code, "status": status, "message": message}})


# ---------- error classification ----------

@pytest.mark.parametrize(
    "exc, http, code, fragment",
    [
        (api_error(genai_errors.ClientError, 400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key."), 503, "MODEL_ERROR", "API key"),
        (api_error(genai_errors.ClientError, 403, "PERMISSION_DENIED", "denied"), 503, "MODEL_ERROR", "API key"),
        (api_error(genai_errors.ClientError, 404, "NOT_FOUND", "model not found"), 503, "MODEL_ERROR", "was not found"),
        (api_error(genai_errors.ClientError, 429, "RESOURCE_EXHAUSTED", "quota"), 429, "RATE_LIMITED", "quota"),
        (api_error(genai_errors.ServerError, 503, "UNAVAILABLE", "overloaded"), 502, "MODEL_ERROR", "temporarily unavailable"),
        (api_error(genai_errors.ClientError, 400, "INVALID_ARGUMENT", "something else"), 502, "MODEL_ERROR", "rejected the request"),
        (ConnectionError("Name or service not known"), 502, "MODEL_ERROR", "Could not reach"),
        (TimeoutError("read timed out"), 504, "MODEL_TIMEOUT", "too long"),
    ],
)
def test_classify_provider_error(exc, http, code, fragment):
    result = model_adapter.classify_provider_error(exc)
    assert result.http_status == http
    assert result.code == code
    assert fragment in result.public_message


def test_api_key_never_leaks_into_logged_detail(monkeypatch):
    monkeypatch.setattr(settings, "gemini_api_key", "SECRET-KEY-123")
    exc = api_error(genai_errors.ClientError, 400, "INVALID_ARGUMENT", "bad key SECRET-KEY-123")
    result = model_adapter.classify_provider_error(exc)
    assert "SECRET-KEY-123" not in str(result)
    assert "SECRET-KEY-123" not in result.public_message


# ---------- HTTP mapping ----------

@pytest.mark.parametrize(
    "raised, status, code",
    [
        (ModelProviderError("x", http_status=503, public_message="Bad key"), 503, "MODEL_ERROR"),
        (ModelProviderError("x", http_status=429, code="RATE_LIMITED", public_message="Slow down"), 429, "RATE_LIMITED"),
        (ModelTimeoutError("x"), 504, "MODEL_TIMEOUT"),
        (InvalidModelOutputError("x"), 502, "INVALID_MODEL_OUTPUT"),
        (RuntimeError("boom"), 500, "INTERNAL_ERROR"),
    ],
)
def test_route_maps_errors_to_json(monkeypatch, raised, status, code):
    async def fail(*_a, **_k):
        raise raised

    monkeypatch.setattr("app.main.generate_page", fail)
    response = post_image()
    assert response.status_code == status
    assert response.json()["error"]["code"] == code


def test_route_returns_specific_message(monkeypatch):
    async def fail(*_a, **_k):
        raise ModelProviderError("x", http_status=503, public_message="Check GEMINI_API_KEY")

    monkeypatch.setattr("app.main.generate_page", fail)
    assert post_image().json()["error"]["message"] == "Check GEMINI_API_KEY"


# ---------- provider call: retry + thinking fallback ----------

class FakeResponse:
    def __init__(self, text):
        self.text = text
        self.prompt_feedback = None
        self.candidates = []


def make_fake_client(outcomes, seen):
    class FakeModels:
        def generate_content(self, **kwargs):
            seen.append(kwargs["config"])
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return FakeResponse(outcome)

    class FakeClient:
        def __init__(self, *a, **k):
            self.models = FakeModels()

    return FakeClient


@pytest.fixture
def real_model(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", False)
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(model_adapter.time, "sleep", lambda *_: None)


def test_retries_transient_error_then_succeeds(monkeypatch, real_model):
    seen = []
    outcomes = [api_error(genai_errors.ServerError, 503, "UNAVAILABLE", "busy"), '{"ok": true}']
    monkeypatch.setattr(genai, "Client", make_fake_client(outcomes, seen))
    assert model_adapter._call_gemma(b"x", "image/png", "") == '{"ok": true}'
    assert len(seen) == 2


def test_does_not_retry_bad_key(monkeypatch, real_model):
    seen = []
    outcomes = [api_error(genai_errors.ClientError, 400, "INVALID_ARGUMENT", "API key not valid")]
    monkeypatch.setattr(genai, "Client", make_fake_client(outcomes, seen))
    with pytest.raises(ModelProviderError) as info:
        model_adapter._call_gemma(b"x", "image/png", "")
    assert len(seen) == 1
    assert info.value.http_status == 503


def test_falls_back_when_thinking_setting_rejected(monkeypatch, real_model):
    seen = []
    outcomes = [api_error(genai_errors.ClientError, 400, "INVALID_ARGUMENT", "Thinking level is not supported"), "{}"]
    monkeypatch.setattr(genai, "Client", make_fake_client(outcomes, seen))
    assert model_adapter._call_gemma(b"x", "image/png", "") == "{}"
    assert seen[0].thinking_config is not None
    assert seen[1].thinking_config is None


def test_thinking_disabled_and_budget_raised_by_default(monkeypatch, real_model):
    seen = []
    monkeypatch.setattr(genai, "Client", make_fake_client(["{}"], seen))
    model_adapter._call_gemma(b"x", "image/png", "")
    assert seen[0].max_output_tokens >= 8192
    assert str(seen[0].thinking_config.thinking_level).endswith("MINIMAL")


def test_empty_response_is_a_clear_error(monkeypatch, real_model):
    seen = []
    monkeypatch.setattr(genai, "Client", make_fake_client([""], seen))
    with pytest.raises(ModelProviderError) as info:
        model_adapter._call_gemma(b"x", "image/png", "")
    assert "empty response" in info.value.public_message


# ---------- end to end with messy model output ----------

MESSY = {
    "schemaVersion": "1.0",
    "pageTitle": "T" * 300,
    "themeHint": "Professional",
    "components": [
        {"id": "nav one", "type": "navbar", "props": {"brand": "Brand", "links": list("ABCDEFGHI")}},
        {"id": "dup", "type": "hero", "props": {"heading": "Hi", "body": "x" * 900, "buttonLabel": "Go", "alignment": "middle"}},
        {"id": "dup", "type": "textSection", "props": {"heading": "Two", "body": "y"}},
        {"id": "img", "type": "imagePlaceholder", "props": {"label": "Photo", "aspectRatio": "16:9"}},
        {"id": "btn", "type": "button", "props": {"label": "Jump", "action": "scroll_to_section", "targetId": "does-not-exist"}},
        {"id": "weird", "type": "carousel", "props": {}},
        {"id": "cards", "type": "cardGrid", "props": {"cards": [{"id": "dup", "title": "A", "body": "b"}, "junk"]}},
    ],
    "detectedElements": [{"label": "Top bar", "componentId": "nav one"}, {"label": "Ghost", "componentId": "nope"}],
    "uncertainties": ["note"],
}


def test_normalize_repairs_common_model_mistakes():
    page = PageSpec.model_validate(normalize_page(MESSY)).model_dump(by_alias=True)
    ids = [c["id"] for c in page["components"]]
    assert len(ids) == len(set(ids)) == 6  # unknown "carousel" dropped
    assert page["pageTitle"].endswith("…") and len(page["pageTitle"]) <= 100
    assert page["themeHint"] == "professional"
    nav, hero = page["components"][0], page["components"][1]
    assert len(nav["props"]["links"]) == 6
    assert hero["props"]["alignment"] == "left" and len(hero["props"]["body"]) <= 500
    assert page["components"][3]["props"]["aspectRatio"] == "wide"
    button = page["components"][4]["props"]
    assert button["action"] == "none" and button["targetId"] is None
    assert page["detectedElements"][0]["componentId"] == nav["id"]
    assert page["detectedElements"][1]["componentId"] is None
    assert any("skipped" in n for n in page["uncertainties"])


def test_card_ids_stay_unique_across_page():
    page = normalize_page(MESSY)
    all_ids = [c["id"] for c in page["components"]]
    for c in page["components"]:
        if c["type"] == "cardGrid":
            all_ids += [card["id"] for card in c["props"]["cards"]]
    assert len(all_ids) == len(set(all_ids))


def test_normalize_rejects_garbage():
    with pytest.raises(InvalidModelOutputError):
        normalize_page([])
    with pytest.raises(InvalidModelOutputError):
        normalize_page({"components": [{"type": "carousel"}]})


def test_full_route_accepts_fenced_messy_output(monkeypatch):
    async def fake_interpret(*_a, **_k):
        return "Here you go:\n```json\n" + json.dumps(MESSY) + "\n```"

    monkeypatch.setattr("app.generation.interpret_sketch", fake_interpret)
    response = post_image()
    assert response.status_code == 200
    assert response.json()["themeHint"] == "professional"
