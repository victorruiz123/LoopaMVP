"""Skadeflaggor ur skicktexten — extraherade INNAN fritexten raderas.

`condition_text` är ifylld på 470 278 rader och används inte av motorn. Fältet
raderas i upphovsrättssaneringen, och den här modulen är skälet till att det går
att göra utan att förlora något: skadeinformationen struktureras först.

Ordlistorna är byggda UR DATAN, inte påhittade. De 40 vanligaste orden i ett
urval om 80 000 skicktexter räknades fram, och listorna nedan täcker dem som
beskriver ett fysiskt fel. Frekvenserna i kommentarerna är från den räkningen.

Matchningen är ASCII-foldad eftersom `condition_text` i master.parquet är RÅ
text med diakriter, till skillnad från motorns `search_blob`.

**Uppmätt täckning: 94,3 %** av de 470 278 ifyllda skicktexterna får minst en
flagga. De 26 748 oflaggade är i allt väsentligt genuint oskadade — "No
remarks", "Bra skick", "Nära nyskick", "Renoverad och kompletterad".

**Känd begränsning: negation hanteras inte.** "Inga märken" flaggas som skada.
Uppmätt förekomst i `condition_text`: `inga` 709, `ingen` 1 234, `utan` 374,
`ej` 6 982 — tillsammans cirka **2,0 %** av de ifyllda raderna, och `ej` är
oftast "ej signerad" snarare än "ej repor". Negationshantering är medvetet
utelämnad: den skulle själv behöva valideras, och flaggorna är RÅMATERIAL för
en framtida skickmodell, inte ett prisavdrag. En falsk flagga kostar därför
ingenting i dag, medan en förlorad signal är oåterkallelig när fritexten är
raderad.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Dict

#: Kategori -> ord som utlöser den. Delsträngsmatchning, så "bruksslitage"
#: fångas av `slitage` och "torrsprickor" av `sprick`.
DAMAGE_WORDS: Dict[str, tuple] = {
    # 38 042 bruksslitage + 22 341 slitage + 2 305 ytslitage + 1 405 aldersslitage
    "wear": ("slitage", "bruksskick", "nott", "skav", "blankslit"),
    # 18 842 repor
    "scratch": ("repor", "repa", "rispa", "rispor"),
    # 14 482 flackar + 2 955 fargbortfall
    "stain": ("flack", "missfarg", "fargbortfall", "vattenskad", "fuktflack"),
    # 5 497 skador + 1 673 fanerskador + 1 753 stotmarken + 1 665 slagmarken
    "damage": ("skad", "stotmark", "slagmark", "avslag", "nagg", "bucklor"),
    # 2 990 sprickor + 2 326 torrsprickor
    "crack": ("sprick", "krackeler", "spjalk"),
    # 4 099 saknas + 2 834 missing + 1 182 lagningar
    "defect": ("defekt", "trasig", "saknas", "missing", "lagning", "lagad",
               "lossnat", "glappar", "instabil"),
}

#: Ord som måste matcha med ORDGRÄNS, inte som delsträng. `marke` finns inuti
#: **varumärke**, `markering` och `marknad` — som delsträng blev det 20 966
#: falska skador. Samma buggklass som `lsoffa` inuti *hallsoffa* i lexikonet.
BOUNDED_WORDS: Dict[str, tuple] = {
    "damage": ("marke", "marken", "marken.", "bruksspar", "gulnad", "gulnat"),
}

#: Ord som ser ut som skada men inte är det. "Key/keys included" är
#: auktionshusens standardfras och står för 12 319 + 9 473 förekomster — den
#: innehåller inget skadeord, men `renoverad` gör det: en renoverad möbel är
#: LAGAD, inte trasig, och ska inte flaggas som defekt.
NOT_DAMAGE = ("renoverad", "renoverat", "restaurerad", "omklad", "omlackerad")

_NOISE = re.compile("|".join(NOT_DAMAGE))
_BOUNDED = {name: re.compile(r"\b(?:" + "|".join(words) + r")\b")
            for name, words in BOUNDED_WORDS.items()}


def fold(text: str) -> str:
    """Gemener utan diakriter. condition_text är rå, till skillnad från blob."""
    if not text:
        return ""
    return (unicodedata.normalize("NFKD", str(text))
            .encode("ascii", "ignore").decode("ascii").lower())


def flags(text: str) -> Dict[str, bool]:
    """Skadeflaggorna för en skicktext. Alla False när texten är tom."""
    folded = _NOISE.sub(" ", fold(text))
    return {name: (any(w in folded for w in words)
                   or bool(_BOUNDED[name].search(folded)) if name in _BOUNDED
                   else any(w in folded for w in words))
            for name, words in DAMAGE_WORDS.items()}


def score(text: str) -> int:
    """Antal skadekategorier som utlöste. 0-6, grov allvarlighetsindikator.

    Avsiktligt ett ANTAL och ingen viktad skala: vikterna skulle behöva mätas
    mot pris, och den mätningen finns inte. Talet är råmaterial för en framtida
    skickmodell, inte ett prisavdrag.
    """
    return sum(flags(text).values())


def columns(series) -> Dict[str, list]:
    """Kolumnerna för en hel serie skicktexter, för inläsaren."""
    rows = [flags(t) for t in series]
    out = {f"damage_{name}": [r[name] for r in rows] for name in DAMAGE_WORDS}
    out["damage_count"] = [sum(r.values()) for r in rows]
    return out


# --------------------------------------------------------------------------
# Gradering — för NY data. Går inte att rädda för den befintliga korpusen.
# --------------------------------------------------------------------------
# Saneringen 2026-08-19 extraherade bara booleaner. Gradadjektiven ("liten
# fläck", "kraftigt slitage", "knappt synlig repa") fanns i `condition_text` och
# är borta med den — oåterkalleligt för de 470 278 rader som redan fanns.
#
# Det här är därför inte en räddning utan en spärr mot att det upprepas: från
# och med nu extraheras graden TILLSAMMANS med skadeordet, innan fritexten
# slängs. Graderingsunderlaget växer från nästa skrapning.

#: Gradadjektiv -> nivå. 0 = nedtonande, 1 = neutral, 2 = förstärkande.
#: Nivåerna är ETIKETTER, inte multiplikatorer — kopplingen till pris ska mätas,
#: inte antas.
GRADE_WORDS = {
    0: ("knappt", "nastan", "obetydlig", "marginell", "diskret", "liten",
        "litet", "sma", "smarre", "mindre", "enstaka", "nagra fa", "lindrig"),
    2: ("kraftig", "kraftigt", "omfattande", "betydande", "stor", "stort",
        "stora", "grov", "grava", "svar", "svart", "genomgaende", "ordentlig"),
}

#: Hur många ord runt skadeordet som räknas som dess sammanhang. Samma tanke som
#: NEGATION_WINDOW i lexikonet: ett adjektiv längre bort beskriver något annat.
#: STATUS: teoretiskt — fönstret är inte svept.
GRADE_WINDOW = 3


def grades(text: str) -> Dict[str, int]:
    """Grad per skadekategori: 0 nedtonad, 1 neutral, 2 förstärkt.

    Bara kategorier som faktiskt utlöste får en grad. Hittas inget gradadjektiv
    inom fönstret blir graden 1 — "nämnd utan gradering", vilket är en annan sak
    än "nämnd som liten".
    """
    folded = _NOISE.sub(" ", fold(text))
    words = re.findall(r"[a-z0-9]+", folded)
    out: Dict[str, int] = {}
    for name, triggers in DAMAGE_WORDS.items():
        hits = [i for i, w in enumerate(words)
                if any(t in w for t in triggers)
                or (name in _BOUNDED and _BOUNDED[name].search(w))]
        if not hits:
            continue
        grade = 1
        for index in hits:
            window = words[max(0, index - GRADE_WINDOW): index + GRADE_WINDOW + 1]
            for level, adjectives in GRADE_WORDS.items():
                if any(a in window for a in adjectives):
                    # Förstärkning vinner över nedtoning: "små repor och kraftigt
                    # slitage" ska inte läsas som en lindrig annons.
                    grade = max(grade, level) if level == 2 else min(grade, level)
        out[name] = grade
    return out


def grade_columns(series) -> Dict[str, list]:
    """Gradkolumner för en serie skicktexter. Används vid INTAG av ny data."""
    rows = [grades(t) for t in series]
    out = {f"grade_{name}": [r.get(name) for r in rows] for name in DAMAGE_WORDS}
    out["grade_max"] = [max(r.values()) if r else None for r in rows]
    return out
