# Visioncoder frontend

React + TypeScript + Vite frontend for turning a hand-drawn website sketch into an editable webpage.

## Requirements
- Node.js 20+ recommended
- Backend is optional while using mock mode

## Run locally
```bash
cd frontend
npm install
npm run dev
```
Open http://localhost:5173.

## Build and checks
```bash
npm run build
npm test
```

## Backend connection
The app calls the FastAPI backend at `VITE_API_BASE_URL` (default `http://localhost:8000`). Start the backend first. Copy `.env.example` to `.env.local` to change the URL. Never put the Gemini API key in the frontend.

Errors from the backend (`{ "error": { "code", "message" } }`) are shown as written, so the message tells you what to fix. The instructions field is limited to 500 characters to match the backend.

## Contract
The frontend consumes schema version `1.0`:
- `schemaVersion`
- `pageTitle`
- `themeHint`: `professional | minimalist | colorful`
- `components`: `id`, `type`, `props`
- `detectedElements`
- `uncertainties`

Allowed types: `navbar`, `hero`, `textSection`, `imagePlaceholder`, `button`, `cardGrid`, `footer`. The frontend does not execute model-produced HTML or JavaScript.

Every component has a stable ID. Every card in `cardGrid.props.cards` should also include its own unique `id`. When a card id is absent, the frontend creates a deterministic fallback based on the parent component ID and card index for display/editing. Prefer explicit card IDs from the fixture/backend.

## Editing
- Select elements in Edit mode; Preview mode is for the final-page view.
- Element content and style overrides live in React state.
- Theme changes update theme defaults without replacing user overrides.
- Font sizes are constrained to 8–96px; hex colors must be six-digit.
- Export generates a standalone HTML document with inline CSS. Model text is escaped before HTML serialization.

## Fixtures
- `examples/sample-page.json`
- `examples/sample-event.json`
- App fixtures are mirrored in `src/mock/` for direct imports.
