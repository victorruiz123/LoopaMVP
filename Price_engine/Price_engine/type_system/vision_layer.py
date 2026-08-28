"""L3 — bilden, fint. Vision-LLM, betald, och därför riktad.

Lagret ställer **konkreta, verifierbara frågor per attribut** i stället för
"vilken typ är detta". Skillnaden är inte kosmetisk: "vilken typ" tvingar modellen
att väga ihop form, funktion och pris i ett enda ordval, medan "har soffan en
hörnsektion i 90 grader" har ett svar som går att se på bilden och att granska i
efterhand.

Fyra regler som inte är förhandlingsbara:

1. **`convertible` och `set_items` frågas ALDRIG ur en bild.** Båda handlar om
   vad möbeln ÄR eller vad som INGÅR, inte om vad som syns.

   * En ihopfälld bäddsoffa ser ut som en soffa — därför kallade grannröstningen
     87 % av alla bäddsoffor för soffor.
   * `set_items` mättes med matchad design: 10 bord där stolarna ingår och 7 där
     de uttryckligen inte gör det. Modellen fick **10 av 10 rätt på de positiva
     och 0 av 7 på de negativa.** Den svarade korrekt på frågan den fick —
     stolarna SYNS runt bordet — men attributet handlar om vad som säljs med.
     Alla sju hade härlett `matgrupp` och prissatts till 0,52x, alltså halva
     värdet.

   Båda går till L4, där frågan "Ingår stolarna i priset?" har ett svar bilden
   aldrig kan ge.
2. **Bara okända attribut med hög prispåverkan.** Anropet kostar per bild, och
   `chaise` är mätt prisirrelevant (0,94x) — den ska aldrig kosta en krona.
3. **Fallback är obligatorisk.** Dör API:et — krediter, kvot, timeout — fortsätter
   kedjan utan L3. Det har hänt förut: krediterna tog slut mitt i en utvärdering
   och hela bildvägen föll bort. Det får aldrig kunna stoppa ett prissvar igen.
4. **Lita aldrig på `confidence`.** Modellen svarade "hog" på 114 av 115 anrop —
   93 rätta och 21 fel. Konfidensen bär ingen information, så asymmetriregeln i
   decide.accept kan inte gallra L3:s nedgraderingar: alla 16 felaktiga
   nedgraderingar kom med hög konfidens och hade passerat tröskeln. Skyddet mot
   L3 måste vara strukturellt — vilka frågor som alls ställs — inte statistiskt.

Svaren är strukturerade per attribut med `value`, `confidence` och `evidence` —
fritext går inte att mäta på.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from price_engine import config

from .attributes import IMPACT, SET_ITEMS_UNKNOWN, Attributes

log = logging.getLogger(__name__)

#: Attribut L3 får fråga om, med frågan som ställs och de tillåtna svaren.
#: `convertible` finns medvetet INTE här.
QUESTIONS: Dict[str, dict] = {
    "corner": {
        "fraga": "Har soffan en hörnsektion där sitsen viker av i ungefär "
                 "90 grader, så att den bildar ett L?",
        "svar": ("ja", "nej", "gar_inte_se"),
        "galler_for": ("soffa",),
    },
    "chaise": {
        "fraga": "Har soffan en utskjutande liggdel utan ryggstöd i ena änden "
                 "(divan eller schäslong)?",
        "svar": ("ja", "nej", "gar_inte_se"),
        "galler_for": ("soffa",),
    },
    "seats": {
        "fraga": "Hur många sittplatser har soffan? Räkna sittdynor eller "
                 "tydliga sittplatser.",
        "svar": ("1", "2", "3", "4", "5", "6", "gar_inte_se"),
        "galler_for": ("soffa",),
    },
    "storage_kind": {
        "fraga": "Har möbeln främst lådor, öppna hyllplan, dörrar med glas, "
                 "eller dörrar utan glas?",
        "svar": ("lador", "oppna_hyllplan", "glasdorrar", "dorrar", "gar_inte_se"),
        "galler_for": ("forvaring",),
    },
}

#: L3 anropas inte för attribut under den här prispåverkan. `chaise` (1) faller.
MIN_IMPACT = 3

#: Svarsöversättning till attributvärden.
_STORAGE = {"lador": "byra", "oppna_hyllplan": "hylla",
            "glasdorrar": "vitrin", "dorrar": "skank"}
_CONFIDENCE = {"hog": 0.85, "medel": 0.65, "lag": 0.40}


def wanted(attrs: Attributes, min_impact: int = MIN_IMPACT) -> Tuple[str, ...]:
    """Vilka attribut är värda ett betalt anrop just nu?

    Ett attribut kvalificerar när det är okänt, går att se på en bild, hör till
    den bastyp vi tror oss ha, och flyttar priset tillräckligt.
    """
    base = attrs.get("base")
    if base is None:
        return ()
    return tuple(
        name for name, spec in QUESTIONS.items()
        if not attrs.known(name)
        and base in spec["galler_for"]
        and IMPACT.get(name, 0) >= min_impact
    )


def _build_schema(names: Sequence[str]):
    """Ett svarsschema med exakt de frågor som ställs — inget mer."""
    from pydantic import BaseModel, Field, create_model
    from typing_extensions import Literal

    fields = {}
    for name in names:
        spec = QUESTIONS[name]
        answer = Literal[tuple(spec["svar"])]  # type: ignore[valid-type]
        item = create_model(
            f"Svar_{name}",
            value=(answer, Field(..., description=spec["fraga"])),
            confidence=(Literal["hog", "medel", "lag"],
                        Field(..., description="Hur säker avläsningen är.")),
            evidence=(str, Field(..., description="Vad på bilden som visar det, "
                                                  "kort.")),
            __base__=BaseModel,
        )
        fields[name] = (item, Field(..., description=spec["fraga"]))
    return create_model("Attributsvar", __base__=BaseModel, **fields)


#: Svarscache på disk. Nyckeln är (modell, bilder, frågor, ledtråd) — allt som
#: kan ändra svaret. Finns för att omkörningar av en mätning inte ska kosta om.
#: Under bygget kördes samma mätning fyra gånger innan den var rätt; utan cache
#: hade tre av dem varit betald upprepning av identiska anrop.
CACHE_DIR = Path(".cache/vision")


def _cache_key(model: str, images: Sequence[bytes], names: Sequence[str],
               hint: str) -> str:
    digest = hashlib.sha256()
    digest.update(model.encode())
    digest.update(b"\x00".join(sorted(n.encode() for n in names)))
    digest.update(hint.encode())
    for blob in images:
        digest.update(hashlib.sha256(blob).digest())
    return digest.hexdigest()


def _cache_read(key: str) -> Optional[dict]:
    path = CACHE_DIR / key[:2] / f"{key}.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _cache_write(key: str, payload: dict) -> None:
    path = CACHE_DIR / key[:2] / f"{key}.json"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False))
    except OSError as exc:  # cachen får aldrig fälla ett svar
        log.debug("kunde inte cacha: %s", exc)


def _client():
    """Klienten, mot OpenAI eller mot en protokollkompatibel gateway.

    Lovables gateway talar samma protokoll och serverar `google/gemini-2.5-flash`.
    Att byta leverantör är därför en konfigändring, inte en ombyggnad — men
    modellen som mäts måste alltid redovisas, eftersom en L3-siffra utan
    modellnamn inte betyder något.
    """
    from openai import OpenAI

    kwargs = {}
    if config.AI_BASE_URL:
        kwargs["base_url"] = config.AI_BASE_URL
    if config.AI_API_KEY:
        kwargs["api_key"] = config.AI_API_KEY
    return OpenAI(**kwargs)


def _call_edge(names: Sequence[str], images: Sequence[bytes],
               media_types: Sequence[str], hint: str, model: Optional[str]):
    """Anropar den egna edge-funktionen i stället för leverantören direkt.

    Skälet är att Lovables nyckel inte går att läsa ut ur Lovable Cloud. Anropet
    måste därför ske på servern, och mätskriptet talar med vår egen funktion i
    stället. Frågorna skickas med — funktionen har medvetet ingen egen
    uppfattning om möbeln, så det är L3:s frågor som ställs.
    """
    import urllib.error
    import urllib.request

    payload = {
        "images": [
            f"data:{media};base64," + base64.standard_b64encode(blob).decode()
            for blob, media in zip(images, media_types)
        ],
        "questions": [
            {"id": n, "text": QUESTIONS[n]["fraga"],
             "answers": list(QUESTIONS[n]["svar"])}
            for n in names
        ],
        "hint": hint or "",
        "model": model or config.VISION_EDGE_MODEL,
    }
    request = urllib.request.Request(
        config.VISION_EDGE_URL,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "x-attribute-vision-token": config.VISION_EDGE_TOKEN or "",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:300].decode(errors="replace")
        raise RuntimeError(f"edge {exc.code}: {detail}") from exc

    usage = body.get("usage") or {}
    tokens = int(usage.get("total_tokens") or 0)
    for item in body.get("dropped") or []:
        log.info("L3 edge förkastade %s: %r", item.get("id"), item.get("value"))
    if body.get("raw"):
        log.info("L3 edge rått svar: %s", str(body["raw"])[:220])
    return body.get("answers") or {}, tokens, "edge"


def _call(client, names: Sequence[str], content: list, model: Optional[str]):
    """Anropar modellen. Strikt schema först, fritt JSON som fallback.

    OpenAI garanterar att svaret följer schemat. Gateways gör det inte alltid —
    Vips-appens edge functions använder `json_object`, alltså fritt JSON. Läget
    `auto` provar strikt och faller tillbaka vid schemafel, så samma kod
    fungerar mot båda. Fallbacken validerar svaret själv, eftersom garantin då
    saknas.
    """
    name = model or config.VARIANT_MODEL
    if config.AI_STRUCTURED_MODE in ("auto", "strict"):
        try:
            completion = client.chat.completions.parse(
                model=name,
                messages=[{"role": "user", "content": content}],
                response_format=_build_schema(names),
            )
            return completion.choices[0].message.parsed, completion, "strict"
        except Exception as exc:  # noqa: BLE001
            if config.AI_STRUCTURED_MODE == "strict" or _is_fatal(exc):
                raise
            log.info("Strikt schema avvisades (%s), provar fritt JSON",
                     str(exc)[:120])

    instruction = {
        "type": "text",
        "text": ("Svara ENBART med ett JSON-objekt, utan förklarande text och "
                 "utan kodstaket. En nyckel per fråga: "
                 + ", ".join(
                     f'"{n}": {{"value": <ett av {list(QUESTIONS[n]["svar"])}>, '
                     f'"confidence": <"hog"|"medel"|"lag">, "evidence": <kort text>}}'
                     for n in names)),
    }
    messages = [{"role": "user", "content": content + [instruction]}]

    # Tre led, eftersom leverantörerna stöder olika mycket: strikt schema (OpenAI),
    # json_object (de flesta gateways), och ren text (minsta gemensamma nämnare).
    # Det sista ledet finns för att Googles OpenAI-kompatibla endpoint inte
    # garanterat accepterar `response_format` för alla modeller, och ett avvisat
    # fält ska inte kosta hela mätningen.
    try:
        completion = client.chat.completions.create(
            model=name, messages=messages,
            response_format={"type": "json_object"})
        mode = "json_object"
    except Exception as exc:  # noqa: BLE001
        if _is_fatal(exc):
            raise
        log.info("json_object avvisades (%s), provar ren text", str(exc)[:120])
        completion = client.chat.completions.create(model=name, messages=messages)
        mode = "text"

    return _parse_json(completion.choices[0].message.content), completion, mode


#: Fel som INTE går över av att svarsformatet ändras. Att prova nästa läge på ett
#: sådant fel kostar bara fler anrop — ett felstavat modellnamn brände tre anrop
#: per fråga innan den här spärren fanns.
_FATAL = ("404", "401", "403", "429", "not_found", "NOT_FOUND", "invalid_api_key",
          "permission", "quota", "RESOURCE_EXHAUSTED", "insufficient_quota")


def _is_fatal(exc: Exception) -> bool:
    """Är felet något som ett annat svarsformat omöjligt kan lösa?"""
    status = getattr(exc, "status_code", None)
    if status in (401, 403, 404, 429):
        return True
    text = str(exc)
    return any(sign in text for sign in _FATAL)


def _parse_json(raw: Optional[str]) -> dict:
    """Plockar ut JSON-objektet ur ett svar som kan innehålla kodstaket.

    Utan schemagaranti kommer svaret ibland som ```json ... ``` eller med en
    inledande mening. Att kräva rent JSON vore att kasta bort giltiga svar.
    """
    import json as _json
    import re as _re

    text = (raw or "").strip()
    if not text:
        return {}
    fence = _re.search(r"```(?:json)?\s*(.+?)```", text, _re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        return _json.loads(text)
    except ValueError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                return _json.loads(text[start:end + 1])
            except ValueError:
                pass
    log.info("L3: kunde inte tolka svaret som JSON")
    return {}


def _prompt(names: Sequence[str], base: str, hint: str) -> str:
    lines = [
        "Du tittar på foton av en enda möbel som ska prissättas.",
        f"Möbeltypen är känd på grov nivå: {base}.",
        "",
        "Svara på varje fråga nedan utifrån vad du FAKTISKT SER. Om bilderna "
        "inte visar det, svara 'gar_inte_se'. Det svaret är alltid bättre än en "
        "gissning — ett felaktigt ja flyttar priset åt fel håll.",
        "",
    ]
    for i, name in enumerate(names, 1):
        lines.append(f"{i}. {QUESTIONS[name]['fraga']}")
    if hint:
        lines += ["", f"Annonstexten säger: {hint!r}. Använd den som ledtråd men "
                      "låt den aldrig överrida vad du ser."]
    return "\n".join(lines)


def ask(
    images: Sequence[bytes],
    attrs: Attributes,
    media_types: Optional[Sequence[str]] = None,
    hint: str = "",
    model: Optional[str] = None,
    client: object = None,
    min_impact: int = MIN_IMPACT,
    use_cache: bool = True,
) -> dict:
    """Frågar vision-modellen om de okända, prisviktiga attributen.

    Returnerar diagnostik. Attributen skrivs in i `attrs` via källhierarkin, så
    ingenting L3 säger kan skriva över text, prior eller användare.

    **Alla undantag fångas.** Ett dött API ska sänka L3, aldrig prissvaret.
    """
    names = wanted(attrs, min_impact)
    if not names:
        return {"method": "inget_att_fraga"}
    if not images:
        return {"method": "ingen_bild", "wanted": list(names)}

    try:
        from openai import OpenAI
    except ImportError:
        log.info("L3 hoppas över: paketet 'openai' saknas")
        return {"method": "openai_saknas", "wanted": list(names)}

    media_types = list(media_types or ()) or ["image/jpeg"] * len(images)
    content: List[dict] = [{
        "type": "text",
        "text": _prompt(names, str(attrs.get("base")), hint),
    }]
    for blob, media in zip(images, media_types):
        content.append({"type": "image_url", "image_url": {"url":
            f"data:{media};base64," + base64.standard_b64encode(blob).decode()}})

    # Modellnamnet måste spegla vem som FAKTISKT svarade. Går anropet via
    # edge-funktionen är det dess modell som gäller, inte VARIANT_MODEL — och en
    # L3-siffra tillskriven fel modell är värdelös.
    use_edge = bool(config.VISION_EDGE_URL) and client is None
    model_name = model or (config.VISION_EDGE_MODEL if use_edge
                           else config.VARIANT_MODEL)
    key = _cache_key(model_name, images, names, hint)
    cached = _cache_read(key) if use_cache else None
    if cached is not None:
        parsed, completion, mode = cached["answers"], None, cached.get("mode", "cache")
        tokens_used, from_cache = cached.get("tokens", 0), True
    else:
        from_cache = False
        try:
            # En explicit angiven klient vinner över edge-konfigurationen. Utan
            # den regeln skulle en satt VISION_EDGE_URL i .env tysta varje
            # anropare som medvetet valt leverantör — inklusive testerna.
            if config.VISION_EDGE_URL and client is None:
                parsed, tokens_used, mode = _call_edge(
                    names, images, media_types, hint, model)
                completion = None
            else:
                client = client or _client()
                parsed, completion, mode = _call(client, names, content, model)
        except Exception as exc:                  # noqa: BLE001 - avsiktligt brett
            # Krediter, kvot, timeout, schemafel — alla ska hanteras likadant:
            # logga och gå vidare utan L3.
            log.warning("L3 misslyckades, kedjan fortsätter utan: %s", exc)
            return {"method": "fel", "error": str(exc)[:200], "wanted": list(names)}
        if completion is not None:
            usage = getattr(completion, "usage", None)
            tokens_used = int(getattr(usage, "total_tokens", 0) or 0)

    answers, written = {}, []
    for name in names:
        item = parsed.get(name) if isinstance(parsed, dict) else getattr(parsed, name, None)
        if item is None:
            continue
        if not isinstance(item, dict):
            item = {"value": getattr(item, "value", None),
                    "confidence": getattr(item, "confidence", "lag"),
                    "evidence": getattr(item, "evidence", None)}
        if item.get("value") not in QUESTIONS[name]["svar"]:
            # Fritt JSON kan svara vad som helst. Ett värde utanför svarsrymden
            # är inte ett svar utan brus, och behandlas som "vet inte".
            log.info("L3: ogiltigt svar på %s: %r", name, item.get("value"))
            continue
        answers[name] = {"value": item["value"],
                         "confidence": item.get("confidence", "lag"),
                         "evidence": item.get("evidence")}
        value = _translate(name, item["value"])
        if value is None:
            continue
        confidence = _CONFIDENCE.get(item.get("confidence"), 0.4)
        if attrs.set(name, value, "vision", confidence, item.get("evidence")):
            written.append(name)

    if use_cache and not from_cache and answers:
        # Råsvaret cachas, inte de tolkade attributen: ändras översättningen
        # eller svarsrymden ska cachen fortfarande gå att använda.
        #
        # TOMMA svar cachas aldrig. En serverbugg gjorde att 14 av 18 anrop kom
        # tillbaka utan attribut; hade de cachats skulle omkörningen efter
        # rättningen ha återanvänt felet i stället för att fråga på nytt — och
        # felet hade sett permanent ut.
        _cache_write(key, {"answers": _plain(parsed), "mode": mode,
                           "tokens": tokens_used})
    return {
        "method": "svar",
        "asked": list(names),
        "written": written,
        "answers": answers,
        "images": len(images),
        "mode": mode,
        "model": model_name,
        "cached": from_cache,
        "tokens": 0 if from_cache else tokens_used,
    }


def _plain(parsed) -> dict:
    """Modellsvaret som vanliga dict:ar, så det går att serialisera."""
    if isinstance(parsed, dict):
        return parsed
    out = {}
    for name in QUESTIONS:
        item = getattr(parsed, name, None)
        if item is not None:
            out[name] = {"value": getattr(item, "value", None),
                         "confidence": getattr(item, "confidence", None),
                         "evidence": getattr(item, "evidence", None)}
    return out


def _translate(name: str, raw: str):
    """Modellens svar till attributvärde. `gar_inte_se` blir None — okänt."""
    if raw == "gar_inte_se":
        return None
    if name in ("corner", "chaise"):
        return raw == "ja"
    if name == "seats":
        return int(raw)
    if name == "set_items":
        count = int(raw)
        return count if count > 0 else 0
    if name == "storage_kind":
        return _STORAGE.get(raw)
    return raw
