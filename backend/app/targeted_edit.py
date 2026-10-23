"""Safe, scoped edits for a single existing Visioncoder component or card."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from pydantic import ValidationError

from app.config import settings
from app.errors import InvalidModelOutputError, ModelConfigurationError, ModelProviderError, ModelTimeoutError
from app.model_adapter import classify_provider_error
from app.schemas import LayoutComponentRef, LayoutGroup, PageSpec

logger = logging.getLogger("visioncoder.targeted_edit")
_ALLOWED_STYLE_KEYS = {"fontFamily", "fontSize", "color", "backgroundColor", "accentColor", "borderColor"}
_ALLOWED_FONTS = {"Arial", "Inter", "Roboto", "Georgia", "Verdana", "Poppins"}
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def _extract_object(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, count=1, flags=re.I)
        text = re.sub(r"\s*```$", "", text, count=1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise InvalidModelOutputError("The edit model response did not contain a JSON object.")
    try:
        value = json.loads(text[start:end + 1])
    except json.JSONDecodeError as exc:
        raise InvalidModelOutputError("The edit model returned invalid JSON.") from exc
    if not isinstance(value, dict):
        raise InvalidModelOutputError("The edit model response must be a JSON object.")
    return value


def _find_target(page_data: dict[str, Any], selected_id: str) -> tuple[str, dict[str, Any], str | None]:
    for component in page_data["components"]:
        if component["id"] == selected_id:
            return "component", component, None
    for component in page_data["components"]:
        if component["type"] == "cardGrid":
            for card in component["props"].get("cards", []):
                if card["id"] == selected_id:
                    return "card", card, component["id"]
    raise ValueError("Select a supported component or card before applying an AI edit.")


def _layout_context(node: Any, target_component_id: str, parents: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    parents = parents or []
    if isinstance(node, LayoutComponentRef):
        return parents if node.componentId == target_component_id else []
    if isinstance(node, LayoutGroup):
        next_parents = parents + [{"type": node.type, "columns": node.columns, "gap": node.gap}]
        for child in node.children:
            found = _layout_context(child, target_component_id, next_parents)
            if found:
                return found
    return []


def _validate_style(raw: Any, current: dict[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for source in (current, raw if isinstance(raw, dict) else {}):
        if not isinstance(source, dict):
            continue
        for key, value in source.items():
            if key not in _ALLOWED_STYLE_KEYS:
                continue
            if key == "fontFamily":
                if isinstance(value, str) and value in _ALLOWED_FONTS:
                    merged[key] = value
            elif key == "fontSize":
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    merged[key] = max(8, min(96, int(value)))
            elif isinstance(value, str) and _COLOR.fullmatch(value):
                merged[key] = value.upper()
    return merged


def _apply_props(page_data: dict[str, Any], target_type: str, target_id: str, host_id: str | None, raw_props: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(raw_props, dict):
        raise InvalidModelOutputError("The edit model did not return a props object.")
    candidate = json.loads(json.dumps(page_data))
    if target_type == "component":
        target = next(c for c in candidate["components"] if c["id"] == target_id)
        allowed = set(target["props"].keys())
        # Card content is edited by selecting a single card, never by replacing an
        # entire grid. This prevents a model response from changing sibling cards
        # or their IDs during a targeted edit of the grid container.
        if target["type"] == "cardGrid":
            allowed.discard("cards")
        patch = {key: value for key, value in raw_props.items() if key in allowed and key not in {"id", "type"}}
        target["props"].update(patch)
        try:
            validated = PageSpec.model_validate(candidate)
        except ValidationError as exc:
            raise InvalidModelOutputError("The suggested component edit failed schema validation.") from exc
        clean_page = validated.model_dump(mode="json", by_alias=True)
        clean_target = next(c for c in clean_page["components"] if c["id"] == target_id)
        return clean_page, clean_target["props"]

    host = next(c for c in candidate["components"] if c["id"] == host_id and c["type"] == "cardGrid")
    card = next(c for c in host["props"]["cards"] if c["id"] == target_id)
    allowed = {"title", "body"}
    patch = {key: value for key, value in raw_props.items() if key in allowed}
    card.update(patch)
    try:
        validated = PageSpec.model_validate(candidate)
    except ValidationError as exc:
        raise InvalidModelOutputError("The suggested card edit failed schema validation.") from exc
    clean_page = validated.model_dump(mode="json", by_alias=True)
    clean_host = next(c for c in clean_page["components"] if c["id"] == host_id)
    clean_card = next(c for c in clean_host["props"]["cards"] if c["id"] == target_id)
    return clean_page, {"title": clean_card["title"], "body": clean_card["body"], "id": clean_card["id"]}


def _mock_patch(target: dict[str, Any], instruction: str, current_style: dict[str, Any]) -> dict[str, Any]:
    """Predictable local behavior when MOCK_MODEL=true; this is explicitly non-AI."""
    props = dict(target.get("props", target))
    style: dict[str, Any] = {}
    text = instruction.strip()
    lower = text.lower()
    quoted = re.search(r"\bto\s+[\"']?(.+?)[\"']?$", text, flags=re.I)
    replacement = quoted.group(1).strip().rstrip(".!?") if quoted else ""
    target_fields = list(props.keys())
    if replacement:
        if any(word in lower for word in ("button", "label", "text", "rename")):
            key = next((k for k in ("label", "buttonLabel", "ctaLabel", "heading", "title", "brand") if k in target_fields), None)
            if key:
                props[key] = replacement[:150]
        elif any(word in lower for word in ("heading", "title")):
            key = next((k for k in ("heading", "title") if k in target_fields), None)
            if key:
                props[key] = replacement[:150]
    if any(word in lower for word in ("background", "background color", "theme")):
        color = "#26734D" if "green" in lower or "forest" in lower or "eco" in lower else "#2457A7" if "blue" in lower else "#292B28" if "dark" in lower or "black" in lower else "#FFFFFF"
        style["backgroundColor"] = color
    if any(word in lower for word in ("text color", "font color", "foreground")):
        style["color"] = "#FFFFFF" if "white" in lower else "#183A2D" if "green" in lower else "#2457A7" if "blue" in lower else "#20211F"
    if "larger" in lower or "increase font" in lower or "bigger" in lower:
        style["fontSize"] = min(96, int(current_style.get("fontSize", 16)) + 4)
    return {"props": props, "style": style}


def _call_model(target: dict[str, Any], target_type: str, instruction: str, context: list[dict[str, Any]], current_style: dict[str, Any], title: str) -> dict[str, Any]:
    if not settings.gemini_api_key:
        raise ModelConfigurationError("GEMINI_API_KEY is not configured.")
    from google import genai
    from google.genai import types

    system = """You are Visioncoder's targeted webpage editor. Return ONLY one JSON object with exactly two fields: props and style. props must be a partial update for the selected target only, and style must be a partial style patch. Never change IDs, types, layout, siblings, or unrelated content. Use only these style keys: fontFamily (Arial, Inter, Roboto, Georgia, Verdana, Poppins), fontSize (8-96 integer), color, backgroundColor, accentColor, borderColor (each color must be #RRGGBB). Never return HTML, CSS strings, JavaScript, URLs, or extra keys. Update only fields that the user's instruction clearly requests; leave other fields unchanged by omitting them."""
    user = {
        "pageTitle": title,
        "selectedTargetType": target_type,
        "selectedTarget": target,
        "layoutParentContext": context,
        "currentStyle": current_style,
        "instruction": instruction,
        "responseExample": {"props": {"heading": "new heading if asked"}, "style": {"backgroundColor": "#26734D"}},
    }
    client = genai.Client(api_key=settings.gemini_api_key)
    try:
        response = client.models.generate_content(
            model=settings.gemma_model,
            contents=[system, json.dumps(user, ensure_ascii=False)],
            config=types.GenerateContentConfig(
                temperature=0.2,
                max_output_tokens=2048,
                response_mime_type="application/json",
                http_options=types.HttpOptions(timeout=max(1, int(settings.model_timeout_seconds * 1000))),
            ),
        )
    except Exception as exc:  # noqa: BLE001
        # Use the same classification and secret redaction as sketch generation so
        # bad keys, unavailable models, quota errors, and network failures are distinct.
        classified = classify_provider_error(exc)
        logger.warning("Targeted edit provider failure: %s", classified.code)
        raise classified from exc
    if not getattr(response, "text", None):
        raise InvalidModelOutputError("The edit model returned an empty response.")
    return _extract_object(response.text)


async def edit_selected_target(page: PageSpec, selected_id: str, instruction: str, current_style: dict[str, Any]) -> dict[str, Any]:
    page_data = page.model_dump(mode="json", by_alias=True)
    try:
        target_type, target, host_id = _find_target(page_data, selected_id)
    except ValueError as exc:
        raise InvalidModelOutputError(str(exc)) from exc
    host_context_id = host_id or selected_id
    parents = _layout_context(page.layout, host_context_id) if page.layout else []
    if settings.mock_model:
        raw_patch = _mock_patch(target, instruction, current_style)
    else:
        try:
            raw_patch = await asyncio.wait_for(
                asyncio.to_thread(_call_model, target, target_type, instruction, parents, current_style, page.pageTitle),
                timeout=settings.model_timeout_seconds + 2,
            )
        except asyncio.TimeoutError as exc:
            raise ModelTimeoutError("The targeted edit model timed out.") from exc
    if not isinstance(raw_patch, dict):
        raise InvalidModelOutputError("The edit model response was not an object.")
    candidate, clean_props = _apply_props(page_data, target_type, selected_id, host_id, raw_patch.get("props", {}))
    style = _validate_style(raw_patch.get("style", {}), current_style)
    # The full validated page is intentionally not returned: the client updates only this target.
    return {"selectedId": selected_id, "targetType": target_type, "props": clean_props, "style": style}
