"""Möbeltyp ("variant") — taxonomi, textklassning av annonser, bildklassning.

Modellnamn räcker inte för att prissätta. "Landskrona" är en IKEA-*serie*, inte
en produkt: samma namn bärs av soffa, hörnsoffa, fåtölj och fotpall. Spannet
inom ett modellnamn är stort — 5,5x för Vimle, 5,0x för Kivik och Malm:

    Vimle      bäddsoffa 5 500 kr  ->  fotpall 1 000 kr
    Söderhamn  hörnsoffa 2 000 kr  ->  fotpall   725 kr
    Malm       säng      1 500 kr  ->  hylla     300 kr

Användaren skriver aldrig "fotpall" själv, men ett foto visar det direkt.
Därför: klassificera användarens bild till en variant, och filtrera annonserna
på samma variant.

Två sidor måste dela vokabulär, annars går de inte att joina:

  * annonserna klassas med VARIANT_RULES nedan (ren textmatchning)
  * bilden klassas av en visionmodell som är låst till samma etiketter

Bildklassningen är den enda delen av motorn som anropar en modell. Den är
valfri: utan bild och utan `variant` beter sig prismotorn precis som förut.
"""

from __future__ import annotations

import base64
import logging
import re
from dataclasses import dataclass

import pandas as pd

from . import config

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# Taxonomin — en enda källa för både annonser och bild
# --------------------------------------------------------------------------
# Ordningen ÄR prioriteten: första träffen vinner. Mest specifik först, så att
# "bäddsoffa" inte fastnar på "soffa" och "matbord" inte fastnar på "bord".
# Utan exklusiv tilldelning hamnar "Landskrona 3-sits soffa med divan och
# fotpall" i tre hinkar samtidigt och medianerna blir meningslösa: i den
# överlappande varianten kostade en fotpall lika mycket som en soffa
# (2 500 kr), mot 1 350 kr när tilldelningen görs exklusiv.
VARIANT_RULES: tuple[tuple[str, str], ...] = (
    ("bäddsoffa", r"baddsoffa|badd[- ]soffa|sovsoffa"),
    ("hörnsoffa", r"hornsoffa|horn[- ]soffa|divan|schaslong|schaselong|chaise"),
    # matgrupp FÖRE matbord, och de är två skilda typer sedan Mio Santos
    # avslöjade att sammanslagningen kostar pengar: samma regel fångade både
    # "Matbord Santos" (800 kr) och "Santos matbord och 4 stolar" (3 100 kr),
    # ett spann på 4x inom samma hink. Skiljetecknet är om stolar nämns.
    ("matgrupp", r"matgrupp|matsalsgrupp|matbordsgrupp"
                 r"|(?:mat)?bord\w*\s*(?:och|med|\+|,)\s*\d*\s*(?:st\s*)?stol"
                 r"|\d+\s*stolar\s*(?:och|med|\+)\s*(?:mat)?bord"),
    ("matbord", r"matbord|matsalsbord|koksbord|kokbord"),
    ("soffa", r"soffa|soffor|[2-9][- ]?sits|sits\b|sitsig|seats?\b|couch|canape"),
    ("fotpall", r"fotpall|sittpuff|\bpuff\b|ottoman|\bpall\b|\bpallar\b"),
    ("fåtölj", r"fatolj|karmstol|lastol|lounge[- ]?stol"),
    # stol\b, inte \bstol\b: annars saknar "gungstol" och "trästol" möbelord
    # helt, och ett beskrivande "klädsel i ylle" gör dem till reservdelar.
    ("stol", r"stol\b|stolar\b"),
    # Sänggavlar FÖRE säng, och som egen typ. En stoppad gavel är visuellt en
    # tygrektangel och prismässigt en helt annan vara än en säng — men den
    # säljs för sig, så den hör inte i del/tillbehör. Blandningen förorenade
    # både typrösten och sängmätningen: alla tre positiva säng-par i
    # parmätningen var gavlar, och sängars AUC blev 0,522.
    ("sänggavel", r"sanggavel|sanggavlar|gavel till sang|huvudgavel"),
    ("säng", r"\bsang\b|sangar|sangram|dubbelsang|enkelsang"),
    ("byrå", r"\bbyra\b|byraer|kommod|sengbord|sangbord|nattduksbord"
             r"|sideboard|\bskank\b|skankar"),
    # Sammansättningarna står utskrivna: utan dem saknar annonsen möbelord
    # helt, och då vinner ett beskrivande delord ("3+2 hyllplan") över möbeln.
    # Ett String-hyllsystem för 1 931 kr klassades så som reservdel.
    ("hylla", r"hylla|hyllor|hyllsystem|bokhylla|vitrinskap|\bskap\b|garderob"
              r"|bokskap|linneskap|kladskap|barskap|hornskap"),
    ("spegel", r"spegel|speglar"),
    # Sist och medvetet brett: "bord" fångar soffbord, sidobord och skrivbord.
    # Notera att "soffbord" INTE träffar soffa-regeln ovan (soff-b, inte soffa).
    ("bord", r"bord"),
)

#: Etiketten som används när ingen regel träffar. Annonser i denna hink kan
#: inte uteslutas — de kan vara vad som helst — och behandlas därför särskilt
#: i det relaxade filtret (se pricing.find_listings).
UNKNOWN = "okänd"

# --------------------------------------------------------------------------
# Delar och tillbehör — inte möbler, och får inte prissättas som möbler
# --------------------------------------------------------------------------
# Modellnamnet bärs inte bara av möbeln utan av hela dess reservdelssortiment.
# En sökning på "IKEA PAX" plockade 473 annonser där 17,5 % låg under 200 kr:
# gångjärn, klädstänger, hyllplan, skåpshandtag. Medianen blev 750 kr för en
# garderob. "Kivik" drog in klädsel för 150 kr och sittdynor för 300 kr.
#
# Det förstörde också skickmätningen, och där var felet värre än ett brett
# intervall: delarna är SNEDFÖRDELADE över skicknivåerna. 11,3 % av
# nyskick-raderna var delar mot 6,5 % av slitet-raderna, eftersom en reservdel
# oftast säljs oanvänd. Effekten blev att nyskick såg BILLIGARE ut än gott
# skick — 400 kr mot 500 kr. Utan delarna vänder ordningen rätt igen:
# 990 mot 800 kr.
#
# Två nivåer, för att en enda ordlista inte klarar båda fallen:
#
#   STARK  ord som inte kan vara en hel möbel. Vinner alltid, även när
#          annonsen också nämner möbeltypen — "IKEA Tyssedal garderobsdörrar"
#          innehåller "garderob" men är dörrar.
#   SVAG   ord som kan vara antingen del eller möbel. Vinner bara när ingen
#          möbeltypsregel träffat, så att "PAX garderob med dörrar och
#          inredning" förblir en garderob medan "IKEA PAX - inredning" blir
#          en del.
PART = "del/tillbehör"

# Två mekanismer avgör, och båda kommer ur hur annonstitlar faktiskt ser ut.
#
# 1. "med X" beskriver en EGENSKAP, inte varan. "Säng med förvaringslådor" är
#    en säng, "PAX garderob med dörrar och inredning" är en garderob. Ett
#    negativt lookbehind på hela alternationen räcker för alla fallen.
#
# 2. Det som nämns FÖRST är det som säljs. Auktionstexterna räknar upp
#    detaljer efter möbelordet — "BOKHYLLA; 1930/40-tal, 2 flyttbara
#    hyllplan", "KARMSTOL, barock, klädd med blommig klädsel" — medan en
#    reservdelsannons leder med delen: "Klädsel till Ikea Kivik".
#    Vid samma startposition vinner den längsta träffen, vilket gör att
#    "garderobsdörrar" slår "garderob".
#
# Utan positionsregeln klassades bokhyllor, karmstolar och öronlappsfåtöljer
# som delar, eftersom deras beskrivningar nämner hyllplan och klädsel.
# "X till Y" — en hel möbel säljs inte "till" något annat. Konstruktionen är
# så entydig att den vinner oavsett position: i "Garderobsinredning till IKEA
# PAX" står möbelordet först, men annonsen säljer ändå inredningen.
# Undantaget "till salu" är inte en delsignal utan bara svenska.
# Bara "till", inte "för": "för" är för svagt och fångade beskrivningar som
# "trästol med grön dyna för uteplats".
_PART_PHRASE = (
    r"(?:ben|hyll|hylla|hyllplan|dorr|lucka|lada|dyna|kladsel|overdrag|stang"
    r"|skena|inredning|skruv|handtag|klaff) till\b(?! salu)"
)

_PART_WORDS = (
    r"(?<!med )(?:"
    r"komplement|hyllplan|kladstang|gangjarn|utdragsskena|utdragslada"
    # Ordgräns på kladsel/overdrag: "ylleklädsel", "skinnklädsel" och
    # "textilklädsel" beskriver möbelns material, de är inte lösa överdrag.
    r"|tradback|avdelare|skohyllplan|\bkladsel|\boverdrag|reservdel"
    r"|garderobsdorr|skjutdorr|skapsdorr|skapslucka|spegeldorr|monteringsbeslag"
    r"|forvaringslad|plastlad|madrasskydd|madrassskydd|garderobsforvaring"
    # Sammansättningar där möbelordet sitter INUTI delordet. Positionsregeln
    # löser dem via längsta träff, men bara om delordet finns med här.
    r"|utdragshylla|skostall|handtag"
    r"|\bdorr|\bluck(?:a|or)|\bdyn(?:a|or)\b|\binredning|\bframstycke"
    r")"
)

#: Alla möbelregler i en enda alternation — används bara för att hitta
#: POSITIONEN för den första möbelträffen, inte för att välja etikett.
_ANY_FURNITURE = r"|".join(pattern for _, pattern in VARIANT_RULES)

#: Giltiga svar från bildklassningen. Låser visionmodellen till exakt de
#: etiketter som annonserna klassas med. PART ingår medvetet INTE: motorn
#: prissätter möbler, och ett foto på en soffa ska aldrig kunna besvaras med
#: "reservdel".
VARIANT_LABELS: tuple[str, ...] = tuple(name for name, _ in VARIANT_RULES) + (UNKNOWN,)

_COMPILED = tuple((name, re.compile(pattern)) for name, pattern in VARIANT_RULES)
_PART_RE = re.compile(_PART_WORDS)
_PART_PHRASE_RE = re.compile(_PART_PHRASE)
_FURNITURE_RE = re.compile(_ANY_FURNITURE)


def normalize_variant(value: object) -> str | None:
    """Tolkar fritext som en variantetikett. None när den inte går att tolka."""
    from .data_loader import normalize_text

    text = normalize_text(value)
    if not text:
        return None
    # Exakt etikett (normaliserad: "hörnsoffa" -> "hornsoffa").
    for label in VARIANT_LABELS:
        if normalize_text(label) == text:
            return label
    # Annars: kör texten genom samma regler som annonserna.
    for label, pattern in _COMPILED:
        if pattern.search(text):
            return label
    return None


def classify_series(blob: pd.Series) -> pd.Series:
    """Ger varje annons exakt EN variant. Vektoriserad, körs vid uppstart.

    Tilldelningen sker i omvänd prioritetsordning så att mer specifika regler
    skriver över mindre specifika — nettoeffekten är "första regeln vinner".
    Delar och tillbehör läggs på sist, i två steg (se PART ovan).
    """
    result = pd.Series(UNKNOWN, index=blob.index, dtype="object")
    for label, pattern in reversed(_COMPILED):
        result[blob.str.contains(pattern, regex=True, na=False)] = label

    part_hit = blob.str.contains(_PART_RE, regex=True, na=False)
    furniture_hit = result != UNKNOWN

    # Bara ett delord och ingen möbeltyp — då är det en del.
    result[part_hit & ~furniture_hit] = PART

    # Båda träffade: det som nämns först vinner. Positionsjämförelsen görs
    # rad för rad och är dyr, så den körs bara på överlappet.
    both = part_hit & furniture_hit
    if both.any():
        texts = blob[both]
        result[both] = [
            PART if _part_first(text) else label
            for text, label in zip(texts, result[both])
        ]

    # "X till Y" vinner oavsett position.
    result[blob.str.contains(_PART_PHRASE_RE, regex=True, na=False)] = PART
    return result


def _part_first(text: str) -> bool:
    """Nämns delen före möbeln? Vid samma start vinner längsta träffen."""
    part = _PART_RE.search(text)
    if part is None:
        return False
    furniture = _FURNITURE_RE.search(text)
    if furniture is None:
        return True
    if part.start() != furniture.start():
        return part.start() < furniture.start()
    # "garderobsdorrar" mot "garderob": den längre träffen är mer specifik.
    return part.end() > furniture.end()


# --------------------------------------------------------------------------
# Vilka möbeltyper är ens möjliga?
# --------------------------------------------------------------------------
def available_variants(
    matches: pd.DataFrame, min_listings: int | None = None
) -> list[tuple[str, int]]:
    """Möbeltyper som faktiskt finns bland träffarna, störst först.

    Detta är nyckeln till hela bildklassningen. En modell som väljer fritt ur
    den globala taxonomin kan svara "bäddsoffa" på en Landskrona — och då blir
    resultatet noll annonser, eftersom Landskrona aldrig gjorts som bäddsoffa.

    Genom att härleda alternativen ur datan blir ett omöjligt svar omöjligt att
    ge. Tröskeln är densamma som för strikt filtrering, så varje erbjudet
    alternativ garanterat klarar filtret.
    """
    if "variant" not in matches.columns or matches.empty:
        return []
    floor = config.VARIANT_STRICT_MIN if min_listings is None else min_listings
    counts = matches["variant"].value_counts()
    return [
        (str(label), int(n))
        for label, n in counts.items()
        if label not in (UNKNOWN, PART) and n >= floor
    ]


# --------------------------------------------------------------------------
# Bildklassning
# --------------------------------------------------------------------------
@dataclass
class VariantGuess:
    """Resultatet av att läsa av ett foto.

    `variants` kan innehålla flera typer. Det är avsiktligt: en bäddsoffa ser
    ut som en vanlig soffa när den är ihopfälld, och ett foto kan omöjligt
    avgöra saken. Att då tvinga fram ett val ger fel svar i halva fallen —
    bättre att ta med båda och låta prisintervallet bli bredare.
    """

    variants: list[str]
    confidence: str  # "hög" | "medel" | "låg"

    @property
    def usable(self) -> bool:
        """Tomt svar eller låg konfidens ska inte styra filtreringen."""
        return bool(self.variants) and self.confidence in ("hög", "medel")


def _build_prompt(candidates: list[tuple[str, int]], name: str, brand: str | None) -> str:
    vad = f"{name}" + (f" från {brand}" if brand else "")
    lista = "\n".join(f"  - {label} ({n} annonser)" for label, n in candidates)
    return (
        f"Bilden visar en begagnad möbel som säljs som \"{vad}\".\n\n"
        f"I annonsdatan finns dessa möbeltyper för just den modellen:\n{lista}\n\n"
        "Vilken eller vilka av dessa stämmer med bilden?\n\n"
        "Svara med ALLA typer som är visuellt rimliga — inte bara den mest "
        "sannolika. Vissa skillnader går inte att se på ett foto: en bäddsoffa "
        "ser ut som en vanlig soffa när den är ihopfälld, och en 2-sits liknar "
        "en 3-sits i närbild. Kan du inte skilja två typer åt, ta med båda. Det "
        "breddar prisintervallet, vilket är rätt när underlaget är osäkert.\n\n"
        "Uteslut däremot det du säkert kan utesluta: en fotpall är ingen soffa, "
        "en fåtölj rymmer en person, en hörnsoffa har en tydlig divandel eller "
        "L-form. Antalet annonser visar hur vanlig varje typ är — använd det "
        "som ledtråd när bilden är tvetydig, men låt aldrig antalet överrida "
        "det du faktiskt ser.\n\n"
        "Svara bara med typer ur listan ovan."
    )


def classify_image(
    image_bytes: bytes,
    candidates: list[tuple[str, int]],
    name: str = "",
    brand: str | None = None,
    media_type: str = "image/jpeg",
    model: str | None = None,
    client: object | None = None,
) -> VariantGuess:
    """Läser av möbeltypen ur ett foto, begränsat till `candidates`.

    Kräver paketet `openai` och OPENAI_API_KEY (sätts enklast i .env).
    Importeras lazy så att resten av motorn fungerar utan båda.
    """
    if not candidates:
        return VariantGuess(variants=[], confidence="låg")

    try:
        from openai import OpenAI
    except ImportError as exc:  # pragma: no cover - beror på installation
        raise RuntimeError(
            "Bildklassning kräver paketet 'openai'. Installera med "
            "`pip install openai` eller skicka `variant` direkt istället."
        ) from exc

    from pydantic import BaseModel, Field, create_model
    from typing import List
    from typing_extensions import Literal

    tillatna = [label for label, _ in candidates]

    # Schemat byggs per anrop och låser svaret till just den här modellens
    # möjliga typer — inte till den globala taxonomin.
    _Typ = Literal[tuple(tillatna)]  # type: ignore[valid-type]
    _Svar = create_model(
        "Mobeltyp",
        variants=(List[_Typ], Field(..., description="Alla visuellt rimliga typer.")),
        confidence=(
            Literal["hög", "medel", "låg"],
            Field(..., description="Hur säker avläsningen är."),
        ),
        __base__=BaseModel,
    )

    client = client or OpenAI()
    data_url = (
        f"data:{media_type};base64,"
        + base64.standard_b64encode(image_bytes).decode()
    )
    completion = client.chat.completions.parse(
        model=model or config.VARIANT_MODEL,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _build_prompt(candidates, name, brand)},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        response_format=_Svar,
    )
    parsed = completion.choices[0].message.parsed

    # Skyddsnät: släpp allt som inte fanns bland alternativen, även om
    # schemat redan borde ha hindrat det.
    variants = [v for v in dict.fromkeys(parsed.variants) if v in tillatna]
    log.info("Bildklassning: %s (%s)", variants or "inget", parsed.confidence)
    return VariantGuess(variants=variants, confidence=parsed.confidence)
