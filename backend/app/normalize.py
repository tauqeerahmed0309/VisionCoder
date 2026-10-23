"""Repair common quirks in model output before strict schema validation.

Language models regularly return JSON that is *almost* right: a seventh nav
link, a card body that is 20 characters too long, a duplicated ID, a button that
points at a section that does not exist. Rejecting the whole page for those
makes the API look broken (a 502), so this module clips, defaults and re-IDs
instead. The strict ``PageSpec`` model still runs afterwards as the safety net,
so nothing unsafe or unknown is ever passed to the frontend.
"""
from __future__ import annotations

import re
from typing import Any

from app.errors import InvalidModelOutputError

MAX_COMPONENTS = 20
MAX_CARDS = 6
MAX_LINKS = 6

_THEMES = {"professional", "minimalist", "colorful"}
_UNSAFE_ID_CHARS = re.compile(r"[^A-Za-z0-9_-]+")
_TYPE_ALIASES = {
    "navbar": "navbar",
    "hero": "hero",
    "textsection": "textSection",
    "imageplaceholder": "imagePlaceholder",
    "button": "button",
    "cardgrid": "cardGrid",
    "footer": "footer",
}


def _text(value: Any, limit: int, default: str = "") -> str:
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return default
    text = " ".join(str(value).split())
    if not text:
        return default
    if len(text) > limit:
        text = text[: max(limit - 1, 1)].rstrip() + "…"
    return text


def _text_list(value: Any, limit: int, max_items: int) -> list[str]:
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, (list, tuple)):
        return []
    items: list[str] = []
    for item in value:
        if isinstance(item, dict):
            item = item.get("label") or item.get("text") or item.get("name")
        cleaned = _text(item, limit)
        if cleaned:
            items.append(cleaned)
        if len(items) >= max_items:
            break
    return items


def _make_id(raw: Any, fallback: str, used: set[str]) -> str:
    base = _UNSAFE_ID_CHARS.sub("-", str(raw or "")).strip("-")[:70] or fallback
    candidate, n = base, 2
    while candidate in used:
        candidate = f"{base}-{n}"
        n += 1
    used.add(candidate)
    return candidate


def _canonical_type(raw: Any) -> str | None:
    key = re.sub(r"[\s_-]+", "", str(raw or "")).lower()
    return _TYPE_ALIASES.get(key)


def _props_of(component: dict[str, Any]) -> dict[str, Any]:
    props = component.get("props")
    if isinstance(props, dict):
        return props
    # Some models flatten props onto the component itself.
    return {k: v for k, v in component.items() if k not in {"id", "type", "props"}}


def _normalize_props(kind: str, p: dict[str, Any], used: set[str], component_id: str) -> dict[str, Any] | None:
    if kind == "navbar":
        return {
            "brand": _text(p.get("brand"), 60, "Brand"),
            "links": _text_list(p.get("links"), 40, MAX_LINKS),
            "ctaLabel": _text(p.get("ctaLabel"), 40),
        }
    if kind == "hero":
        alignment = str(p.get("alignment", "")).lower()
        return {
            "eyebrow": _text(p.get("eyebrow"), 80),
            "heading": _text(p.get("heading"), 150, "Your headline"),
            "body": _text(p.get("body"), 500),
            "buttonLabel": _text(p.get("buttonLabel"), 60),
            "alignment": alignment if alignment in {"left", "center", "right"} else "left",
        }
    if kind == "textSection":
        return {
            "heading": _text(p.get("heading"), 150, "Section heading"),
            "body": _text(p.get("body"), 1000),
        }
    if kind == "imagePlaceholder":
        ratio = re.sub(r"\s+", "", str(p.get("aspectRatio", ""))).lower()
        return {
            "label": _text(p.get("label"), 100, "Image"),
            "aspectRatio": "square" if ratio in {"square", "1:1", "1/1"} else "wide",
        }
    if kind == "button":
        # action/targetId are resolved in a second pass once every ID is known.
        return {
            "label": _text(p.get("label"), 60, "Button"),
            "action": p.get("action"),
            "targetId": p.get("targetId"),
        }
    if kind == "cardGrid":
        cards: list[dict[str, str]] = []
        raw_cards = p.get("cards")
        for index, card in enumerate(raw_cards if isinstance(raw_cards, list) else []):
            if not isinstance(card, dict):
                continue
            cards.append(
                {
                    "id": _make_id(card.get("id"), f"{component_id}-card-{index + 1}", used),
                    "title": _text(card.get("title"), 100, "Card"),
                    "body": _text(card.get("body"), 500),
                }
            )
            if len(cards) >= MAX_CARDS:
                break
        if not cards:
            return None
        return {"heading": _text(p.get("heading"), 150), "cards": cards}
    if kind == "footer":
        return {
            "text": _text(p.get("text"), 200),
            "links": _text_list(p.get("links"), 40, MAX_LINKS),
        }
    return None


def normalize_page(payload: Any) -> dict[str, Any]:
    """Return a cleaned copy of ``payload`` ready for ``PageSpec`` validation."""
    if not isinstance(payload, dict):
        raise InvalidModelOutputError("The model response was not a JSON object.")
    raw_components = payload.get("components")
    if not isinstance(raw_components, list):
        raise InvalidModelOutputError("The model response had no components list.")

    used: set[str] = set()
    id_map: dict[str, str] = {}
    components: list[dict[str, Any]] = []
    skipped = 0

    for index, raw in enumerate(raw_components):
        if len(components) >= MAX_COMPONENTS:
            skipped += 1
            continue
        if not isinstance(raw, dict):
            skipped += 1
            continue
        kind = _canonical_type(raw.get("type"))
        if kind is None:
            skipped += 1
            continue
        component_id = _make_id(raw.get("id"), f"{kind}-{index + 1}", used)
        props = _normalize_props(kind, _props_of(raw), used, component_id)
        if props is None:
            used.discard(component_id)
            skipped += 1
            continue
        original = str(raw.get("id") or "")
        if original and original not in id_map:
            id_map[original] = component_id
        components.append({"id": component_id, "type": kind, "props": props})

    if not components:
        raise InvalidModelOutputError("The model response contained no usable components.")

    known_ids = {c["id"] for c in components}
    for component in components:
        if component["type"] != "button":
            continue
        props = component["props"]
        target = id_map.get(str(props.get("targetId") or ""), props.get("targetId"))
        if props.get("action") == "scroll_to_section" and target in known_ids:
            props["action"], props["targetId"] = "scroll_to_section", target
        else:
            props["action"], props["targetId"] = "none", None

    detected: list[dict[str, Any]] = []
    raw_detected = payload.get("detectedElements")
    for item in raw_detected if isinstance(raw_detected, list) else []:
        if isinstance(item, str):
            item = {"label": item}
        if not isinstance(item, dict):
            continue
        label = _text(item.get("label"), 100)
        if not label:
            continue
        ref = item.get("componentId")
        ref = id_map.get(str(ref), ref) if ref is not None else None
        detected.append({"label": label, "componentId": ref if ref in known_ids else None})

    raw_notes = payload.get("uncertainties")
    notes = [n for n in (_text(v, 250) for v in (raw_notes if isinstance(raw_notes, list) else [])) if n]
    if skipped:
        notes.append("Some parts of the model response could not be used and were skipped.")

    theme = str(payload.get("themeHint", "")).lower()
    return {
        "schemaVersion": "1.0",
        "pageTitle": _text(payload.get("pageTitle"), 100, "Untitled page"),
        "themeHint": theme if theme in _THEMES else "professional",
        "components": components,
        "detectedElements": detected,
        "uncertainties": notes,
    }
