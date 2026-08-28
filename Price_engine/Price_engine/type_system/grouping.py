"""Grupperingen: vilka annonser som hamnar i samma priscell.

Problemet är inte medianen — det är hinken. Tre olika artiklar låg i cellen
"Madison": en matta för 200 kr, en Mio-soffa för ~3 000 och en Swedese-soffa för
73 000. Spridningen är inte prisvariation utan tre produkter.

**Metoden är tokeniserad mängdmatchning.** Rubriken normaliseras till en mängd
tokens och medlemskap testas. Ordföljden varierar fritt — "Mio Matta Madison",
"Matta Madison från Mio" och "Madison matta, Mio, 160x230" är samma sak — och en
positionsbaserad regex hade missat två av tre.

Det är säkert **just för att rubrikerna är korta** (105-160 tecken). I längre
text hade mängdmatchning gett falska träffar.

**Delsträngsmatchning är förbjuden.** Svenska sammansättningar:

    soffbord    innehåller "soff"  men är ett BORD
    bordslampa  innehåller "bord"  men är en LAMPA
    sangbord    innehåller "sang"  men är ett BORD
    skohylla    innehåller "sko"   men är en HYLLA

Regeln är exakt tokenmatchning mot ordlistan, längsta match vinner: `soffbord`
prövas före `soffa` och `bord`.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Dict, FrozenSet, List, Optional, Set, Tuple

VOCAB_PATH = Path(__file__).resolve().parent.parent / "config" / "vocab.yaml"

#: `3-sits`, `3 sits`, `3sits`, `3 sitts`, `tresits` -> `3-sits`
_SEATS = re.compile(r"\b(\d+)\s*-?\s*sit(?:s|ts|tsig|sig)?\b")
_SEATS_WORD = re.compile(r"\b(en|ett|tva|två|tre|fyra|fem|sex|sju)\s*-?\s*sit(?:s|ts)\w*\b")
#: `160x230`, `160 x 230`, `160*230` -> `160x230`
_SIZE = re.compile(r"\b(\d{2,4})\s*[x*×]\s*(\d{2,4})\b")
#: Allt utom bokstäver, siffror, bindestreck och plus.
_PUNCT = re.compile(r"[^0-9a-zåäöéèü+\- ]+")
_SPACE = re.compile(r"\s+")

#: Möbeldelar som säljs separat. En sektion är inte en hel möbel.
_SECTION_WORDS = frozenset({
    "schaslong", "schäslong", "schaslongsektion", "schäslongsektion",
    "schaslongdel", "schäslongdel", "divandel", "hornsektion", "hörnsektion",
    "horndel", "hörndel", "sektion", "sektioner", "modul", "moduler",
    "mittdel", "mittsektion", "armstod", "armstöd", "gavelsektion",
})

#: Typer som i en fråga nästan alltid är TILLBEHÖR till något annat, inte
#: produkten. "Lamino med pall" säljer en fåtölj; "Madison med fotpall" en soffa.
#: Att en av dem skulle säljas ensam med ett modellnamn framför är ovanligt nog
#: att regeln lönar sig — och den kräver dessutom en buntkonnektor.
_ACCESSORY_TYPES = frozenset({"fotpall", "pall", "sittpuff", "puff", "ottoman",
                              "dyna", "kudde", "klädsel", "kladsel"})

#: KOMBINATIONSORD — "tillsammans med något annat". Bara dessa får härleda en
#: bunt ur en ensam tillbehörstyp.
#:
#: `bundle_signals` innehåller också ANTALSORD (`par`, `st`, `två`, `tre` ...),
#: och de betyder något helt annat: flera av SAMMA sak. Utan den här
#: uppdelningen blev "PALLAR, 1 par, furu, Nordiska Kompaniet" en bunt — men ett
#: par pallar är två pallar, inte en fåtölj med pall.
_COMBINATION_WORDS = frozenset({
    "med", "+", "och", "samt", "inkl", "inklusive", "tillhorande",
    "tillhörande", "matchande", "medfoljer", "medföljer", "ingar", "ingår",
    "plus", "bonus", "extra",
})

_NUMBER_WORDS = {"en": 1, "ett": 1, "tva": 2, "två": 2, "tre": 3, "fyra": 4,
                 "fem": 5, "sex": 6, "sju": 7}


@lru_cache(maxsize=1)
def vocab() -> dict:
    import yaml

    return yaml.safe_load(VOCAB_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _type_lookup() -> Tuple[Dict[str, str], Tuple[str, ...]]:
    """token -> produkttyp, plus orden sorterade med längsta först.

    Sorteringen är hela skyddet mot sammansättningar: `soffbord` måste prövas
    före `bord`, annars blir varje soffbord ett bord och varje bordslampa likaså.
    """
    table: Dict[str, str] = {}
    for kind, words in vocab()["product_types"].items():
        for word in words:
            table[word] = kind
    ordered = tuple(sorted(table, key=len, reverse=True))
    return table, ordered


@lru_cache(maxsize=1)
def _signals() -> Dict[str, FrozenSet[str]]:
    v = vocab()
    return {
        name: frozenset(v[name])
        for name in ("bundle_signals", "accessory_signals", "comparison_signals",
                     "low_price_signals", "high_price_signals")
    }


def _fold(text: str) -> str:
    """ASCII-vikt kopia, ENBART för fuzzy-matchning av felstavningar."""
    import unicodedata

    return "".join(c for c in unicodedata.normalize("NFKD", text)
                   if not unicodedata.combining(c))


def normalise(title: str) -> str:
    """Steg 1: rubriken till normaliserad text. å/ä/ö behålls."""
    if not title:
        return ""
    # HTML-entiteter FÖRST. Annars blir `&amp;` ordet "amp", som därmed blev ett
    # "distinktivt modellord" i 13 759 rader. Samma sak med &quot; och &lt;.
    text = html.unescape(str(title)).lower()
    text = _SEATS_WORD.sub(
        lambda m: f"{_NUMBER_WORDS.get(m.group(1), '')}-sits", text)
    text = _SEATS.sub(lambda m: f"{m.group(1)}-sits", text)
    text = _SIZE.sub(lambda m: f"{m.group(1)}x{m.group(2)}", text)
    # `+` är en tillbehörssignal och måste överleva som egen token.
    text = text.replace("+", " + ")
    text = _PUNCT.sub(" ", text)
    return _SPACE.sub(" ", text).strip()


def tokens(title: str) -> List[str]:
    """Normaliserad rubrik som tokenlista, med pluralformer nedslagna."""
    plural = vocab()["plural_map"]
    out = []
    for token in normalise(title).split():
        out.append(plural.get(token, token))
    return out


@dataclass
class Grouping:
    """Vad rubriken säger om vilken cell annonsen hör hemma i."""

    tokens: List[str] = field(default_factory=list)
    types: List[str] = field(default_factory=list)
    product_type: Optional[str] = None
    product_type_source: str = "none"        # explicit | majoritet | none
    product_type_confidence: Optional[float] = None
    is_bundle: bool = False
    #: Rubriken har ett buntord ("med", "+", "och") men bara EN utskriven typ.
    #: "Mio Madison med fotpall" nämner bara fotpallen — soffan är implicit i
    #: modellnamnet. Räkningen av utskrivna typer kan därför inte ensam avgöra
    #: bunt. Löses i majoritetssteget, där modellens vanliga typ är känd.
    has_bundle_connector: bool = False
    #: Bunten härleddes ur konnektor + tillbehörsord, inte ur två
    #: utskrivna typer. Redovisas så att en granskare ser skillnaden.
    bundle_from_connector: bool = False
    is_accessory_only: bool = False
    #: En LÖS schäslongsektion är en del av en modulsoffa, inte en soffa.
    #: Sätts bara när inget möbelord finns i rubriken — se classify().
    is_section: bool = False
    is_comparison: bool = False
    is_giveaway: bool = False
    is_damaged: bool = False
    mentions_retail_price: bool = False
    seats: Optional[int] = None
    size: Optional[str] = None

    @property
    def excluded(self) -> bool:
        """Ska raden hållas UTANFÖR produktens priscell?

        En klädsel till Ektorp är inte en Ektorp, och en "liknande Lamino" är
        inte en Lamino. Båda raderas aldrig — de flyttas till egen cell.
        """
        return self.is_accessory_only or self.is_comparison or self.is_section


def classify(title: str) -> Grouping:
    """Steg 3: räkna produkttyper och sätt flaggorna.

    Antalet DISTINKTA produkttyper avgör:

        0   typen okänd, går vidare till majoritetstilldelning
        1   ren produkt
        2+  bunt eller tillbehör, egen cell, blandas aldrig med basprodukten

    Det löser båda Madison-felen utan specialfall: "Mio Matta Madison" har en
    typ (matta) och hamnar i mattcellen, "Mio Madison med fotpall" har två och
    hamnar i en buntcell.
    """
    table, ordered = _type_lookup()
    signal = _signals()
    toks = tokens(title)
    seen = set(toks)

    # Längsta match först. Ett token får bara räknas en gång, annars blir
    # `soffbord` både soffbord och bord.
    used: Set[str] = set()
    found: List[str] = []
    for word in ordered:
        if word in seen and word not in used:
            found.append(table[word])
            used.add(word)
    types = list(dict.fromkeys(found))

    result = Grouping(tokens=toks, types=types)
    # Sektionsord UTAN möbelord. "Madison Schäslong" är en lös sektion;
    # "Madison soffa med schäslong" är en HEL modulsoffa med divandel.
    #
    # Utan villkoret utlöste regeln på 34 rader i Madison-cellen, varav 28 var
    # hela soffor — inklusive cellens dyraste på 20 000 kr. Med villkoret: 6
    # äkta sektioner. Ett ord räcker inte; det är ordets sammanhang som avgör.
    result.is_section = bool(seen & _SECTION_WORDS) and not types
    result.is_accessory_only = bool(seen & signal["accessory_signals"])
    result.is_comparison = bool(seen & signal["comparison_signals"])
    result.is_giveaway = bool(seen & signal["low_price_signals"]
                              & {"bortskankes", "bortskänkes", "skankes",
                                 "skänkes", "gratis"})
    result.is_damaged = bool(seen & signal["low_price_signals"])
    result.mentions_retail_price = bool(seen & signal["high_price_signals"])
    result.is_bundle = len(types) >= 2
    result.has_bundle_connector = bool(seen & signal["bundle_signals"])

    # BUNTKONNEKTOR PÅ EN FRÅGA. "Lamino med pall" nämner bara EN typ — pallen —
    # och huvudprodukten ligger i modellnamnet. Utan den här regeln läses frågan
    # som "jag säljer en pall": cellfiltret kastar alla fåtölj+pall-annonser som
    # buntar, och svaret blir 2 000 kr i stället för 8 000.
    #
    # I korpusen löses samma sak av majoritetstilldelningen — modellens andra
    # annonser avslöjar vad Lamino brukar vara. En FRÅGA är en ensam rad och kan
    # inte rösta, så konnektorn plus ett tillbehörsord får räcka som bevis.
    #
    # Två spärrar. Typen måste vara ett TILLBEHÖR — "matbord och stolar" nämner
    # två fullvärdiga möbler och var redan en bunt, "soffa med divan" ska inte
    # bli en bunt bara för att `med` står där. Och ordet måste vara ett
    # KOMBINATIONSORD, inte ett antalsord: "PALLAR, 1 par" är två pallar, inte
    # en fåtölj med pall.
    if (bool(seen & _COMBINATION_WORDS) and len(types) == 1
            and types[0] in _ACCESSORY_TYPES):
        result.is_bundle = True
        result.bundle_from_connector = True

    if len(types) == 1:
        result.product_type = types[0]
        result.product_type_source = "explicit"
        result.product_type_confidence = 1.0

    for token in toks:
        if token.endswith("-sits"):
            head = token.split("-")[0]
            if head.isdigit() and 1 <= int(head) <= 8:
                result.seats = int(head)
        elif "x" in token and token.replace("x", "").isdigit():
            result.size = token
    return result


# --------------------------------------------------------------------------
# Steg 3B — majoritetstilldelning när typen inte står utskriven
# --------------------------------------------------------------------------
#: Minst så här många röstande rader, annars förblir typen okänd.
MIN_VOTERS = 10
#: Minsta majoritetsandel. 55/45 är ingen majoritet, det är brus.
MIN_MAJORITY = 0.70


def majority_types(frame, key_columns=("brand_key", "model_key")) -> Dict[tuple, tuple]:
    """Vanligaste utskrivna typen per märke+modell. (typ, andel, röster).

    **Endast rader där typen står utskriven får rösta.** Låter man gissade rader
    rösta propagerar ett fel genom hela cellen — den första felgissningen blir
    majoritet och drar med sig resten.

    Buntrader deltar inte, varken som röstande eller mottagare: en annons som
    säljer två saker säger inget om vad basprodukten är.
    """
    import collections

    votes: Dict[tuple, collections.Counter] = collections.defaultdict(
        collections.Counter)
    for row in frame.itertuples():
        if getattr(row, "product_type_source", None) != "explicit":
            continue
        if getattr(row, "is_bundle", False):
            continue
        key = tuple(getattr(row, column) for column in key_columns)
        if any(part is None or part == "" for part in key):
            continue
        votes[key][row.product_type] += 1

    out = {}
    for key, counter in votes.items():
        total = sum(counter.values())
        if total < MIN_VOTERS:
            continue
        kind, count = counter.most_common(1)[0]
        share = count / total
        if share < MIN_MAJORITY:
            continue
        out[key] = (kind, round(share, 3), total)
    return out


def apply_majority(frame, majorities: Dict[tuple, tuple],
                   key_columns=("brand_key", "model_key")):
    """Fyller i typen på rader som saknar den, och löser buntluckan.

    Två saker händer här:

    1. Rader utan utskriven typ ärver märkets+modellens majoritetstyp.
    2. Rader med EN utskriven typ som skiljer sig från majoriteten OCH har ett
       buntord blir buntar. Det fångar "Mio Madison med fotpall", där soffan är
       implicit i modellnamnet och bara fotpallen står skriven — ett fall som
       typräkningen ensam aldrig kan se.
    """
    kinds, sources, confidences, bundles = [], [], [], []
    for row in frame.itertuples():
        key = tuple(getattr(row, column) for column in key_columns)
        majority = majorities.get(key)
        kind = row.product_type
        source = row.product_type_source
        confidence = row.product_type_confidence
        bundle = bool(row.is_bundle)

        if kind is None and majority and not bundle:
            kind, share, _ = majority
            source, confidence = "majoritet", share
        elif (kind is not None and majority and not bundle
              and getattr(row, "has_bundle_connector", False)
              and kind != majority[0]):
            # En utskriven typ som INTE är modellens vanliga, ihop med ett
            # buntord: annonsen säljer basprodukten plus något till.
            bundle = True

        kinds.append(kind)
        sources.append(source)
        confidences.append(confidence)
        bundles.append(bundle)
    return kinds, sources, confidences, bundles


def resolve(frame, key_columns=("brand_key", "model_key")):
    """Hela steg 3B i två pass. Returnerar (typer, källor, konfidenser, buntar).

    Två pass behövs för att bunt och majoritet beror på varandra:

      pass 1  majoritet ur de utskrivna raderna
      pass 2  markera buntar med hjälp av majoriteten
      pass 3  räkna om majoriteten UTAN de nyfunna buntarna

    Utan det sista steget röstar "Mio Madison med fotpall" som `fotpall` innan
    den avslöjas som bunt. Med 15 röstande ändrade det ingenting, men i en cell
    med tio rader hade det kunnat flytta majoriteten — och en felaktig majoritet
    propagerar till varenda gissad rad i cellen.
    """
    provisional = majority_types(frame, key_columns)
    _, _, _, bundles = apply_majority(frame, provisional, key_columns)

    cleaned = frame.copy()
    cleaned["is_bundle"] = bundles
    final = majority_types(cleaned, key_columns)
    return (*apply_majority(cleaned, final, key_columns), final)


# --------------------------------------------------------------------------
# Nyckelbygget — märke först, sedan modellen som SORTERAD MÄNGD
# --------------------------------------------------------------------------
@lru_cache(maxsize=1)
def _brand_lookup() -> Dict[str, str]:
    table = {}
    for brand, words in vocab().get("brands", {}).items():
        for word in words:
            table[word] = brand
    return table


def brand_of(title_tokens) -> Optional[str]:
    """Märket ur rubriken. `brand_norm` är tomt i 97,7 % av korpusen.

    Märket står i titeln, inte i kolumnen: 603 Madison-rader nämner "mio" men
    bara 74 har `brand_norm` satt.
    """
    table = _brand_lookup()
    for token in title_tokens:
        if token in table:
            return table[token]
    return None


@lru_cache(maxsize=1)
def model_names() -> Tuple[Dict[str, FrozenSet[str]], FrozenSet[str]]:
    """Vitlistan som (märke -> ord)-par plus märkeslösa ord.

    Par i stället för lösa ord löser `stand`: det är ett HAY-modellnamn när HAY
    står i annonsen, och ett engelskt vardagsord annars. Med lösa ord uppstod
    cellen `|okand|stand` där ett Svenskt Tenn-skåp för 115 000 kr låg bredvid
    ett gymställ för 5 000. Med par kan den cellen inte uppstå alls.
    """
    import json

    path = VOCAB_PATH.parent / "model_names.json"
    if not path.is_file():
        return {}, frozenset()
    data = json.loads(path.read_text(encoding="utf-8"))
    pairs = {b: frozenset(w) for b, w in (data.get("pairs") or {}).items()}
    return pairs, frozenset(data.get("brandless") or ())


def model_key(title_tokens, known_models=None, brand: Optional[str] = None) -> str:
    """Modellnyckeln som SORTERAD MÄNGD av distinktiva ord.

    Att ta det första distinktiva ordet gör nyckeln ordningsberoende: "Mio
    Madison" fick nyckeln `mio` och "Madison Mio" fick `madison`, så samma
    produkt hamnade i olika celler. Att ta det *mest* distinktiva ordet är inte
    heller stabilt — vilket ord som är ovanligast ändrar sig när datan växer.

    En sorterad mängd är oberoende av både ordföljd och korpusens storlek.
    Märkesorden tas bort först, annars blir märket en del av modellnyckeln.
    """
    # VITLISTA, inte svartlista, och som (märke, ord)-PAR. Ett ord räknas som
    # modellnamn bara tillsammans med sitt märke — allt annat kastas.
    if known_models is not None:
        allowed = known_models
    else:
        pairs, brandless = model_names()
        if brand is None:
            brand = brand_of(title_tokens)
        allowed = set(brandless) | set(pairs.get(brand or "", ()))
    brands = _brand_lookup()
    words = {t for t in title_tokens if t in allowed and t not in brands}
    return " ".join(sorted(words))


# --------------------------------------------------------------------------
# Cellnycklarna — beräknas på listings, inte i en sidofil
# --------------------------------------------------------------------------
def config_key(seats, size) -> str:
    """Konfigurationsdelen av cellnyckeln. Samma funktion för korpus och fråga."""
    parts = []
    if seats is not None and seats == seats:          # inte NaN
        parts.append(str(int(seats)))
    if size is not None and size == size and str(size):
        parts.append(str(size))
    return "-".join(parts)


def assign_cells(names, brand_norm=None) -> dict:
    """Cellnycklar och flaggor för en kolumn med annonsrubriker.

    Ligger här och inte i ett byggskript för att `data_loader` ska kunna lägga
    kolumnerna direkt på korpusen. En separat cellfil måste hållas i synk med
    listings, och två sanningar om samma rader glider isär tyst — färskhets-
    och skickfiltren läser kolumner som cellfilen inte hade, och en join på
    (titel, pris) är inte unik.
    """
    import pandas as pd

    pairs, brandless = model_names()
    records, token_lists = [], []
    for title in names:
        g = classify(title or "")
        token_lists.append(g.tokens)
        records.append(g)

    brands = [brand_of(t) or "" for t in token_lists]
    allowed_cache: Dict[str, set] = {}
    models = []
    for toks, brand in zip(token_lists, brands):
        allowed = allowed_cache.get(brand)
        if allowed is None:
            allowed = set(brandless) | set(pairs.get(brand, ()))
            allowed_cache[brand] = allowed
        models.append(model_key(toks, allowed))

    out = {
        "product_type": [r.product_type for r in records],
        "product_type_source": [r.product_type_source for r in records],
        "product_type_confidence": [r.product_type_confidence for r in records],
        "is_bundle": [r.is_bundle for r in records],
        "has_bundle_connector": [r.has_bundle_connector for r in records],
        "is_accessory_only": [r.is_accessory_only for r in records],
        "is_section": [r.is_section for r in records],
        "is_comparison": [r.is_comparison for r in records],
        "is_giveaway": [r.is_giveaway for r in records],
        "is_damaged": [r.is_damaged for r in records],
        "mentions_retail_price": [r.mentions_retail_price for r in records],
        "cell_seats": [r.seats for r in records],
        "cell_size": [r.size for r in records],
        "brand_key": brands,
        "model_key": models,
    }
    frame = pd.DataFrame(out)

    kinds, sources, confidences, bundles, _ = resolve(frame)
    frame["product_type"] = kinds
    frame["product_type_source"] = sources
    frame["product_type_confidence"] = confidences
    frame["is_bundle"] = bundles

    frame["cell_excluded"] = (frame["is_accessory_only"] | frame["is_comparison"]
                              | frame["is_section"])
    # Sitsantalet MÅSTE formateras som heltal. En kolumn av Optional[int] blir
    # float64 i pandas, och str(3.0) ger "3.0" medan frågesidan bygger "3" —
    # `full`-nivån kunde därmed aldrig matcha för en möbel med sitsantal, och
    # varje sådan fråga föll tyst ned till `utan_konfiguration`.
    frame["config_key"] = [config_key(s, z)
                           for s, z in zip(frame["cell_seats"], frame["cell_size"])]
    frame["cell_type"] = [
        (f"bunt:{t}" if t else "bunt:okand_bastyp") if b else (t or "okand")
        for t, b in zip(frame["product_type"], frame["is_bundle"])]
    frame["cell_full"] = (frame["brand_key"] + "|" + frame["cell_type"] + "|"
                          + frame["model_key"] + "|" + frame["config_key"])
    frame["cell_no_config"] = (frame["brand_key"] + "|" + frame["cell_type"]
                               + "|" + frame["model_key"])
    # Buntar krymper aldrig förbi modellnivån.
    frame["cell_brand_type"] = [
        nc if b else f"{br}|{k}" for nc, b, br, k in zip(
            frame["cell_no_config"], frame["is_bundle"],
            frame["brand_key"], frame["cell_type"])]
    frame["cell_type_only"] = [
        nc if b else k for nc, b, k in zip(
            frame["cell_no_config"], frame["is_bundle"], frame["cell_type"])]
    return frame
