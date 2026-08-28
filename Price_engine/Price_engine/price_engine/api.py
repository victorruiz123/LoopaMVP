"""FastAPI-lager. Laddar datan en gång vid uppstart och håller den i minnet."""

from __future__ import annotations

import base64
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import config
from .condition import build_bands
from .data_loader import load_listings
from .pricing import price_query
from .variant import VARIANT_LABELS, VariantGuess, classify_image
from .vectors import load_vectors

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

# Datan lever här mellan anrop.
STATE: dict = {"listings": None, "multipliers": None, "vectors": None}


@asynccontextmanager
async def lifespan(app: FastAPI):
    started = time.perf_counter()
    log.info("Laddar annonsdata från %s ...", config.DATA_DIR)
    STATE["listings"] = load_listings()
    # Skickmultiplikatorerna härleds ur datan en gång, inte per anrop.
    STATE["multipliers"] = build_bands(STATE["listings"])
    # Bildvektorerna (fas 4). Saknas de fungerar allt utom bildsökningen.
    STATE["vectors"] = load_vectors()
    log.info(
        "Klar: %d annonser i minnet på %.1f s",
        len(STATE["listings"]),
        time.perf_counter() - started,
    )
    # --- Förvärmning -------------------------------------------------------
    # Två tunga tabeller byggdes förut vid FÖRSTA bildförfrågan: bildlagrets
    # baskarta (93 230 vektorrader) och ledordens korpusbaslinje (60 000
    # annonser). Båda är memoiserade singletons, så kostnaden togs en gång —
    # men den togs av användaren, mitt i ett anrop, och gjorde första
    # bildsökningen flera minuter lång. Servern såg klar ut medan gränssnittet
    # stod och snurrade. Nu betalas de här, före "startup complete".
    warm = time.perf_counter()
    try:
        from . import visual_variant

        visual_variant._corpus_frequency(STATE["listings"])
    except Exception:  # noqa: BLE001 - förvärmning får aldrig fälla uppstarten
        log.warning("Kunde inte förvärma ledordsbaslinjen", exc_info=True)
    try:
        if STATE.get("vectors") is not None:
            from type_system import image_layer

            image_layer.row_bases(STATE["vectors"], STATE["listings"])
    except Exception:  # noqa: BLE001
        log.warning("Kunde inte förvärma bildlagrets baskarta", exc_info=True)
    # YOLO- och DINOv2-modellerna laddas lru_cache:at vid första bildkodningen.
    # Den laddningen tog ~115 s och betalades av den första användaren som
    # laddade upp ett foto — ovanpå allt annat. Nu sker den här.
    try:
        from . import vision

        vision.detector()
        vision.embedder()
        # Vikterna räcker inte: FÖRSTA forward-passet är det dyra, och det
        # betalades av den första uppladdade bilden (~90 s, utan ett enda
        # modellanrop i loggen). En attrappbild här flyttar kostnaden hit.
        from PIL import Image as _Image

        vision.prepare_one(_Image.new("RGB", (640, 640), (127, 127, 127)))
    except Exception:  # noqa: BLE001
        log.warning("Kunde inte förvärma bildmodellerna", exc_info=True)
    log.info("Förvärmning klar på %.1f s", time.perf_counter() - warm)

    # Sägs rakt ut vid uppstart. Formlagret är AVSTÄNGT som default, och utan
    # den här raden syns skillnaden bara som att bilden inte gör någon nytta —
    # samma tysta fel som HEIC-avvisningen gav.
    if config.FORM_VISION_ENABLED:
        log.info("Formlagret PÅ (modell %s): bilden skriver formord och "
                 "tillbehör i frågan", config.FORM_VISION_MODEL)
    else:
        log.info("Formlagret AV. Sätt PRICE_ENGINE_FORM_VISION=1 för att låta "
                 "bilden skriva formord (u-soffa) och tillbehör (+ fotpall).")
    yield
    STATE.clear()


app = FastAPI(
    title="Prismotor för begagnade möbler",
    description="Föreslår ett prisintervall baserat på liknande annonser.",
    version="1.0.0",
    lifespan=lifespan,
)

# --- CORS: bara när någon uttryckligen bett om det -------------------------
# Middleware läggs INTE till när listan är tom. Skillnaden mot att lägga till
# den med noll origins är att en preflight då fortsätter svara 405 precis som
# förut, i stället för 400 — alltså exakt oförändrat beteende.
if config.CORS_ORIGINS:
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.CORS_ORIGINS),
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "x-api-key"],
    )
    log.info("CORS på för: %s", ", ".join(config.CORS_ORIGINS))


# --- API-nyckel: bara när en är satt ---------------------------------------
def require_key(x_api_key: Optional[str] = Header(None)) -> None:
    """Kräver `x-api-key` — men bara när PRICE_ENGINE_API_KEY är satt.

    Utan nyckel i miljön är funktionen en no-op, så alla befintliga anropare
    fortsätter fungera oförändrat. /health lämnas medvetet utanför: en
    lastbalanserare ska kunna kolla liveness utan hemlighet.

    Jämförelsen görs med `compare_digest` i stället för `==` eftersom en vanlig
    strängjämförelse avslutas vid första skiljande tecken och därmed läcker
    nyckeln tecken för tecken till den som mäter svarstiden.
    """
    if not config.API_KEY:
        return
    import secrets

    if not x_api_key or not secrets.compare_digest(x_api_key, config.API_KEY):
        raise HTTPException(status_code=401, detail="Ogiltig eller saknad x-api-key")


class PriceRequest(BaseModel):
    # Optional[...] istället för `str | None`: Pydantic evaluerar annotationerna
    # runtime, och den syntaxen finns först i Python 3.10.
    name: str = Field(..., description="Modellnamn, t.ex. 'Landskrona'")
    brand: Optional[str] = Field(None, description="Varumärke, t.ex. 'IKEA'")
    condition: Optional[str] = Field(
        None, description="Skick i fritext. Utelämnas -> ingen skickfiltrering."
    )
    price_kind: Optional[str] = Field(
        config.DEFAULT_PRICE_KIND,
        description=(
            "'realized' = faktiskt betalt (auktion, tunt för IKEA), "
            "'asking' = utropspris i annonser, "
            "'auto' = realized när underlaget räcker annars asking, "
            "null = båda. Vilken bas som användes returneras i priceBasis."
        ),
    )
    damages: Optional[List[dict]] = Field(
        None,
        description=(
            "Färdig skadelista från skadesystemet. Prismotorn DETEKTERAR inte "
            "skador — den värderar dem. Per post: {description (obligatorisk), "
            "severity (valfri, 0/1/2 eller text som 'synlig'/'kraftig'), "
            "location (valfri), image (valfri base64, används bara vid "
            "kostnadsuppskattning)}. Kräver PRICE_ENGINE_DAMAGE=1."
        ),
    )
    variant: Optional[List[str]] = Field(
        None,
        description=(
            "Möbeltyp(er), t.ex. ['hörnsoffa']. Modellnamnet ensamt räcker "
            "inte — 'Landskrona' omfattar soffa, hörnsoffa, fåtölj och "
            "fotpall. Flera värden tillåts när skillnaden är osäker. "
            "Utelämnas den läses typen ur image_base64 om en bild skickas."
        ),
    )
    image_base64: Optional[str] = Field(
        None,
        description=(
            "Foto av möbeln, base64-kodat. Klassificeras till en möbeltyp. "
            "Ignoreras om variant angetts explicit."
        ),
    )
    image_media_type: Optional[str] = Field(
        "image/jpeg", description="MIME-typ för image_base64."
    )
    attribute_text: Optional[str] = Field(
        None,
        description=(
            "Användarens hela text, om `name` är en kapad söknyckel. Används "
            "bara för att läsa attribut (möbeltyp, storlek, bäddfunktion). "
            "Utelämnas den används `name`."
        ),
    )
    image_rerank: Optional[bool] = Field(
        True,
        description=(
            "Ranka kandidaterna på bildlikhet mot image_base64 (DINOv2). "
            "Sätt false för att bara använda bilden till möbeltyp."
        ),
    )


@app.post("/price", dependencies=[Depends(require_key)])
def price(request: PriceRequest) -> dict:
    """Föreslår pris som intervall: low (säljs snabbt) – default – high (säljs långsamt)."""
    # Samma uppladdade bild används till två saker: möbeltyp (om variant inte
    # angetts) och bildlikhet. Avkoda en gång.
    image = None
    if request.image_base64:
        try:
            image = base64.b64decode(request.image_base64)
        except Exception:
            log.warning("Kunde inte avkoda image_base64, fortsätter utan bild")

    # Har klienten redan angett möbeltyp behövs ingen typklassning — men
    # bilden används ändå för omsorteringen.
    classify_from = image if not request.variant else None

    return price_query(
        STATE["listings"],
        name=request.name,
        brand=request.brand,
        condition=request.condition,
        price_kind=request.price_kind,
        multipliers=STATE["multipliers"],
        variant=request.variant,
        image=classify_from,
        # Formlagret ska se bilden ÄVEN när klienten valt möbeltyp: typen och
        # formen är olika uppgifter, och `classify_from` är None i det läget.
        form_image=image,
        image_media_type=request.image_media_type or "image/jpeg",
        damages=request.damages,
        vectors=STATE["vectors"],
        image_rerank=bool(request.image_rerank) and image is not None,
        attribute_text=request.attribute_text,
        # Bildklassningen är ett hjälpmedel, inte ett krav: saknad API-nyckel
        # eller nätverksfel ska inte fälla hela prisförfrågan.
        classifier=_safe_classifier,
    )


def _safe_classifier(**kwargs):
    """Klassificerar bilden, men låter aldrig ett fel fälla prisförfrågan."""
    try:
        return classify_image(**kwargs)
    except Exception:
        log.warning("Bildklassning misslyckades, fortsätter utan", exc_info=True)
        return VariantGuess(variants=[], confidence="låg")


@app.get("/variants", dependencies=[Depends(require_key)])
def variants() -> dict:
    """Möbeltyperna motorn känner till — samma etiketter som bilden klassas till."""
    listings = STATE.get("listings")
    counts = (
        {} if listings is None
        else listings["variant"].value_counts().to_dict()
    )
    return {
        "labels": list(VARIANT_LABELS),
        "listingsPerVariant": {k: int(v) for k, v in counts.items()},
    }


@app.get("/condition-bands", dependencies=[Depends(require_key)])
def condition_bands() -> dict:
    """Skickbanden som härleddes ur datan vid uppstart."""
    table = STATE["multipliers"]
    if table is None:
        return {"status": "loading"}
    return {
        "reference": table.reference,
        "priceLevelEdges": [round(e) for e in table.edges],
        "overall": {k: b.as_dict() for k, b in sorted(table.overall.items())},
        "perPriceLevel": {
            f"{level}/{cond}": b.as_dict()
            for (level, cond), b in sorted(table.per_level.items())
        },
    }


@app.get("/", include_in_schema=False)
def ui():
    """Testgränssnittet. Serveras från samma origin som API:et, så inga CORS-krav."""
    return FileResponse(Path(__file__).resolve().parent / "static" / "index.html")


@app.get("/health")
def health() -> dict:
    listings = STATE.get("listings")
    return {
        "status": "ok" if listings is not None else "loading",
        "listings": 0 if listings is None else len(listings),
        "data_dir": str(config.DATA_DIR),
    }
