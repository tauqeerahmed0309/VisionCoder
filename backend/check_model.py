"""Diagnose the Gemini connection and show the REAL error behind a 502.

Run from the backend folder (with your venv active):

    python check_model.py

It sends a tiny text request, then a generated wireframe image through the same
code path the API uses, and prints exactly what Google returned.
"""
from __future__ import annotations

import asyncio
import sys
from io import BytesIO

from app.config import settings


def _wireframe_png() -> bytes:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (640, 420), "white")
    d = ImageDraw.Draw(img)
    d.rectangle((20, 20, 620, 60), outline="black", width=3)          # navbar
    d.text((30, 32), "Logo        Home  About  Contact", fill="black")
    d.rectangle((20, 80, 620, 200), outline="black", width=3)         # hero
    d.text((200, 120), "Big headline + button", fill="black")
    for x in (20, 230, 440):                                          # cards
        d.rectangle((x, 220, x + 180, 360), outline="black", width=3)
    d.rectangle((20, 375, 620, 405), outline="black", width=3)        # footer
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def main() -> int:
    key = settings.gemini_api_key
    print(f"Model:      {settings.gemma_model}")
    print(f"Mock mode:  {settings.mock_model}")
    print(f"API key:    {'set (' + str(len(key)) + ' chars)' if key else 'NOT SET'}")
    if settings.mock_model:
        print("\nMOCK_MODEL=true, so the real model is never called. Set MOCK_MODEL=false in .env and re-run.")
        return 1
    if not key:
        print("\nGEMINI_API_KEY is empty. Add it to backend/.env.")
        return 1

    from google import genai

    from app.model_adapter import classify_provider_error

    print("\n[1/2] Plain text request ...")
    try:
        client = genai.Client(api_key=key)
        reply = client.models.generate_content(model=settings.gemma_model, contents="Reply with the single word: OK")
        print(f"      OK -> {(reply.text or '').strip()[:60]!r}")
    except Exception as exc:  # noqa: BLE001
        hint = classify_provider_error(exc)
        print(f"      FAILED: {type(exc).__name__}: {str(exc)[:600]}")
        print(f"      Meaning: {hint.public_message}")
        return 2

    print("\n[2/2] Image -> page JSON (same path as /api/generate) ...")
    from app.generation import generate_page
    from app.errors import InvalidModelOutputError, ModelProviderError

    try:
        page = asyncio.run(generate_page(_wireframe_png(), "image/png", ""))
        kinds = [c["type"] for c in page["components"]]
        print(f"      OK -> {len(kinds)} components: {', '.join(kinds)}")
    except ModelProviderError as exc:
        print(f"      FAILED (provider): {exc}")
        print(f"      Meaning: {exc.public_message}")
        return 3
    except InvalidModelOutputError as exc:
        print(f"      FAILED (output did not match schema): {exc}")
        print("      See the 'Model output rejected' line in the log above for the raw start of the output.")
        return 4

    print("\nAll good. If the app still fails, the problem is between the browser and the backend (URL/CORS).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
