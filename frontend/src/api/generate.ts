import type { PageData } from '../schemas/page';
import { isPageData } from '../schemas/page';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 150_000;

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PROMPT_CHARS = 500; // must match the backend limit

export function validateImage(file: File): string | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return 'Use a JPG, PNG or WebP image.';
  if (file.size > MAX_IMAGE_BYTES) return 'Image must be 8 MB or smaller.';
  return null;
}

// Copy that is clearer than what the backend sends for the same code.
const CLIENT_MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: `The request was rejected. Check the image and keep the instructions under ${MAX_PROMPT_CHARS} characters.`,
  INVALID_MODEL_OUTPUT: 'The model returned an invalid page description. Please try again.',
};

function statusMessage(status: number): string {
  if (status === 502 || status === 503 || status === 504) {
    return `The server in front of the backend returned a gateway error (HTTP ${status}). Check that the backend is running, then try again.`;
  }
  if (status === 404) return `The backend endpoint was not found. Check VITE_API_BASE_URL (currently ${API_BASE_URL}).`;
  return `Generation failed (HTTP ${status}). Please try again.`;
}

export async function generatePage(image: File, prompt: string): Promise<PageData> {
  const body = new FormData();
  body.append('image', image);
  if (prompt.trim()) body.append('prompt', prompt.trim());

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/generate`, { method: 'POST', body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error('Generation took too long. Please try again.');
    }
    throw new Error(`Could not reach ${API_BASE_URL}. Check that the backend is running and that CORS allows ${window.location.origin}.`);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const nested = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : root;
    const code = typeof nested.code === 'string' ? nested.code : '';
    const serverMessage = typeof nested.message === 'string' ? nested.message : '';
    throw new Error(CLIENT_MESSAGES[code] || serverMessage || statusMessage(response.status));
  }
  if (!isPageData(payload)) throw new Error('The backend response did not match schema version 1.0.');
  return payload;
}
