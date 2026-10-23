from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image

from app.config import settings
from app.main import app

client = TestClient(app)


def png_bytes() -> bytes:
    image = Image.new("RGB", (320, 240), color="white")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_generate_returns_page_schema_in_mock_mode(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", True)
    response = client.post(
        "/api/generate",
        files={"image": ("sketch.png", png_bytes(), "image/png")},
        data={"prompt": "Make it professional"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["schemaVersion"] == "1.0"
    assert body["themeHint"] == "professional"
    assert "components" in body
    assert any(component["type"] == "cardGrid" for component in body["components"])
    assert any("Mock mode" in item for item in body["uncertainties"])


def test_rejects_non_image(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", True)
    response = client.post(
        "/api/generate",
        files={"image": ("not-image.png", b"not a real image", "image/png")},
        data={"prompt": ""},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_IMAGE"


def test_rejects_unsupported_mime(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", True)
    response = client.post(
        "/api/generate",
        files={"image": ("sketch.gif", b"GIF89a", "image/gif")},
        data={"prompt": ""},
    )
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "INVALID_IMAGE"
