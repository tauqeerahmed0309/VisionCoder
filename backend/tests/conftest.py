import pytest

from app import reliability


@pytest.fixture(autouse=True)
def clean_reliability_state():
    reliability.reset_all()
    yield
    reliability.reset_all()
