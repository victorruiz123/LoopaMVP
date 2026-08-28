"""Bilden skriver de ord användaren inte skriver.

**Problemet.** Ingen skriver "u-soffa" eller "+ fotpall" i ett sökfält. De skriver
"Mio Friday" och "Lamino". Men motorns hela maskineri — cellfiltret, typfiltret,
buntlogiken — hänger på just de orden. En Lamino med pall värderas som en pall
utan dem, och en U-soffa som en vanlig soffa.

**Lösningen.** En bild-LLM väljer ur lexikonets EGNA ordlistor och skriver in dem
i frågan. Resten av motorn rörs inte: den ser en fråga som råkar innehålla
"u-soffa" och gör vad den alltid gjort.

    "Mio Friday" + bild  ->  "Mio Friday u-soffa"
    "Lamino" + bild      ->  "Lamino + fotpall"

**Slutna listor, inte fritext.** Modellen får välja bland orden som finns i
`config/vocab.yaml`. Skriver den "L-formad sektionssoffa" kan motorn inte läsa
det, och hela vinsten uteblir. Listorna kommer ur lexikonet, inte ur prompten —
lägg till ett ord i vocab.yaml och modellen kan välja det.

**Två olika sorters påstående, med olika tillförlitlighet.**

  FORM        vad möbeln ÄR. Syns i bilden. Uppmätt: `corner` 92,3 % rätt när
              modellen svarar (Gemini 2.5 Flash, n=40).
  TILLBEHÖR   vad som INGÅR. Syns INTE i bilden — en pall bredvid fåtöljen kan
              vara med i affären eller inte. Uppmätt på `set_items`: 100 %
              falskt positivt, modellen sa "stolar ingår" om varje bord.

Skillnaden är inte modellens fel utan bildens gräns. Den mätningen gjordes dock
på annonsbilder ur korpusen — auktions- och marknadsplatsfoton av hela rum. En
SÄLJARE som fotograferar sin egen möbel för prissättning fotograferar det hen
säljer, och basfrekvensen är då en annan.

Därför: form skrivs in rakt av, tillbehör märks som bildhärledda och redovisas
separat i svaret, så att beslutet att lita på dem kan fattas på mätning i stället
för på hopp.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)


def _vocab() -> dict:
    from type_system import grouping

    return grouping.vocab()


def form_words(base: Optional[str] = None) -> List[str]:
    """Formorden modellen får välja bland, ur vocab.yaml.

    Utan `base` returneras alla. Med `base` bara den familjens — en soffa ska
    inte kunna beskrivas som "skrivbord".
    """
    words = _vocab().get("form_words") or {}
    if base and base in words:
        return list(words[base])
    # Alla nycklar som börjar med _ är dokumentation, inte ordfamiljer. Förut
    # hoppades bara "_note" över, vilket gjorde att _guidance-dictens NYCKLAR
    # lästes som formord. Det gick obemärkt så länge de nycklarna råkade vara
    # giltiga formord — tills en förklaringsrad lades till där.
    return [w for key, group in words.items() if not key.startswith("_")
            for w in group]


def base_family(*hints: Optional[str]) -> Optional[str]:
    """Vilken ordfamilj hör möbeln till — "soffa", "bord", "stol", "forvaring"?

    Utan familj får modellen välja bland ALLA nitton formorden, alltså även
    "matbord" och "skrivbord" när den tittar på en soffa. Det är både långsammare
    och sämre: mätningen som valde modell kördes med familjen satt.

    Tar emot både varianter från anroparen ("soffa") och typer ur texten
    ("fatolj", ASCII-vikt), och matchar mot familjenamn såväl som mot orden i
    familjerna — "fatolj" är ett ORD i familjen "stol", inte ett familjenamn.
    """
    from type_system.synonyms import fold

    words = _vocab().get("form_words") or {}
    families = {key: group for key, group in words.items()
                if not key.startswith("_")}
    for hint in hints:
        if not hint:
            continue
        needle = fold(str(hint))
        for key in families:
            if fold(key) == needle:
                return key
        for key, group in families.items():
            if any(fold(w) == needle for w in group):
                return key
    return None


def accessory_words() -> List[str]:
    return list((_vocab().get("accessory_words") or {}).get("words") or [])


PROMPT = """Du ser ett foto av en möbel som ska säljas begagnat.

Svara på två frågor. Använd ENDAST orden i listorna — inga egna formuleringar.

FRÅGA 1: Vilken form har möbeln?
Välj EXAKT ett ord ur denna lista, eller "vet inte":
{forms}

Titta särskilt efter divan, schäslong och hörn — det är den skillnad som
betyder mest för priset och den syns nästan alltid på bilden:
{guidance}

AVGÖRANDE: en divan eller schäslong SITTER IHOP med soffan — samma stomme, ingen
egen ryggdel, ingen glipa mellan den och sitsen. En puff eller fotpall står LÖST
på egna ben och går att flytta undan. Står den löst är soffan fortfarande "rak
soffa" — skriv då pallen som tillbehör i fråga 2 i stället.

Räkna sedan soffans ändar: skjuter sitsen ut i BÅDA ändarna är svaret u-soffa,
i bara en ände hörnsoffa eller divansoffa, i ingen ände rak soffa.

FRÅGA 2: Vilka av dessa föremål hör IHOP MED huvudmöbeln i bilden?
Välj noll eller flera ur denna lista:
{accessories}

Viktigt om fråga 2: svaret skrivs in i annonsens sökord som "ingår", så svara
bara när föremålet rimligen säljs TILLSAMMANS med möbeln. Kravet är att det ska
se ut att höra till samma möbel: samma tyg, läder, träslag eller serie.

  En fotpall i samma läder som fåtöljen -> svara "fotpall".
  En fotpall i ett helt annat material, eller möbler som bara står i rummet
  (soffbord, sidobord, lampa, matta, växter) -> svara INGENTING.

Är du osäker på om det hör ihop: svara ingenting. Ett felaktigt tillbehör
förvanskar priset mer än ett missat.

Regler:
- Använd bara ord ur listorna, ordagrant.
- Hitta inte på. "vet inte" och tom lista är korrekta svar.
- Bedöm ALDRIG pris, skick eller värde.

Svara som JSON:
{{"form": "<ord ur lista 1 eller 'vet inte'>",
  "visible_accessories": ["<ord ur lista 2>", ...],
  "confidence": 0.0-1.0,
  "evidence": "<vad du ser, max 10 ord>"}}
"""


def guidance() -> Dict[str, str]:
    """Vad varje formord betyder, ur vocab.yaml.

    Ligger i lexikonet och inte i prompten så att en ny formvariant kan
    beskrivas utan kodändring — samma princip som ordlistorna själva.
    """
    return {k: v for k, v in
            ((_vocab().get("form_words") or {}).get("_guidance") or {}).items()}


def build_prompt(base: Optional[str] = None) -> str:
    """Prompten med lexikonets ordlistor och förklaringar inlagda."""
    forms = form_words(base)
    notes = guidance()
    lines = [f"  {w}: {notes[w]}" for w in forms if w in notes]
    return PROMPT.format(
        forms="\n".join(f"  - {w}" for w in forms) or "  (inga)",
        guidance="\n".join(lines) or "  (ingen vägledning)",
        accessories="\n".join(f"  - {w}" for w in accessory_words()) or "  (inga)",
    )


def parse(payload: Any, base: Optional[str] = None) -> dict:
    """Modellens svar, filtrerat mot ordlistorna.

    Ett ord utanför listan KASTAS. Motorn kan inte läsa det, och att skriva in
    det i frågan hade smalnat sökningen på ett ord ingen annons innehåller.
    """
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            log.warning("Formsvaret var inte JSON")
            return {"form": None, "accessories": [], "rejected": []}
    if not isinstance(payload, dict):
        return {"form": None, "accessories": [], "rejected": []}

    allowed_forms = {w.lower() for w in form_words(base)}
    allowed_acc = {w.lower() for w in accessory_words()}

    raw_form = (payload.get("form") or "").strip().lower()
    form = raw_form if raw_form in allowed_forms else None


    accessories, rejected = [], []
    if raw_form and form is None and raw_form not in ("vet inte", ""):
        rejected.append(raw_form)
    for item in payload.get("visible_accessories") or []:
        word = str(item).strip().lower()
        (accessories if word in allowed_acc else rejected).append(word)

    return {
        "form": form,
        "accessories": accessories,
        "rejected": rejected,
        "confidence": payload.get("confidence"),
        "evidence": payload.get("evidence"),
    }


def enrich(name: str, parsed: dict) -> dict:
    """Skriver in orden i frågan. (ny text, redovisning).

    Formordet läggs till rakt av. Tillbehör skrivs som "+ <ord>", vilket är ett
    kombinationsord i buntlexikonet — det är precis den signal `grouping` behöver
    för att läsa "Lamino + fotpall" som en fåtölj med pall i stället för som en
    lös pall.

    Ord som redan står i frågan läggs inte till igen. Skriver användaren
    "Mio Friday U-soffa" ska bilden inte dubblera ordet.
    """
    text = (name or "").strip()
    lowered = text.lower()
    added: List[str] = []

    form = (parsed or {}).get("form")
    if form and form.lower() not in lowered:
        text = f"{text} {form}".strip()
        added.append(form)

    for word in (parsed or {}).get("accessories") or []:
        if word.lower() not in lowered:
            text = f"{text} + {word}"
            added.append(f"+ {word}")

    return {
        "text": text,
        "added": added,
        "form": form,
        "accessories": list((parsed or {}).get("accessories") or []),
        "rejected": list((parsed or {}).get("rejected") or []),
        "confidence": (parsed or {}).get("confidence"),
        "evidence": (parsed or {}).get("evidence"),
    }


# --------------------------------------------------------------------------
# Anropet. Det som faktiskt frågar modellen.
# --------------------------------------------------------------------------
def _cache_key(image: bytes, base: Optional[str], model: str) -> str:
    import hashlib

    digest = hashlib.sha256(image).hexdigest()[:24]
    # Prompten måste ingå. Ändras ordlistan eller frågan är det gamla svaret
    # inte längre giltigt: när `sidobord` togs bort ur tillbehören hade cachen
    # annars fortsatt servera "+ sidobord" på varje redan sedd bild.
    prompt = hashlib.sha256(build_prompt(base).encode()).hexdigest()[:8]
    return f"{model}:{base or '-'}:{prompt}:{digest}"


_EDGE_HINT = ("Svara utifrån vad som syns i fotot. Vid minsta osäkerhet: "
              "välj 'vet inte' på formen och 'nej' på tillbehören.")

_EDGE_FORM_FRAGA = ("Vilken form har möbeln på bilden? Titta särskilt efter "
                    "divan, schäslong och hörn — det är den skillnad som betyder "
                    "mest för priset. Två divaner/schäslonger = u-soffa, en = "
                    "hörnsoffa eller divansoffa, ingen = rak soffa.")

_EDGE_ACC_FRAGA = ("Syns en {word} som hör IHOP med huvudmöbeln — samma tyg, "
                   "läder, träslag eller serie, så att den rimligen säljs "
                   "tillsammans med den? Möbler som bara står i rummet räknas "
                   "inte. Osäker: svara nej.")

def _ask_edge(image: bytes, base: Optional[str], media_type: str,
              model: Optional[str]) -> dict:
    """Ställer formfrågan via den egna edge-funktionen (Lovable-vägen).

    Skälet till att vägen finns: Lovables nyckel går inte att läsa ut ur Lovable
    Cloud, så anropet måste ske på servern. Edge-funktionen tar frågor med
    FASTA svarsalternativ och returnerar {id: värde} — inget fritt JSON. Formen
    passar rakt in som ett val, och tillbehören blir en ja/nej-fråga per ord.
    Kontraktet är oförändrat; ingen ny serverkod behövs.
    """
    from price_engine import config as cfg
    from type_system import vision_layer

    forms = list(form_words(base)) + ["vet inte"]
    accessories = accessory_words()
    questions = [{"id": "form", "text": _EDGE_FORM_FRAGA, "answers": forms}]
    questions += [
        {"id": f"acc_{word}",
         "text": _EDGE_ACC_FRAGA.format(word=word),
         "answers": ["ja", "nej"]}
        for word in accessories
    ]

    saved = vision_layer.QUESTIONS
    try:
        # _call_edge slår upp frågetexterna i QUESTIONS. Vi lägger våra där
        # tillfälligt i stället för att skriva en andra HTTP-klient.
        vision_layer.QUESTIONS = {
            q["id"]: {"fraga": q["text"], "svar": q["answers"]} for q in questions
        }
        answers, _tokens, _mode = vision_layer._call_edge(
            [q["id"] for q in questions], [image], [media_type],
            _EDGE_HINT, model or cfg.VISION_EDGE_MODEL)
    finally:
        vision_layer.QUESTIONS = saved

    return {
        "form": answers.get("form"),
        "visible_accessories": [
            word for word in accessories
            if str(answers.get(f"acc_{word}", "")).lower() == "ja"
        ],
    }


def ask(image: bytes, base: Optional[str] = None,
        media_type: str = "image/jpeg", client=None,
        model: Optional[str] = None) -> dict:
    """Frågar bild-LLM:en om form och synliga tillbehör.

    Returnerar samma form som `parse`. Vid fel returneras ett tomt svar med
    `error` satt — **ett dött API får aldrig fälla ett prissvar**, och en fråga
    utan bildhjälp är fortfarande en giltig fråga.

    Svaret cachas på bildens hash: samma foto ska inte kosta två anrop, och
    under utveckling körs samma bild om och om igen.
    """
    from price_engine import config as cfg

    # Edge-modellen gäller bara när edge-funktionen faktiskt används. Utan
    # VISION_EDGE_URL går anropet direkt till leverantören i AI_BASE_URL (eller
    # OpenAI), och då är `google/gemini-2.5-flash` ett okänt modell-ID —
    # anropet svarade "invalid model ID" innan den här raden fanns.
    name = model or (cfg.VISION_EDGE_MODEL if cfg.VISION_EDGE_URL
                     else cfg.FORM_VISION_MODEL)
    key = _cache_key(image, base, name)
    cached = _cache_read(key)
    if cached is not None:
        out = parse(cached, base)
        out["cached"] = True
        return out

    # Formatet normaliseras EN gång, före båda vägarna. MIME-typen anroparen
    # påstår används inte: uppladdningsrutan tillåter "image/*", och en iPhone
    # lämnar HEIC som modellen svarar 400 på. Felet syntes bara som en
    # WARNING-rad, så prissvaret kom tillbaka utan formord och såg rätt ut.
    from type_system.image_bytes import to_supported

    image, media_type = to_supported(image)

    def _direct():
        import base64

        from type_system import vision_layer

        payload = base64.b64encode(image).decode("ascii")
        content = [
            {"type": "text", "text": build_prompt(base)},
            {"type": "image_url",
             "image_url": {"url": f"data:{media_type};base64,{payload}"}},
        ]
        cli = client or vision_layer._client()
        completion = cli.chat.completions.create(
            model=name,
            messages=[{"role": "user", "content": content}],
            response_format={"type": "json_object"},
        )
        return completion.choices[0].message.content

    def _edge():
        return _ask_edge(image, base, media_type, model)

    # Är edge-funktionen konfigurerad är den förstahandsvalet: Lovables nyckel
    # går bara att använda där. Annars går anropet direkt till leverantören.
    # Den andra vägen provas när den första faller — slut på krediter, kvot
    # eller nere. Ett dött API får aldrig fälla ett prissvar.
    if cfg.VISION_EDGE_URL:
        routes = [("edge", _edge), ("direkt", _direct)]
    else:
        routes = [("direkt", _direct), ("edge", _edge)]

    raw, used, failures = None, None, []
    for label, call in routes:
        if label == "edge" and not cfg.VISION_EDGE_URL:
            continue                       # ingen edge konfigurerad
        try:
            raw = call()
            used = label
            break
        except Exception as exc:  # noqa: BLE001 — bilden får aldrig fälla priset
            failures.append(f"{label}: {str(exc)[:110]}")
            log.warning("Formlagret misslyckades via %s: %s", label,
                        str(exc)[:160])

    if used is None:
        return {"form": None, "accessories": [], "rejected": [],
                "error": " | ".join(failures)[:200], "model": name}

    _cache_write(key, raw)
    out = parse(raw, base)
    out["route"] = used
    if failures:
        out["fallback_from"] = failures
    out["model"] = name
    out["cached"] = False
    return out


CACHE_DIR = None


def _cache_path(key: str):
    from pathlib import Path

    from price_engine import config as cfg

    root = CACHE_DIR or (Path(cfg.VECTOR_DIR).parent / "form")
    root.mkdir(parents=True, exist_ok=True)
    import hashlib

    return root / f"{hashlib.sha256(key.encode()).hexdigest()[:32]}.json"


def _cache_read(key: str):
    path = _cache_path(key)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    # Ett tomt svar cachas ALDRIG som giltigt — annars gör ett övergående fel
    # att bilden aldrig frågas igen. Samma fälla som vision-cachen gick i.
    if not payload or not payload.get("form"):
        return None
    return payload


def _cache_write(key: str, payload) -> None:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            return
    if not payload or not payload.get("form"):
        return
    try:
        _cache_path(key).write_text(json.dumps(payload, ensure_ascii=False),
                                    encoding="utf-8")
    except Exception:
        log.warning("Formcachen gick inte att skriva", exc_info=True)
