"""Storleksnivån — steget under möbeltyp i matchningstrappan.

Trappan är modell → variant → **storlek**. Skälet är uppmätt: prisspridningen
INOM variant har median 78 %, alltså större än variantspridningen den ligger
under.

    Kivik hörnsoffa     2-sits 1 250   3-sits 2 000   5-sits 4 900   divan 1 000
    Söderhamn hörnsoffa 2-sits 3 000   4-sits 4 800   6-sits 6 000   divan 1 800
    Karlstad soffa      2-sits   600   3-sits 2 250

Samma modell, samma variant, fyra gånger i pris. Utan storleksnivån blandas de
i samma median.

**Kompatibilitetsspärren är inte en detalj.** Utan den gav min egen mätning
"hemnes byrå: 2 stolar 275 kr" — en byrå som råkat matcha "2 st." i titeln.
Ett storleksord räknas därför bara när det är förenligt med möbeltypen: sitsar
hör till soffor, antal stolar till matgrupper, centimeterlängd till bord och
liggmöbler.

Täckningen är ojämn men högst där problemet är värst: hörnsoffor har
storleksord i 87–91 % av annonserna, medan genomsnittet över alla möbler är
14 %. Saknas ordet blir storleken None och filtret hoppas över — se
pricing._apply_size, som då i stället VARNAR med storleksgruppernas prislägen.
"""

from __future__ import annotations

import logging
import re

import pandas as pd

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Storlekssorterna och vad de får sitta på
# --------------------------------------------------------------------------
#: storlekssort -> möbeltyper där sorten är meningsfull.
#: Detta ÄR rimlighetsspärren. Står en sort inte med för en möbeltyp förkastas
#: träffen, hur tydligt ordet än står i titeln.
COMPATIBILITY: dict[str, frozenset] = {
    # Sittplatser hör till sittmöbler. En byrå har inga sitsar.
    "seats": frozenset({"soffa", "hörnsoffa", "bäddsoffa", "fåtölj"}),
    # Form: bara soffor har divan eller U-form.
    "form": frozenset({"soffa", "hörnsoffa", "bäddsoffa"}),
    # Antal stolar hör till matgrupper — det var här hemnes-byrån föll in.
    "chairs": frozenset({"matgrupp"}),
    # Längd i cm är meningsfull för bord och liggmöbler, inte för en fåtölj.
    "length": frozenset({"bord", "matbord", "soffa", "hörnsoffa", "bäddsoffa",
                         "säng", "byrå", "hylla"}),
}

#: Längdintervall i steg om 50 cm. Exakta centimeter är för finkorniga —
#: 198 och 200 cm är samma soffa — och skulle splittra mängden i onödan.
_LENGTH_STEP = 50

_SEATS = re.compile(r"\b([2-9])[- ]?sits")
_FORM_U = re.compile(r"\bu[- ]?soffa|\bu[- ]?formad|\bu[- ]?form\b")
_FORM_DIVAN = re.compile(r"\bdivan|schaslong|schaselong|chaiselong")
# Foge-varianterna: "6 stolar", "6 st stolar", "6 st. stolar", "6 stycken stolar".
_CHAIRS = re.compile(r"\b(\d{1,2})\s*(?:st\.?\s+|stycken\s+)?stol")
_LENGTH = re.compile(r"\b(\d{2,3})\s*cm")

#: Rimliga längder för möbler. Utanför spannet är talet något annat — sitthöjd,
#: djup, postnummer, årtal.
_LENGTH_MIN, _LENGTH_MAX = 60, 400


def extract(text: str, variant: str | None = None) -> str | None:
    """Storlekstoken ur en text, eller None.

    `variant` aktiverar kompatibilitetsspärren. Utan den returneras första
    träffen oavsett möbeltyp, vilket bara är rätt när typen är okänd.

    Ordningen är avsiktlig — mest specifik först. Sitsantal slår längd,
    eftersom "3-sits 220 cm" är en tresits vars längd är en följd av det.
    """
    if not text:
        return None

    match = _SEATS.search(text)
    if match and _allowed("seats", variant):
        return f"{match.group(1)}-sits"

    if _FORM_U.search(text) and _allowed("form", variant):
        return "u-soffa"
    if _FORM_DIVAN.search(text) and _allowed("form", variant):
        return "divan"

    match = _CHAIRS.search(text)
    if match and _allowed("chairs", variant):
        count = int(match.group(1))
        if 2 <= count <= 12:
            return f"{count} stolar"

    for match in _LENGTH.finditer(text):
        value = int(match.group(1))
        if _LENGTH_MIN <= value <= _LENGTH_MAX and _allowed("length", variant):
            bucket = value // _LENGTH_STEP * _LENGTH_STEP
            return f"{bucket}-{bucket + _LENGTH_STEP}cm"
    return None


def _allowed(kind: str, variant: str | None) -> bool:
    """Är storlekssorten förenlig med möbeltypen?"""
    if variant is None:
        return True
    return variant in COMPATIBILITY[kind]


def classify_series(blob: pd.Series, variant: pd.Series) -> pd.Series:
    """Storlekstoken för varje annons. Körs vid inläsning.

    Går rad för rad eftersom spärren beror på radens egen möbeltyp, men bara
    över de rader som alls innehåller en siffra eller ett formord — resten kan
    per definition inte bära en storlek.
    """
    candidate = blob.str.contains(
        r"\d|divan|schaslong|schaselong|u-soffa|u soffa", regex=True, na=False
    )
    out = pd.Series(None, index=blob.index, dtype="object")
    subset = blob[candidate]
    out[candidate] = [
        extract(text, kind)
        for text, kind in zip(subset, variant[candidate])
    ]
    log.info("Storlekstoken: %d av %d annonser (%.1f %%)",
             int(out.notna().sum()), len(out),
             float(out.notna().mean() * 100))
    return out


def spread(frame: pd.DataFrame) -> dict:
    """Prislägen per storleksgrupp — underlaget för sizeWarning.

    Returnerar {} när storleken inte går att jämföra: färre än två grupper med
    eget underlag betyder att spridningen inte kan tillskrivas storleken.
    """
    if "size" not in frame.columns or frame.empty:
        return {}
    sized = frame[frame["size"].notna()]
    if len(sized) < 8:
        return {}
    groups = sized.groupby("size")["price"].agg(["median", "size"])
    groups = groups[groups["size"] >= 3]
    if len(groups) < 2:
        return {}
    return {
        str(label): {"median": round(float(row["median"])), "n": int(row["size"])}
        for label, row in groups.sort_values("median").iterrows()
    }
