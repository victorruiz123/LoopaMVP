"""Bildformat in i motorn: sniffa på riktigt, konvertera vid behov.

Anledningen till att filen finns: bild-LLM:en tar bara png, jpeg, gif och webp.
En iPhone lämnar HEIC, och `accept="image/*"` i uppladdningsrutan släpper igenom
det. Anropet svarade då `400 unsupported image` — men bara i en WARNING-rad, så
prissvaret kom tillbaka utan formord och såg korrekt ut. Felet var tyst.

MIME-typen anroparen påstår används INTE. Webbläsare, filsystem och
delningsfunktioner sätter fel typ ofta nog att den inte går att lita på; magiska
bytes ljuger inte.
"""

from __future__ import annotations

import logging
from typing import Optional, Tuple

log = logging.getLogger(__name__)

#: Format bild-LLM:erna tar emot direkt.
SUPPORTED = ("png", "jpeg", "gif", "webp")


def sniff(blob: bytes) -> Optional[str]:
    """Verkligt bildformat ur magiska bytes, eller None när det är okänt."""
    if not blob or len(blob) < 12:
        return None
    if blob[:8].startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if blob[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if blob[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "webp"
    if blob[:2] == b"BM":
        return "bmp"
    if blob[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    # HEIC/HEIF: "ftyp"-boxen ligger på offset 4, undertypen direkt efter.
    if blob[4:8] == b"ftyp":
        brand = blob[8:12]
        if brand in (b"heic", b"heix", b"hevc", b"heim", b"heis", b"mif1",
                     b"msf1", b"avif", b"avis"):
            return "heic" if brand != b"avif" else "avif"
    return None


def to_supported(blob: bytes) -> Tuple[bytes, str]:
    """(bytes, media_type) som bild-LLM:en säkert kan läsa.

    Format den redan tar skickas orörda — omkodning kostar kvalitet i onödan.
    Övriga konverteras till JPEG med Pillow. Går det inte returneras originalet
    oförändrat, så att en misslyckad konvertering aldrig fäller ett prissvar;
    anropet får då svara 400 som förut, men nu med formatet utskrivet i loggen.
    """
    kind = sniff(blob)
    if kind in SUPPORTED:
        return blob, f"image/{kind}"

    try:
        import io

        from PIL import Image

        with Image.open(io.BytesIO(blob)) as im:
            im = im.convert("RGB")
            out = io.BytesIO()
            im.save(out, format="JPEG", quality=90)
        log.info("Bild konverterad från %s till jpeg (%d -> %d byte)",
                 kind or "okänt", len(blob), out.tell())
        return out.getvalue(), "image/jpeg"
    except Exception as exc:  # noqa: BLE001 - bilden får aldrig fälla priset
        log.warning(
            "Bildformatet %r kunde inte konverteras (%s). HEIC från iPhone "
            "kräver paketet pillow-heif; utan det måste bilden skickas som "
            "jpeg eller png.", kind or "okänt", str(exc)[:120])
        return blob, f"image/{kind or 'jpeg'}"
