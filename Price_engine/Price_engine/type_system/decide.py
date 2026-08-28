"""Beslutsreglerna: vad är värt att fråga om, och vad krävs för att tro på svaret.

Fyra regler, i den ordning de tillämpas:

1. **Källhierarkin** — texten vinner över priorn som vinner över bilden. Den
   regeln bor strukturellt i `Attributes.set` och behöver ingen logik här.
2. **Priorn som spärr** — `Prior.contradicts`. Säger bilden "bord" och
   modellordet är Lamino är bilden fel, hur säker den än är.
3. **Kostnadsmedveten fråga (value of information)** — räkna FÖRE varje betalt
   L3-anrop och varje L4-fråga hur mycket priset skiljer mellan attributets
   möjliga värden. Under tröskeln: hoppa över. Spendera bara på det som flyttar
   priset.
4. **Asymmetri mot nedgradering** — det ska krävas starkare evidens för att göra
   möbeln billigare än för att låta den förbli dyrare.

Regel 4 förtjänar en förklaring, för den är lätt att bygga fel. Den naiva
varianten är "kräv mer för False än för True". Den är fel: mätningen visar att
`corner=True` gör möbeln DYRARE (hörnsoffa 1,23x rak soffa) medan
`convertible=True` gör den BILLIGARE (bäddsoffa 0,80x). Riktningen sitter alltså
inte i booleanen utan i priset, och asymmetrin räknas därför på den härledda
typens mätta prisnivå.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .attributes import (IMPACT, SET_ITEMS_UNKNOWN, Attributes, candidate_types,
                         derive_type, relevant_attributes)

log = logging.getLogger(__name__)

RELEVANCE_PATH = Path("type_system/price_relevance.json")

#: Mätta relativa prisnivåer per typ, normaliserade mot "rak soffa", "matbord"
#: respektive "hylla" = 1,00. Ur `measure_price_relevance.py` (parvisa medianer
#: inom modellgrupp). Används enbart för att avgöra RIKTNING, aldrig för att
#: sätta pris.
#:
#: Nivåerna är **försonade med minsta kvadrat i logrummet**, inte lästa ur enskilda
#: par. De parvisa kvoterna är nämligen inte transitiva: `hylla/vitrin` = 0,59
#: ger vitrin 1,70 medan `byra/vitrin` = 0,64 ger 1,95. Att välja en av dem hade
#: varit ett godtyckligt val mellan två mätningar. Största kvarvarande residual
#: är 0,065 i log (~6,7 %) för förvaringsfamiljen, 0,061 för soffor och 0,036
#: för bord — måttet på hur väl en enda skala alls beskriver familjen.
PRICE_LEVEL: Dict[str, float] = {
    # soffor, ankare rak soffa
    "hornsoffa": 1.205,
    "soffa": 1.000,
    "baddsoffa": 0.823,
    # bord, ankare matbord
    "matbord": 1.000,
    "skrivbord": 0.760,
    "matgrupp": 0.521,
    "soffbord": 0.492,
    "sidobord": 0.338,
    # sittmöbler, ankare stol — MÄTT 2,60x, störst i hela systemet
    "fatolj": 2.600,
    "stol": 1.000,
    # förvaring, ankare hylla
    "vitrin": 1.814,
    "skank": 1.691,
    "byra": 1.195,
    "hylla": 1.000,
}

#: Under så här stor prisskillnad mellan attributets möjliga värden är svaret
#: inte värt ett anrop eller en fråga. 10 % enligt uppdraget.
MIN_VALUE_OF_INFORMATION = 0.10

#: Konfidens som krävs för att TRO på ett svar som gör möbeln billigare.
#: Högre än för motsatt riktning, eftersom alla mätta felkällor lutar hitåt:
#: grannröstningen kallade 87 % av bäddsofforna "soffa" och 71 % av hörnsofforna
#: "soffa". Trösklarna är satta mot den asymmetrin, inte mot benchmarkmöblerna.
DOWNGRADE_MIN_CONFIDENCE = 0.75
UPGRADE_MIN_CONFIDENCE = 0.50

#: Hur mycket billigare den härledda typen måste bli för att räknas som en
#: nedgradering alls. Under detta är riktningen brus.
DOWNGRADE_MARGIN = 0.05


def price_level(kind: Optional[str]) -> Optional[float]:
    return PRICE_LEVEL.get(kind) if kind else None


def is_downgrade(before: Optional[str], after: Optional[str]) -> bool:
    """Gör bytet från `before` till `after` möbeln mätbart billigare?"""
    low, high = price_level(after), price_level(before)
    if low is None or high is None:
        return False
    return low < high * (1.0 - DOWNGRADE_MARGIN)


def accept(attrs: Attributes, name: str, value: Any, confidence: float) -> bool:
    """Ska ett föreslaget attributvärde godtas, givet asymmetrin?

    Anropas av lager som får gissa (L2, L3). Texten och användaren går aldrig
    genom den här spärren — de vet.
    """
    before = derive_type(attrs)
    probe = Attributes(dict(attrs.values))
    probe.set(name, value, "user", 1.0, overwrite=True)   # bara för att se typen
    after = derive_type(probe)
    if after == before:
        return confidence >= UPGRADE_MIN_CONFIDENCE
    needed = (DOWNGRADE_MIN_CONFIDENCE if is_downgrade(before, after)
              else UPGRADE_MIN_CONFIDENCE)
    return confidence >= needed


# --------------------------------------------------------------------------
# Value of information
# --------------------------------------------------------------------------
def _median_for(candidates: pd.DataFrame, kind: str) -> Optional[float]:
    subset = candidates[candidates["_derived_type"] == kind]
    if len(subset) < 5:
        return None
    prices = subset["price"].to_numpy(dtype=float)
    prices = prices[prices > 0]
    return float(np.median(prices)) if len(prices) else None


def value_of_information(candidates: pd.DataFrame, attrs: Attributes,
                         attribute: str) -> Tuple[Optional[float], Optional[float]]:
    """Hur mycket skiljer priset mellan attributets möjliga värden?

    Returnerar (kronor, relativ skillnad). None när underlaget inte räcker —
    och då ska frågan ställas ändå om prispåverkan enligt IMPACT är hög, för
    okänt underlag är inte samma sak som känd irrelevans.
    """
    if candidates is None or not len(candidates) or "_derived_type" not in candidates:
        return None, None
    kinds = candidate_types(attrs)
    medians = [m for m in (_median_for(candidates, k) for k in kinds)
               if m is not None]
    if len(medians) < 2:
        return None, None
    low, high = min(medians), max(medians)
    if low <= 0:
        return None, None
    return round(high - low, 1), round((high - low) / low, 3)


def worth_asking(candidates: pd.DataFrame, attrs: Attributes, attribute: str,
                 minimum: float = MIN_VALUE_OF_INFORMATION) -> Tuple[bool, dict]:
    """Är attributet värt ett betalt anrop eller en användarfråga?"""
    if attrs.known(attribute):
        return False, {"reason": "redan känt"}
    impact = IMPACT.get(attribute, 0)
    kronor, relative = value_of_information(candidates, attrs, attribute)
    if relative is None:
        # Inget mätbart underlag. Fråga bara om attributet är prisviktigt i sig.
        return impact >= 4, {"reason": "underlag saknas", "impact": impact}
    if relative < minimum:
        return False, {"reason": "under tröskel", "kronor": kronor,
                       "relative": relative, "impact": impact}
    return True, {"reason": "värt att fråga", "kronor": kronor,
                  "relative": relative, "impact": impact}


# --------------------------------------------------------------------------
# Unionens bredd, och vilken enda fråga som smalnar av den mest
# --------------------------------------------------------------------------
#: Svarsrymden per attribut, för att simulera vad ett svar skulle göra med
#: unionen. `seats` finns inte med: den ändrar inte vilka TYPER som är möjliga,
#: bara priset inom typen, och kan därför aldrig smalna av unionen.
ANSWER_SPACE: Dict[str, tuple] = {
    "corner": (True, False),
    "convertible": (True, False),
    "set_items": (SET_ITEMS_UNKNOWN, 0),
    "storage_kind": ("byra", "hylla", "skank", "vitrin"),
    "chair_kind": ("fatolj", "stol"),
}


def _spread(candidates: pd.DataFrame, kinds) -> Optional[dict]:
    """Prisspridningen över en uppsättning möjliga typer.

    Utan träffmängd går spridningen inte att räkna. Det är inte ett fel — motorn
    kan anropas utan kandidater — så None returneras och anroparen får falla
    tillbaka på `IMPACT`.
    """
    if candidates is None or not len(candidates) or "_derived_type" not in candidates:
        return None
    medians = {k: _median_for(candidates, k) for k in kinds}
    medians = {k: v for k, v in medians.items() if v is not None}
    if not medians:
        return None
    low, high = min(medians.values()), max(medians.values())
    return {
        "types": list(medians),
        "medians": {k: round(v, 0) for k, v in medians.items()},
        "ratio": round(high / low, 3) if low > 0 else None,
    }


def _weight_of(candidates: pd.DataFrame, kinds) -> int:
    """Hur många kandidatannonser som faller inom en typuppsättning.

    Används som sannolikhetsvikt för ett tänkt svar: är 90 % av kandidaterna
    raka soffor är svaret "nej på hörnsektion" mycket troligare än "ja", och det
    ska väga tyngre när frågans förväntade nytta beräknas.
    """
    if candidates is None or "_derived_type" not in candidates:
        return 0
    return int(candidates["_derived_type"].isin(list(kinds)).sum())


def narrowing(candidates: pd.DataFrame, attrs: Attributes,
              attribute: str) -> Optional[dict]:
    """Vad ETT svar på `attribute` skulle göra med unionens bredd.

    Returnerar spridningen före, den viktade förväntade spridningen efter, och
    utfallet per tänkbart svar — så att appen kan visa "svarar du ja blir det
    X, svarar du nej blir det Y" i stället för bara en fråga.
    """
    if attrs.known(attribute) or attribute not in ANSWER_SPACE:
        return None
    before = _spread(candidates, candidate_types(attrs))
    if before is None or before["ratio"] is None or len(before["types"]) < 2:
        return None

    outcomes, total = {}, 0
    for value in ANSWER_SPACE[attribute]:
        probe = Attributes(dict(attrs.values))
        probe.set(attribute, value, "user", 1.0, overwrite=True)
        kinds = candidate_types(probe)
        after = _spread(candidates, kinds)
        weight = _weight_of(candidates, kinds)
        total += weight
        outcomes[str(value)] = {
            "derivedType": derive_type(probe),
            "possibleTypes": list(kinds),
            "spreadRatio": after["ratio"] if after else 1.0,
            "medians": after["medians"] if after else {},
            "weight": weight,
        }
    if not outcomes:
        return None

    if total > 0:
        expected = sum((o["spreadRatio"] or 1.0) * o["weight"]
                       for o in outcomes.values()) / total
    else:
        expected = float(np.mean([o["spreadRatio"] or 1.0
                                  for o in outcomes.values()]))
    return {
        "spreadBefore": before["ratio"],
        "spreadAfterExpected": round(expected, 3),
        "reduction": round(before["ratio"] - expected, 3),
        "outcomes": outcomes,
    }


#: Sammansatta frågor: ETT svar som sätter flera attribut på en gång.
#:
#: Soffamiljen har två oberoende prisviktiga binärer — `corner` (1,205x) och
#: `convertible` (0,823x). En fråga om bara den ena lämnar den andra öppen, och
#: unionen krymper då bara från 2,25x till 1,75x. En fyrvägsfråga löser båda och
#: tar den till 1,0x. Det är skillnaden mellan att fråga en gång och att fråga
#: två gånger, vilket i en app är skillnaden mellan att få svar och inte.
COMPOSITE_QUESTIONS: Dict[str, dict] = {
    "soffa": {
        "id": "soffa_form",
        "fraga": "Vilken sorts soffa är det?",
        "typ": "val",
        "varfor": ("Hörnsoffa prissätts ~20 % högre än en rak soffa och "
                   "bäddsoffa ~18 % lägre. Ett svar avgör båda."),
        "alternativ": [
            {"label": "Rak soffa", "sets": {"corner": False, "convertible": False}},
            {"label": "Hörnsoffa (bildar ett L)", "sets": {"corner": True, "convertible": False}},
            {"label": "Bäddsoffa (går att fälla ut)", "sets": {"corner": False, "convertible": True}},
            {"label": "Hörnsoffa som också är bäddsoffa", "sets": {"corner": True, "convertible": True}},
        ],
    },
    "bord": {
        "id": "bord_form",
        "fraga": "Vad för slags bord är det?",
        "typ": "val",
        "varfor": ("Skillnaden mellan matbord, soffbord och sidobord är upp till "
                   "3x, och en matgrupp prissätts ~48 % lägre än bordet ensamt."),
        "alternativ": [
            {"label": "Matbord, utan stolar",
             "sets": {"sub": "matbord", "set_items": 0}},
            {"label": "Matbord med stolar (matgrupp)",
             "sets": {"sub": "matbord", "set_items": SET_ITEMS_UNKNOWN}},
            {"label": "Soffbord", "sets": {"sub": "soffbord", "set_items": 0}},
            {"label": "Sido- eller avlastningsbord",
             "sets": {"sub": "sidobord", "set_items": 0}},
            {"label": "Skrivbord", "sets": {"sub": "skrivbord", "set_items": 0}},
        ],
    },
}


def composite_narrowing(candidates: pd.DataFrame,
                        attrs: Attributes) -> Optional[dict]:
    """Vad en sammansatt fråga skulle göra med unionen.

    Bara alternativ som fortfarande är möjliga tas med: vet vi redan att soffan
    inte är en hörnsoffa ska det alternativet inte erbjudas.
    """
    base = attrs.get("base")
    spec = COMPOSITE_QUESTIONS.get(str(base)) if base else None
    if spec is None:
        return None
    open_attributes = [a for a in {k for alt in spec["alternativ"] for k in alt["sets"]}
                       if not attrs.known(a)]
    if len(open_attributes) < 2:
        return None            # en enkel fråga räcker, ingen anledning att bunta
    before = _spread(candidates, candidate_types(attrs))
    if before is None or before["ratio"] is None or len(before["types"]) < 2:
        return None

    outcomes, total = {}, 0
    for alternative in spec["alternativ"]:
        probe = Attributes(dict(attrs.values))
        conflict = False
        for name, value in alternative["sets"].items():
            if attrs.known(name) and attrs.get(name) != value:
                conflict = True
                break
            probe.set(name, value, "user", 1.0, overwrite=True)
        if conflict:
            continue
        kinds = candidate_types(probe)
        after = _spread(candidates, kinds)
        weight = _weight_of(candidates, kinds)
        total += weight
        outcomes[alternative["label"]] = {
            "sets": alternative["sets"],
            "derivedType": derive_type(probe),
            "possibleTypes": list(kinds),
            "spreadRatio": after["ratio"] if after else 1.0,
            "weight": weight,
        }
    if len(outcomes) < 2:
        return None
    if total > 0:
        expected = sum((o["spreadRatio"] or 1.0) * o["weight"]
                       for o in outcomes.values()) / total
    else:
        expected = float(np.mean([o["spreadRatio"] or 1.0
                                  for o in outcomes.values()]))
    return {
        "attribute": spec["id"],
        "composite": True,
        "question": spec["fraga"],
        "type": spec["typ"],
        "why": spec["varfor"],
        "spreadBefore": before["ratio"],
        "spreadAfterExpected": round(expected, 3),
        "reduction": round(before["ratio"] - expected, 3),
        "outcomes": outcomes,
    }


def best_narrowing_question(candidates: pd.DataFrame,
                            attrs: Attributes) -> Optional[dict]:
    """Den ENDA fråga som smalnar av unionen mest.

    Poängen med att välja en och inte fråga allt: varje fråga kostar
    användarens tålamod, och unionens bredd beror nästan alltid på ett enda
    attribut. Att fråga om hörnsektion när osäkerheten sitter i bäddfunktionen
    smalnar ingenting.
    """
    base = attrs.get("base")
    if base is None:
        return None
    best = None
    for attribute in relevant_attributes(base):
        info = narrowing(candidates, attrs, attribute)
        if info is None or info["reduction"] <= 0:
            continue
        if best is None or info["reduction"] > best["reduction"]:
            best = {"attribute": attribute, "composite": False, **info}
    # Den sammansatta frågan får konkurrera på samma villkor. Den vinner när den
    # löser flera attribut på en gång, vilket är hela poängen med den.
    composite = composite_narrowing(candidates, attrs)
    if composite and (best is None or composite["reduction"] > best["reduction"]):
        best = composite
    return best


#: Under så här stor kvarvarande spridning är det inte värt att fråga — då är
#: unionen redan smal nog att bara prissätta rakt av.
NARROW_ENOUGH = 1.15


def resolve_or_widen(candidates: pd.DataFrame, attrs: Attributes) -> dict:
    """Fråga eller bredda? Kärnan i kopplingen mellan L4 och L5.

    Tidigare gjorde L5 bara en sak: konstaterade att flera typer var möjliga och
    föreslog ett bredare intervall. Mätningen visade att den breddningen blir
    2,43x på de icke-triviala unionerna — för brett att skicka som prisförslag.

    En enda ja/nej-fråga löser oftast hela osäkerheten, eftersom unionens bredd
    nästan alltid beror på ett attribut. Därför: finns en fråga som smalnar av
    märkbart, föreslå den I STÄLLET för att bredda. Först när frågan är obesvarad
    eller saknas faller vi tillbaka på breddningen.
    """
    before = _spread(candidates, candidate_types(attrs))
    if before is None or before["ratio"] is None or before["ratio"] <= NARROW_ENOUGH:
        return {"action": "prissatt", "spreadRatio": before["ratio"] if before else None}

    question = best_narrowing_question(candidates, attrs)
    if question is None:
        return {
            "action": "bredda",
            "spreadRatio": before["ratio"],
            "widenBy": round((before["ratio"] - 1.0) / 2.0, 3),
            "reason": "ingen fråga smalnar av unionen",
        }
    entry = {
        "action": "fraga",
        "attribute": question["attribute"],
        "composite": bool(question.get("composite")),
        "spreadRatio": before["ratio"],
        "spreadIfAnswered": question["spreadAfterExpected"],
        "reduction": question["reduction"],
        "outcomes": question["outcomes"],
        # Breddningen ligger kvar som fallback om användaren inte svarar.
        "widenIfUnanswered": round((before["ratio"] - 1.0) / 2.0, 3),
    }
    if question.get("composite"):
        entry["question"] = question["question"]
        entry["why"] = question["why"]
        entry["options"] = [
            {"label": label, "sets": o["sets"], "derivedType": o["derivedType"]}
            for label, o in question["outcomes"].items()
        ]
    return entry


# --------------------------------------------------------------------------
# L4 — användarfrågan
# --------------------------------------------------------------------------
#: Frågor formulerade så att appen kan rendera dem rakt av. Ja/nej där det går.
USER_QUESTIONS: Dict[str, dict] = {
    "convertible": {
        "fraga": "Går soffan att fälla ut till säng?",
        "typ": "ja_nej",
        "galler_for": ("soffa",),
        "varfor": "En bäddsoffa prissätts i snitt 20 % lägre än en rak soffa.",
    },
    "corner": {
        "fraga": "Har soffan en hörnsektion (bildar den ett L)?",
        "typ": "ja_nej",
        "galler_for": ("soffa",),
        "varfor": "En hörnsoffa prissätts i snitt 23 % högre än en rak soffa.",
    },
    "set_items": {
        "fraga": "Ingår stolarna i priset?",
        "typ": "ja_nej",
        "galler_for": ("bord",),
        "varfor": "En matgrupp prissätts i snitt 48 % lägre än bordet ensamt.",
    },
    "seats": {
        "fraga": "Hur många sittplatser har soffan?",
        "typ": "antal",
        "galler_for": ("soffa",),
        "varfor": "En 4-sits prissätts dubbelt så högt som en 2-sits.",
    },
    "storage_kind": {
        "fraga": "Har möbeln lådor, öppna hyllplan, eller dörrar?",
        "typ": "val",
        "val": ("lådor", "öppna hyllplan", "glasdörrar", "dörrar"),
        "galler_for": ("forvaring",),
        "varfor": "Skillnaden mellan byrå, hylla och vitrinskåp är upp till 89 %.",
    },
}


def clarifying_questions(candidates: pd.DataFrame, attrs: Attributes,
                         limit: int = 2) -> List[dict]:
    """Frågorna som är värda att ställa till användaren, dyrast först.

    Att fråga är billigare än allt annat i kedjan och exaktare än varje modell —
    men bara om svaret flyttar priset. Därför samma VoI-spärr som för L3.
    """
    base = attrs.get("base")
    if base is None:
        return []
    out = []
    for name, spec in USER_QUESTIONS.items():
        if base not in spec["galler_for"]:
            continue
        ask, why = worth_asking(candidates, attrs, name)
        narrows = narrowing(candidates, attrs, name)
        # En fråga som smalnar av unionen är värd att ställa även när
        # value-of-information inte kunde räknas: den ersätter ett dubbelt så
        # brett intervall med ett smalt, vilket är nyttan i sig.
        if not ask and not (narrows and narrows["reduction"] > 0):
            continue
        entry = {
            "attribute": name,
            "question": spec["fraga"],
            "type": spec["typ"],
            "why": spec["varfor"],
            "priceImpact": why.get("kronor"),
            "priceImpactRatio": why.get("relative"),
            "impactRank": IMPACT.get(name, 0),
            "narrowsUnion": bool(narrows and narrows["reduction"] > 0),
            "spreadBefore": narrows["spreadBefore"] if narrows else None,
            "spreadIfAnswered": narrows["spreadAfterExpected"] if narrows else None,
            "outcomes": narrows["outcomes"] if narrows else None,
        }
        if "val" in spec:
            entry["options"] = list(spec["val"])
        out.append(entry)
    # Frågor som smalnar av unionen först — de ersätter ett brett intervall med
    # ett smalt. Därefter efter kronpåverkan.
    out.sort(key=lambda q: (not q["narrowsUnion"],
                            -(q.get("spreadBefore") or 0) + (q.get("spreadIfAnswered") or 0),
                            -(q["priceImpact"] or 0), -q["impactRank"]))

    # Den sammansatta frågan läggs först när den slår varje enkel fråga. Den är
    # vad appen ska rendera: ETT val som löser hela osäkerheten, i stället för
    # två separata ja/nej-frågor som var för sig lämnar kvar spridning.
    composite = composite_narrowing(candidates, attrs)
    if composite:
        best_simple = max((q.get("spreadBefore") or 0) - (q.get("spreadIfAnswered") or 0)
                          for q in out) if out else 0.0
        if composite["reduction"] > best_simple:
            out.insert(0, {
                "attribute": composite["attribute"],
                "composite": True,
                "question": composite["question"],
                "type": composite["type"],
                "why": composite["why"],
                "options": [
                    {"label": label, "sets": o["sets"],
                     "derivedType": o["derivedType"]}
                    for label, o in composite["outcomes"].items()
                ],
                "priceImpact": None,
                "priceImpactRatio": None,
                "impactRank": 5,
                "narrowsUnion": True,
                "spreadBefore": composite["spreadBefore"],
                "spreadIfAnswered": composite["spreadAfterExpected"],
                "outcomes": composite["outcomes"],
            })
    for entry in out:
        entry.setdefault("composite", False)
    return out[:limit]


# --------------------------------------------------------------------------
# L5 — osäkerheten propagerar till priset, inte till ett gissat typval
# --------------------------------------------------------------------------
def type_confidence(attrs: Attributes) -> str:
    """Hur säkert typvalet är: hög / medel / låg.

    Bygger på källan till `base` och på hur många prisviktiga attribut som
    fortfarande är okända.
    """
    base_source = attrs.source("base")
    if base_source is None:
        return "låg"
    # Bara attribut som är relevanta för bastypen räknas. En soffa saknar
    # `storage_kind` av naturliga skäl och ska inte straffas för det.
    scope = relevant_attributes(attrs.get("base"))
    unknown = [a for a in attrs.unknown(only=scope) if IMPACT.get(a, 0) >= 4]
    if base_source in ("user", "text") and not unknown:
        return "hög"
    if base_source in ("user", "text", "prior"):
        return "medel" if unknown else "hög"
    return "låg"


def uncertainty_spread(candidates: pd.DataFrame, attrs: Attributes) -> Optional[dict]:
    """Prislägena för de typer som fortfarande är möjliga.

    Detta är L5:s kärna: ett okänt attribut ska bli ett BREDARE pris, aldrig ett
    falskt precist. Anroparen får medianerna per möjlig typ och kan välja att
    söka över unionen och bredda intervallet.
    """
    kinds = candidate_types(attrs)
    if len(kinds) < 2 or candidates is None or "_derived_type" not in candidates:
        return None
    medians = {k: _median_for(candidates, k) for k in kinds}
    medians = {k: v for k, v in medians.items() if v is not None}
    if len(medians) < 2:
        return None
    low, high = min(medians.values()), max(medians.values())
    return {
        "possibleTypes": list(medians),
        "medians": {k: round(v, 0) for k, v in medians.items()},
        "spreadRatio": round(high / low, 3) if low > 0 else None,
        "widenBy": round((high / low - 1.0) / 2.0, 3) if low > 0 else None,
    }


def annotate(candidates: pd.DataFrame) -> pd.DataFrame:
    """Lägger på `_derived_type` så VoI och L5 kan räkna medianer per typ."""
    from .text_layer import extract
    frame = candidates.copy()
    frame["_derived_type"] = [
        derive_type(extract(b, prenormalized=True))
        for b in frame["search_blob"]
    ]
    return frame
