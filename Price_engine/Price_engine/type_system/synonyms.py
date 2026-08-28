"""Synonymexpansion — obligatorisk, annars missar sökningen halva marknaden.

Samma möbel beskrivs med helt olika ord av olika säljare. En soffa med
utskjutande liggdel heter `schaslong` i 24 336 annonser, `divan` i 20 454 och
`divansoffa` i 13 018. Söker motorn bara på det ord användaren råkade skriva
tappar den merparten av jämförelseannonserna och hamnar i shrinkage utan att
någon förstår varför.

**Expansion och filtrering är två skilda beslut.** Att två ord expanderar till
varandra betyder inte att de är samma attributvärde. Efter prisrelevansmätningen
gäller:

* `divan`/`schäslong` ligger på 0,94x en rak soffa (KI [0,91, 1,00], innehåller
  1,00) — verkligt oskiljbara. Samma grupp *och* samma attributvärde.
* `skänk`/`vitrin` ligger på 0,91x (KI [0,87, 0,95], innehåller inte 1,00).
  Skillnaden är liten men verklig, 9,4 %. Samma söktgrupp, men **behållna som
  skilda attributvärden** — se `MERGED_VALUES` för resonemanget.

**Prislikhet är nödvändigt men inte tillräckligt för sammanslagning.** Mätningen
gav `matgrupp / soffbord` = 1,03, alltså 2,8 % skillnad. Att slå ihop dem vore
absurt: de är lika dyra av en tillfällighet, inte av släktskap. Sammanslagning
prövas därför bara mellan ord som redan är synonymkandidater.
"""

from __future__ import annotations

import re
from typing import Dict, Optional, Tuple

from price_engine.data_loader import normalize_text

from . import lexicon as lex

#: Söktgrupper per attributvärde. Sökningen expanderar ALLTID via gruppen,
#: aldrig på det enskilda ordet användaren skrev.
GROUPS: Dict[str, Tuple[str, ...]] = {
    "chaise": lex.CHAISE_WORDS,
    "corner": lex.CORNER_WORDS,
    "convertible": lex.CONVERTIBLE_WORDS,
    "matgrupp": lex.TABLE_SUBS["matgrupp"],
    "matbord": lex.TABLE_SUBS["matbord"],
    "soffbord": lex.TABLE_SUBS["soffbord"],
    "sidobord": lex.TABLE_SUBS["sidobord"],
    "skrivbord": lex.TABLE_SUBS["skrivbord"],
    "byra": lex.STORAGE_KINDS["byra"],
    "hylla": lex.STORAGE_KINDS["hylla"],
    "skank": lex.STORAGE_KINDS["skank"],
    "vitrin": lex.STORAGE_KINDS["vitrin"],
}

#: Grupper som expanderar till varandra i sökningen utan att slås ihop som
#: attributvärden. Mätt prisskillnad i kommentaren.
CO_EXPAND = {
    "skank": ("vitrin",),      # 9,4 % — liten men verklig, KI utesluter 1,00
    "vitrin": ("skank",),
    "chaise": ("corner",),     # divanen och hörnet beskrivs ofta om varandra
    "corner": ("chaise",),
}

#: Attributvärden som mätningen visade är oskiljbara och därför ÄR sammanslagna.
#: `chaise` härleder inte längre någon egen typ — se attributes.derive_type.
MERGED_VALUES = {
    "chaise -> soffa": "divan/schäslong 0,94x rak soffa, KI [0,91, 1,00]",
}

#: Ord som stavas fel i verkliga annonser. Redigeringsavstånd 1 tillåts bara här,
#: aldrig generellt: `bord`/`bort` och `soffa`/`sofa` ligger också på avstånd 1,
#: och en generell tolerans skulle blanda ihop dem.
HARD_TO_SPELL = (
    "schaslong", "schaslongsoffa", "chaiselong", "chaiselongue", "divansoffa",
    "hornsoffa", "baddsoffa", "sideboard", "vitrinskap", "matsalsgrupp",
)

_SPACE = re.compile(r"[\s\-_]+")


def fold(word: str) -> str:
    """Normaliserar bort diakriter, bindestreck och mellanslag.

    Gör "chaise longue", "chaise-longue" och "chaiselongue" till samma sträng.
    Korpusen är redan NFKD-vikt av `_normalize_series`; detta hanterar
    användarens inmatning, som inte är det.
    """
    return _SPACE.sub("", normalize_text(word or ""))


def _distance_one(a: str, b: str) -> bool:
    """Levenshtein-avstånd <= 1. Egen implementation för att slippa beroende."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la > lb:
        a, b, la, lb = b, a, lb, la
    i = 0
    while i < la and a[i] == b[i]:
        i += 1
    if i == la:
        return True                     # b har ett tecken extra på slutet
    if la == lb:
        return a[i + 1:] == b[i + 1:]   # substitution
    return a[i:] == b[i + 1:]           # insättning


def canonical(word: str) -> Optional[str]:
    """Vilket attributvärde tillhör ordet? None om inget.

    Exakt delsträngsmatchning först, därefter redigeringsavstånd 1 men bara mot
    `HARD_TO_SPELL`. Uteslutningslistorna gäller: `bortskankes` är inte en skänk
    och `dagbadd` är inte en bäddsoffa.
    """
    folded = fold(word)
    if not folded:
        return None
    if any(bad in folded for bad in lex.STORAGE_EXCLUDE):
        return None
    if any(bad in folded for bad in lex.CONVERTIBLE_EXCLUDE):
        return None
    if any(bad in folded for bad in lex.CORNER_NOT_SOFA):
        return None

    for value, words in GROUPS.items():
        for candidate in words:
            if fold(candidate) in folded:
                return value
    for hard in HARD_TO_SPELL:
        if _distance_one(folded, fold(hard)):
            for value, words in GROUPS.items():
                if hard in words:
                    return value
    return None


def expand(word: str) -> Tuple[str, ...]:
    """Alla söktermer som ska ingå när användaren skrev `word`.

    Skriver användaren "schäslong" ska annonser med "hörnsoffa" och "divan"
    finnas i jämförelsemängden, och tvärtom.
    """
    value = canonical(word)
    if value is None:
        return ()
    terms = list(GROUPS.get(value, ()))
    for other in CO_EXPAND.get(value, ()):
        terms.extend(GROUPS.get(other, ()))
    return tuple(dict.fromkeys(terms))


def pattern(word: str) -> Optional[str]:
    """Regex som matchar hela söktgruppen mot korpusens `search_blob`."""
    terms = expand(word)
    if not terms:
        return None
    return "|".join(sorted((re.escape(t) for t in terms), key=len, reverse=True))
