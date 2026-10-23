import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.normalize import normalize_page
from app.schemas import PageSpec

client = TestClient(app)
SAMPLE = Path(__file__).resolve().parents[1] / "examples" / "sample-page.json"


def sample_page():
    return normalize_page(json.loads(SAMPLE.read_text(encoding="utf-8")))


def test_legacy_page_gets_valid_explicit_layout():
    payload = json.loads(SAMPLE.read_text(encoding="utf-8"))
    payload.pop("layout", None)
    normalized = normalize_page(payload)
    page = PageSpec.model_validate(normalized)
    assert page.layout is not None
    assert page.layout.type == "column"


def test_layout_references_each_component_once():
    payload = sample_page()
    PageSpec.model_validate(payload)
    refs = []
    def walk(node):
        if node["type"] == "component":
            refs.append(node["componentId"])
        else:
            for child in node["children"]:
                walk(child)
    walk(payload["layout"])
    assert sorted(refs) == sorted(component["id"] for component in payload["components"])
    assert len(refs) == len(set(refs))


def test_rejects_layout_missing_component_reference():
    payload = sample_page()
    payload["layout"]["children"] = payload["layout"]["children"][:-1]
    try:
        PageSpec.model_validate(payload)
    except Exception as exc:
        assert "every component exactly once" in str(exc)
    else:
        raise AssertionError("invalid layout was accepted")


def test_mock_targeted_edit_changes_only_selected_component(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", True)
    page = sample_page()
    original_other = json.loads(json.dumps(page["components"][0]))
    response = client.post("/api/edit", json={
        "page": page,
        "selectedId": "hero-1",
        "instruction": "Change the button label to Get Started",
        "currentStyle": {},
    })
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["targetType"] == "component"
    assert result["props"]["buttonLabel"] == "Get Started"
    assert page["components"][0] == original_other


def test_mock_targeted_edit_returns_sanitized_style(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", True)
    page = sample_page()
    response = client.post("/api/edit", json={
        "page": page,
        "selectedId": "card-1",
        "instruction": "Make this card background forest green",
        "currentStyle": {"backgroundColor": "red;position:fixed", "fontFamily": "url(javascript:alert(1))"},
    })
    assert response.status_code == 200, response.text
    style = response.json()["style"]
    assert style["backgroundColor"] == "#26734D"
    assert "fontFamily" not in style
    assert "position" not in style


def test_grid_targeted_edit_cannot_replace_sibling_cards():
    from app.targeted_edit import _apply_props

    page = sample_page()
    page_data = json.loads(json.dumps(page))
    grid = next(component for component in page_data["components"] if component["type"] == "cardGrid")
    original_cards = json.loads(json.dumps(grid["props"]["cards"]))

    # A misbehaving model must not be able to replace all cards when the grid
    # container (rather than one individual card) is selected.
    candidate, _ = _apply_props(
        page_data,
        "component",
        grid["id"],
        None,
        {"heading": "Updated features", "cards": [{"id": "changed-id", "title": "Injected", "body": "Changed sibling"}]},
    )
    updated_grid = next(component for component in candidate["components"] if component["id"] == grid["id"])
    assert updated_grid["props"]["heading"] == "Updated features"
    assert updated_grid["props"]["cards"] == original_cards


def test_targeted_edit_rejects_unknown_selected_id(monkeypatch):
    monkeypatch.setattr(settings, "mock_model", True)
    response = client.post("/api/edit", json={
        "page": sample_page(),
        "selectedId": "not-on-this-page",
        "instruction": "Change the background to green",
        "currentStyle": {},
    })
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_TARGET"
