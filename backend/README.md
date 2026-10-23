# Visioncoder Backend

FastAPI backend for Visioncoder: upload a hand-drawn website sketch and return a validated Page Specification JSON response for the frontend renderer.

## Requirements

- Python 3.11 or newer
- A virtual environment
- For real AI generation: a Gemini API key with access to the hosted Gemma model configured below

## 1. Install

From this `visioncoder_backend` directory, in Windows PowerShell:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

If PowerShell blocks activation, use a terminal with an allowed activation policy or run `.venv\Scripts\python.exe -m pip install -r requirements.txt` and `.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8001`.

## 2. Run without an API key first

In `.env`, keep `MOCK_MODEL=true`. Mock mode returns fixed sample page data; it does **not** inspect the image. It exists only to test the API, response schema and frontend integration.

```powershell
uvicorn app.main:app --reload --port 8001
```

Open `http://localhost:8001/docs`, use `POST /api/generate`, upload a real PNG/JPG/WebP image, and inspect the JSON response. `/health` should return `status: ok`.

## 3. Enable Gemma 4

1. Obtain a Gemini API key through Google AI Studio.
2. Set `GEMINI_API_KEY=your_key` in the backend `.env` file.
3. Set `MOCK_MODEL=false`.
4. Keep `GEMMA_MODEL=gemma-4-26b-a4b-it` unless your account/event requires a different currently supported Gemma 4 model.
5. Restart Uvicorn and test `POST /api/generate` with a clear wireframe image.

The application calls the Google Gen AI Python SDK from the backend. Never put the key in frontend code or commit `.env` to GitHub.

## Troubleshooting a 502 / "gateway error"

A 502 means the call to Gemini failed or its output was unusable. Run the diagnostic first; it prints the real error from Google:

```powershell
python check_model.py
```

The API now returns a specific message and logs the full cause (API key redacted) in the Uvicorn console:

| Message | Cause | Fix |
| --- | --- | --- |
| Gemini rejected the API key | Wrong, expired or restricted key | Re-copy it into `.env` (no quotes), restart |
| Model ... was not found | Wrong `GEMMA_MODEL` | Use `gemma-4-26b-a4b-it` or `gemma-4-31b-it` |
| Quota or rate limit reached (429) | Free-tier limits | Wait, or check quota in AI Studio |
| Could not reach the Gemini API | Network, proxy or firewall | Check the server's internet access |
| Model response could not be converted | Output did not match the schema | Retry with a clearer sketch |

Transient errors (429, 5xx, dropped connections) are retried once. Thinking mode is turned off so the JSON is not cut off by the token limit, and minor model mistakes (too many links, over-long text, duplicate IDs) are repaired instead of rejected.

## Reliability features

| Protection | What it does |
| --- | --- |
| Concurrency cap | At most `MAX_CONCURRENT_REQUESTS` Gemini calls run at once. Extra requests wait briefly, then get `503 BUSY` with `Retry-After`. |
| Request de-duplication and cache | Identical uploads that arrive together (double-click) share one model call. Finished pages are cached for `CACHE_TTL_SECONDS`, so retrying costs no quota. |
| Retries with backoff | Transient errors (429, 5xx, network) are retried up to 3 times with exponential backoff and jitter, honouring the server's `Retry-After`. A wait over 10 s is reported instead of slept through. |
| Shared deadline | One `TOTAL_TIMEOUT_SECONDS` budget covers every retry, so a request can never hang past what the browser will wait for. |
| Circuit breaker | After `BREAKER_THRESHOLD` consecutive provider failures, calls pause for `BREAKER_COOLDOWN_SECONDS` and fail instantly (`503 MODEL_UNAVAILABLE`) instead of making each user wait. One trial request then tests recovery. Bad-key and bad-request errors never trip it. |
| Output correction | If the model's reply is not valid, it gets one chance to fix it, told exactly what was wrong. |
| Image preparation | EXIF rotation applied, transparency flattened to white, oversized images downscaled. |
| Rate limit | `RATE_LIMIT_PER_MINUTE` per client IP (`429 RATE_LIMITED` with `Retry-After`). |
| Request IDs | Every response has `X-Request-ID`, error bodies include `requestId`, and every log line carries it. |
| Health endpoints | `GET /health` (liveness, includes breaker state) and `GET /ready` (503 if the key is missing or the breaker is open). |

Error codes the frontend can receive: `INVALID_IMAGE`, `IMAGE_TOO_LARGE`, `VALIDATION_ERROR`, `RATE_LIMITED`, `BUSY`, `MODEL_UNAVAILABLE`, `MODEL_ERROR`, `MODEL_TIMEOUT`, `INVALID_MODEL_OUTPUT`, `INTERNAL_ERROR`. Every one carries a human-readable `message`.

Running several Uvicorn workers? The limiter, cache and breaker are per process, which is fine for a project or demo; use Redis-backed equivalents for a larger deployment.

## API contract

- `GET /health` — liveness, configured model, mock mode, and circuit-breaker state.
- `GET /ready` — readiness check.
- `POST /api/generate` — `multipart/form-data` with required `image` (PNG, JPG/JPEG, or WebP; max 8 MB) and optional `prompt` (max 500 characters). Returns a validated PageSpec v1.0 including `components` and a recursive `layout` tree. Old model responses without layout metadata are normalized with a conservative inferred layout.
- `POST /api/edit` — `application/json` for a selected component or card. Example request:

```json
{
  "page": {
    "schemaVersion": "1.0",
    "pageTitle": "Example",
    "themeHint": "professional",
    "components": [
      { "id": "hero-1", "type": "hero", "props": { "heading": "Welcome", "body": "A sample page.", "buttonLabel": "", "alignment": "left" } }
    ],
    "detectedElements": [],
    "uncertainties": [],
    "layout": { "type": "column", "id": "layout-root", "columns": 1, "gap": 24, "children": [{ "type": "component", "componentId": "hero-1" }] }
  },
  "selectedId": "hero-1",
  "instruction": "Make the heading larger",
  "currentStyle": { "fontSize": 24 }
}
```

  The `page` field must contain a valid PageSpec (including at least one component); `selectedId` must match a component ID or an individual card ID; `instruction` is limited to 500 characters. Success returns `{ "selectedId": "hero-1", "targetType": "component", "props": {}, "style": {} }`. The client applies the returned patch only to the selected target. Arbitrary HTML, CSS strings, JavaScript, and URLs are not accepted as style values.

Errors use the stable shape `{"error":{"code":"...","message":"..."}}`. The schema is in `app/schemas.py`, the generation prompt in `app/prompt_templates.py`, and model/provider code in `app/model_adapter.py`.

## Tests

```powershell
pytest -q
```

The API tests use mock mode and do not need a real API key.

## Current scope

The backend interprets sketches into structured page data with a validated recursive layout tree. `POST /api/edit` performs an AI-assisted targeted edit of one component/card and returns schema-validated property patches plus whitelisted style tokens. Theme switching, preview state, Undo/Redo, and HTML export remain frontend responsibilities; this is a backend-only change. The backend does not generate or execute arbitrary HTML/JavaScript.
