"""L0 — attribut ur text. Deterministiskt, gratis, högst precision.

Texten vinner alltid över bilden när den uttalar sig. Grunden är mätt:
`measure_variant_classifier.py` visade att när text och bild säger olika om
soffans undertyp har texten rätt i ~87 % av fallen, eftersom funktionen
(bäddbarhet) och hörnsektionen ofta inte syns på fotot.

Två saker gör lagret svårare än en ordlista:

* **Sammansättning.** Svenska limmar ihop orden: `hornbaddsoffa` bär både
  `corner` och `convertible`. Matchning sker därför på delsträng inom token,
  inte på hela token.
* **Negation.** "passar till divan" och "säljes utan schäslongdel" ska inte
  sätta attributet. `NEGATION_WINDOW` ord före träffen kontrolleras.
"""

from __future__ import annotations

import re
from typing import Optional, Tuple

from price_engine.data_loader import normalize_text

from . import lexicon as lex
from .attributes import SET_ITEMS_UNKNOWN, Attributes

_TOKEN = re.compile(r"[0-9a-z]+(?:-[0-9a-z]+)*")

#: "3-sits", "3sits", "tresits", "3-sitsig", "3-sitts", "3-sittssoffa"
_SEATS = re.compile(r"(\d+)\s*-?\s*sit(?:s|t)")
_SEATS_WORD = re.compile(r"\b(" + "|".join(lex.NUMBER_WORDS) + r")sit(?:s|t)")
#: "bord och 4 stolar", "med 6 stolar", "4 stolar"
_SET_ITEMS = re.compile(r"(\d+)\s+(?:st\s+)?stolar")
_SET_ITEMS_WORD = re.compile(r"\b(" + "|".join(lex.NUMBER_WORDS) + r")\s+stolar")
#: "med stolar", "och stolar", "+ stolar" — stolarna ingår, antalet saknas.
_STOLAR_UNCOUNTED = re.compile(r"(?:med|och|inkl|inklusive|\+)\s+(?:\d+\s+)?stolar")


def _tokens(text: str) -> Tuple[str, ...]:
    return tuple(_TOKEN.findall(text))


#: Negationsorden delade på enordiga och flerordiga. Enordiga måste matcha ett
#: HELT token. Delsträngsmatchning gav falska negationer i verklig data:
#: "ej" ligger inne i *vejlby*, *rejal*, *skejby*, *lejontassar*, och "inte"
#: inne i *interlubke*. Det blockerade 122 giltiga attributträffar i korpusen.
_CUE_WORDS = frozenset(c for c in lex.NEGATION_CUES if " " not in c)
_CUE_PHRASES = tuple(c for c in lex.NEGATION_CUES if " " in c)


def _negated(tokens: Tuple[str, ...], index: int) -> bool:
    """Ligger en negation inom fönstret före token `index`?"""
    start = max(0, index - lex.NEGATION_WINDOW)
    window = tokens[start:index]
    if any(token in _CUE_WORDS for token in window):
        return True
    joined = " ".join(window)
    return any(phrase in joined for phrase in _CUE_PHRASES)


def _find(tokens: Tuple[str, ...], needles, exclude=()) -> Optional[Tuple[int, str]]:
    """Första icke-negerade träffen. Returnerar (index, token)."""
    for i, token in enumerate(tokens):
        if any(bad in token for bad in exclude):
            continue
        for needle in needles:
            matched = (token.startswith(needle) if needle in lex.PREFIX_ONLY
                       else needle in token)
            if matched:
                if _negated(tokens, i):
                    break
                return i, token
    return None


def _base(tokens: Tuple[str, ...]) -> Optional[Tuple[str, str]]:
    """Bastypen, avgjord på **position**: första möbelordet i texten styr.

    "Soffbord till hörnsoffa" är ett bord, inte en soffa. Positionsregeln är
    samma princip som redan används för del/tillbehör i variant.py.

    Vid lika position vinner den **mest specifika** träffen, alltså den med
    längsta matchande ordet. Utan den regeln skuggar `sang` alltid `sanggavel`:
    token "sanggavel" innehåller båda, positionen är densamma, och då avgjorde
    dict-ordningen. Det gav sänggavlar bastypen `sang` och 0 % träffsäkerhet på
    hela klassen i systemmätningen.
    """
    best: Optional[Tuple[int, int, str, str]] = None
    for base, words in lex.BASE_WORDS.items():
        exclude = lex.STORAGE_EXCLUDE if base == "forvaring" else ()
        hit = _find(tokens, words, exclude)
        if not hit:
            continue
        index, token = hit
        matched = max((len(w) for w in words if w in token), default=0)
        key = (index, -matched)
        if best is None or key < (best[0], -best[1]):
            best = (index, matched, base, token)
    return (best[2], best[3]) if best else None


def _number(match, mapping=None) -> Optional[int]:
    if not match:
        return None
    raw = match.group(1)
    value = mapping.get(raw) if mapping else int(raw)
    return value


def extract(text: str, *, attrs: Optional[Attributes] = None,
            prenormalized: bool = False) -> Attributes:
    """Fyller i alla attribut texten uttalar sig om.

    Konfidensen är 0,95 för uttryckliga ord och 0,80 för sådant som härleds ur
    sammansättning. Den är inte 1,0: annonstexter innehåller fel, och en
    säkerhet på 1,0 skulle göra L4-frågan omöjlig att motivera.

    `prenormalized=True` för `search_blob` och andra korpuskolumner, som redan
    gått genom `_normalize_series`. Skillnaden är inte kosmetisk:
    `normalize_text` konstruerar en pandas Series per anrop, vilket kostar
    ~200 µs och gör en svepning över 1,5 miljoner rader tio minuter långsammare
    än nödvändigt.
    """
    attrs = attrs if attrs is not None else Attributes()
    folded = (text or "") if prenormalized else normalize_text(text or "")
    if not folded:
        return attrs
    tokens = _tokens(folded)

    base = _base(tokens)
    if base:
        attrs.set("base", base[0], "text", 0.95, base[1])

    # --- soffans egenskaper ------------------------------------------------
    # Gäller bara när basen är soffa eller ännu okänd. "Soffbord till hörnsoffa"
    # är ett bord, och ska inte bära hörnattributet — positionsregeln har redan
    # avgjort basen, och soffordet längre fram i texten beskriver något annat.
    if attrs.get("base") in ("soffa", None):
        conv = _find(tokens, lex.CONVERTIBLE_WORDS, lex.CONVERTIBLE_EXCLUDE)
        if conv:
            attrs.set("convertible", True, "text", 0.95, conv[1])

        chaise = _find(tokens, lex.CHAISE_WORDS, lex.CHAISE_EXCLUDE)
        if chaise:
            attrs.set("chaise", True, "text", 0.95, chaise[1])

        corner = _find(tokens, lex.CORNER_WORDS, lex.CORNER_NOT_SOFA)
        if corner:
            attrs.set("corner", True, "text", 0.95, corner[1])
            # Hur MÅNGA hörn? "U-soffa" och "dubbeldivan" betyder två; allt
            # annat hörnord ett. Booleanen `corner` behålls för bakåtkompatibla
            # kodvägar, men `corner_count` är den som bär prisskillnaden.
            double = _find(tokens, lex.DOUBLE_CORNER_WORDS, ())
            attrs.set("corner_count", 2 if double else 1, "text", 0.95,
                      (double or corner)[1])
        elif attrs.get("base") == "soffa":
            # "horn" ensamt duger bara när basen redan är soffa — hornskap är skåp.
            loose = _find(tokens, lex.CORNER_AMBIGUOUS, lex.CORNER_NOT_SOFA)
            if loose:
                attrs.set("corner", True, "text", 0.80, loose[1])
                attrs.set("corner_count", 1, "text", 0.80, loose[1])

        seats = _number(_SEATS.search(folded)) or _number(
            _SEATS_WORD.search(folded), lex.NUMBER_WORDS)
        if seats and 1 <= seats <= lex.MAX_SEATS:
            attrs.set("seats", seats, "text", 0.95, f"{seats}-sits")

        # Ett soffattribut utan bastyp implicerar soffan: "schäslong till Vimle".
        # Lägre konfidens än ett uttryckligt möbelord, eftersom det är en slutsats.
        if attrs.get("base") is None and any(
                attrs.known(a) for a in ("convertible", "chaise", "corner", "seats")):
            attrs.set("base", "soffa", "text", 0.85, "soffattribut utan bastyp")

    # --- bordets undertyp --------------------------------------------------
    if attrs.get("base") == "bord":
        for sub, words in lex.TABLE_SUBS.items():
            hit = _find(tokens, words)
            if hit:
                attrs.set("sub", sub, "text", 0.95, hit[1])
                break
        items = _number(_SET_ITEMS.search(folded)) or _number(
            _SET_ITEMS_WORD.search(folded), lex.NUMBER_WORDS)
        if items is not None and 0 <= items <= lex.MAX_SET_ITEMS:
            attrs.set("set_items", items, "text", 0.95, f"{items} stolar")
        elif _STOLAR_UNCOUNTED.search(folded):
            # "Ekbord med stolar" — stolarna ingår men antalet står inte skrivet.
            # -1 betyder "ingår, antal okänt": tillräckligt för att söka matgrupp,
            # och L4 kan fråga efter antalet om det flyttar priset.
            attrs.set("set_items", SET_ITEMS_UNKNOWN, "text", 0.90,
                      "stolar utan antal")
        elif attrs.get("sub") == "matgrupp":
            # En matgrupp innehåller stolar även när antalet inte står skrivet.
            attrs.set("set_items", SET_ITEMS_UNKNOWN, "text", 0.70,
                      "matgrupp utan antal")

    # --- sittmöbelns undertyp ----------------------------------------------
    if attrs.get("base") == "stol":
        for kind, words in lex.CHAIR_KINDS.items():
            hit = _find(tokens, words, lex.CHAIR_EXCLUDE)
            if hit:
                attrs.set("chair_kind", kind, "text", 0.95, hit[1])
                break

    # --- förvaringens undertyp --------------------------------------------
    if attrs.get("base") == "forvaring":
        for kind, words in lex.STORAGE_KINDS.items():
            hit = _find(tokens, words, lex.STORAGE_EXCLUDE)
            if hit:
                attrs.set("storage_kind", kind, "text", 0.95, hit[1])
                break

    return attrs
