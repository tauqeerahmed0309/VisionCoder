import pytest

from app import reliability
from app.config import settings


@pytest.fixture(autouse=True)
def clean_reliability_state():
    reliability.reset_all()
    yield
    reliability.reset_all()


@pytest.fixture(autouse=True)
def default_to_mock_model(monkeypatch):
    """Tests should not depend on whatever MOCK_MODEL happens to be in the
    developer's local .env. Default every test to the deterministic mock
    path; tests that want to exercise the real-model code (with a faked
    genai.Client) already call monkeypatch.setattr(settings, "mock_model",
    False) themselves, which simply overrides this for that one test."""
    monkeypatch.setattr(settings, "mock_model", True)
