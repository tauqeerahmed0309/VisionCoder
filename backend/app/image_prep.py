from __future__ import annotations

import logging
from io import BytesIO

from PIL import Image, ImageOps

from app.config import settings

logger = logging.getLogger("visioncoder.image")


def prepare_image(image_bytes: bytes, mime_type: str) -> tuple[bytes, str]:
    """Normalize an already-validated upload before it is sent to the model.

    * applies EXIF rotation (phone photos of a sketch are often "sideways")
    * flattens transparency onto white (transparent PNGs otherwise read as black)
    * downscales very large images: faster, cheaper, and far less likely to time out

    Never raises: if anything goes wrong the original bytes are used unchanged.
    """
    try:
        with Image.open(BytesIO(image_bytes)) as source:
            rotated = source.getexif().get(0x0112, 1) not in (0, 1)
            image = ImageOps.exif_transpose(source)
            image.load()
        limit = settings.max_image_dimension
        changed = rotated
        if max(image.size) > limit:
            image.thumbnail((limit, limit), Image.Resampling.LANCZOS)
            changed = True
        if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
            rgba = image.convert("RGBA")
            background = Image.new("RGB", rgba.size, "white")
            background.paste(rgba, mask=rgba.split()[-1])
            image = background
            changed = True
        elif image.mode != "RGB":
            image = image.convert("RGB")
            changed = True

        buffer = BytesIO()
        if mime_type == "image/png":
            image.save(buffer, format="PNG", optimize=True)
            out_mime = "image/png"
        else:
            image.save(buffer, format="JPEG", quality=90)
            out_mime = "image/jpeg"
        prepared = buffer.getvalue()
        # Keep the original bytes only if we changed nothing and re-encoding did not shrink it.
        if not changed and out_mime == mime_type and len(prepared) >= len(image_bytes):
            return image_bytes, mime_type
        return prepared, out_mime
    except Exception:  # noqa: BLE001
        logger.warning("Image preparation failed; sending the original image", exc_info=True)
        return image_bytes, mime_type
