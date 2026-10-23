from __future__ import annotations

from io import BytesIO
import warnings

from PIL import Image, UnidentifiedImageError

from app.errors import APIError

ALLOWED_MIME_TO_FORMAT = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
}
MAX_IMAGE_PIXELS = 25_000_000


def validate_image_bytes(image_bytes: bytes, content_type: str) -> str:
    """Validate declared MIME type and actual image contents, return normalized MIME."""
    declared_mime = (content_type or "").split(";", 1)[0].strip().lower()
    if declared_mime not in ALLOWED_MIME_TO_FORMAT:
        raise APIError(415, "INVALID_IMAGE", "Upload a JPG, PNG or WebP image.")

    if not image_bytes:
        raise APIError(400, "INVALID_IMAGE", "The uploaded image is empty.")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(image_bytes)) as image:
                detected_format = image.format
                width, height = image.size
                if width < 1 or height < 1:
                    raise APIError(400, "INVALID_IMAGE", "The image dimensions are invalid.")
                if width * height > MAX_IMAGE_PIXELS:
                    raise APIError(400, "INVALID_IMAGE", "The image dimensions are too large.")
                image.verify()
    except APIError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise APIError(400, "INVALID_IMAGE", "The uploaded file is not a valid supported image.") from None

    expected_format = ALLOWED_MIME_TO_FORMAT[declared_mime]
    if detected_format != expected_format:
        raise APIError(400, "INVALID_IMAGE", "The file contents do not match the declared image type.")
    return declared_mime
