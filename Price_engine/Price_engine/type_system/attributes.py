"""Attributmodellen — bärare av värde, källa och konfidens.

Kärnidén i omdesignen: sluta klassa i 14 platta typer och extrahera i stället
oberoende egenskaper, där varje egenskap har sin egen bästa källa. Typen som
motorn söker på blir en *härledd* funktion av attributen.

Vinsten är att ett okänt attribut kan förbli okänt. Den platta klassificeraren
tvingades välja en av 14 etiketter även när den inte visste, och valde då
systematiskt den generiska billigare (bäddsoffa -> soffa i 87 % av fallen).
Här blir okänt i stället ett bredare prisintervall — se `L5` i pricing-kedjan.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple

#: Lagren, i den ordning de får fylla i. Lägre index = billigare och säkrare.
SOURCES = ("user", "text", "prior", "image", "vision", "default")

#: Prispåverkan per attribut. Skalan är MÄTT, inte skattad — siffrorna kommer ur
#: `measure_price_relevance.py` (parvisa medianer inom modellgrupp) och anges som
#: den största prisskillnad attributet kan orsaka:
#:
#:   chair_kind   fatolj/stol 2,60x — störst uppmätt av alla        -> 5
#:   sub          matbord/sidobord 3,00x, matbord/soffbord 2,00x   -> 5
#:   base         korsar hela familjer                             -> 5
#:   seats        4-sits/2-sits 2,00x, 3-sits/2-sits 1,33x         -> 4
#:   set_items    matgrupp/matbord 0,52x (~1,9x)                    -> 4
#:   storage_kind hylla/skank 0,58x (~1,7x), byra/hylla 1,25x       -> 4
#:   corner       hornsoffa/rak 1,23x                              -> 3
#:   convertible  baddsoffa/rak 0,80x (~1,25x)                     -> 3
#:   chaise       divan/rak 0,94x — mätt prisirrelevant             -> 1
#:
#: `chaise` sitter kvar på 1 och inte 0 med flit: attributet styr fortfarande
#: sökexpansionen, det ska bara aldrig kosta ett L3-anrop eller en L4-fråga.
#: `corner_count` ersätter det booleska `corner`. En U-soffa och en L-soffa är
#: inte samma möbel: uppmätt ligger U indikativt 1,43x en enkelhörnad, men med en
#: boolean kollapsade de till samma typ och premien var osynlig även när
#: annonsen stavade ut "U-soffa".
#:
#: 0 = rak, 1 = ett hörn (L/hörnsoffa), 2 = två hörn (U-soffa, dubbeldivan)
IMPACT = {
    "corner_count": 3,
    "chair_kind": 5,
    "sub": 5,
    "base": 5,
    "seats": 4,
    "set_items": 4,
    "storage_kind": 4,
    "corner": 3,
    "convertible": 3,
    "chaise": 1,
}

ATTRIBUTES = tuple(IMPACT)

#: Vilka attribut som alls är relevanta för en given bastyp. Utan den här kartan
#: räknas en soffa som "osäker" för att `storage_kind` är okänt — vilket det ska
#: vara, eftersom en soffa inte har någon förvaringstyp. Samma buggklass som
#: förorenade modellnamnspriorn: attribut måste tolkas i sin bastyps sammanhang.
RELEVANT: Dict[str, Tuple[str, ...]] = {
    "soffa": ("seats", "corner", "corner_count", "convertible", "chaise"),
    "bord": ("sub", "set_items"),
    "forvaring": ("storage_kind",),
    "stol": ("chair_kind",),
    "sang": (),
    "sanggavel": (),
    "spegel": (),
    "fotpall": (),
}


def relevant_attributes(base: Optional[str]) -> Tuple[str, ...]:
    """Attributen som är meningsfulla för bastypen. Okänd bas -> alla."""
    if base is None:
        return ATTRIBUTES
    return RELEVANT.get(str(base), ())


#: `set_items` = "stolarna ingår men antalet står inte i texten".
#: Skiljs från 0 (inga stolar) och från None (vet inte om några ingår alls).
#: Distinktionen är prisviktig: en matgrupp kostar mångdubbelt ett ensamt bord.
SET_ITEMS_UNKNOWN = -1


@dataclass
class Value:
    """Ett attributvärde med sitt ursprung."""

    value: Any
    source: str
    confidence: float
    evidence: Optional[str] = None

    def __post_init__(self) -> None:
        if self.source not in SOURCES:
            raise ValueError(f"okänd källa: {self.source}")
        self.confidence = max(0.0, min(1.0, float(self.confidence)))


@dataclass
class Attributes:
    """Uppsättning attribut under påfyllnad genom lagren L0-L4."""

    values: Dict[str, Value] = field(default_factory=dict)

    def known(self, name: str) -> bool:
        return name in self.values

    def get(self, name: str) -> Any:
        entry = self.values.get(name)
        return entry.value if entry else None

    def source(self, name: str) -> Optional[str]:
        entry = self.values.get(name)
        return entry.source if entry else None

    def confidence(self, name: str) -> float:
        entry = self.values.get(name)
        return entry.confidence if entry else 0.0

    def set(self, name: str, value: Any, source: str, confidence: float,
            evidence: Optional[str] = None, *, overwrite: bool = False) -> bool:
        """Fyller i ett attribut. Returnerar True om det faktiskt skrevs.

        Utan `overwrite` respekteras källhierarkin: ett lager får aldrig skriva
        över ett attribut som ett tidigare (billigare, säkrare) lager redan
        fyllt i. Det är här regeln "texten vinner över bilden" bor, och den är
        avsiktligt strukturell i stället för utspridd i anropen.
        """
        if value is None:
            return False
        current = self.values.get(name)
        if current is not None and not overwrite:
            if SOURCES.index(source) >= SOURCES.index(current.source):
                return False
        self.values[name] = Value(value, source, confidence, evidence)
        return True

    def unknown(self, *, only: Tuple[str, ...] = ATTRIBUTES) -> Tuple[str, ...]:
        return tuple(a for a in only if a not in self.values)

    def conflicts(self, other: "Attributes") -> Dict[str, Tuple[Any, Any]]:
        """Attribut där två uppsättningar säger olika. Rapporteras, döljs inte."""
        return {
            name: (self.get(name), other.get(name))
            for name in self.values
            if other.known(name) and other.get(name) != self.get(name)
        }

    def as_dict(self) -> Dict[str, Dict[str, Any]]:
        return {
            name: {"value": v.value, "source": v.source,
                   "confidence": round(v.confidence, 3), "evidence": v.evidence}
            for name, v in sorted(self.values.items())
        }


def derive_type(attrs: Attributes) -> Optional[str]:
    """Härleder motorns söktyp ur attributen.

    Returnerar None när basen är okänd — det är hela poängen med omdesignen.
    Ett okänt attribut ska ge ett bredare pris, inte en gissad etikett.
    """
    base = attrs.get("base")
    if base is None:
        return None

    if base == "soffa":
        if attrs.get("convertible") is True:
            return "baddsoffa"
        if attrs.get("corner") is True:
            return "hornsoffa"
        # `chaise` är MÄTT prisirrelevant: divan/schäslong ligger på 0,94x en rak
        # soffa (5,9 % skillnad, 510 modellgrupper, KI [0,91, 1,00]) medan en
        # hörnsoffa ligger på 1,23x. Divanen är alltså en soffa prismässigt, och
        # att härleda hörnsoffa ur den skulle överprisa den med ~30 %.
        # Attributet behålls för sökexpansionen, men styr inte typen.
        return "soffa"

    if base == "bord":
        sub, items = attrs.get("sub"), attrs.get("set_items")
        if sub == "matgrupp" or (items is not None and items != 0):
            return "matgrupp"
        return sub or "bord"

    if base == "forvaring":
        return attrs.get("storage_kind") or "forvaring"

    if base == "stol":
        # fatolj/stol är MÄTT 2,60x. Utan undertypen prissätts en fåtölj som en
        # matstol, alltså 61 % för lågt.
        return attrs.get("chair_kind") or "stol"

    return base


#: Värderymden per bastyp, för att räkna ut vilka typer som ännu är möjliga.
#: `chaise` ingår inte: den är mätt prisirrelevant (0,955x) och skulle bara
#: bredda unionen utan att flytta priset. `seats` ingår inte heller — den ändrar
#: priset inom typen, aldrig vilken typ det är.
COMPLETION_SPACE: Dict[str, Dict[str, Tuple]] = {
    "soffa": {"convertible": (True, False), "corner": (True, False)},
    "bord": {
        "sub": ("matbord", "soffbord", "sidobord", "skrivbord", "matgrupp", None),
        "set_items": (0, SET_ITEMS_UNKNOWN),
    },
    "forvaring": {"storage_kind": ("byra", "hylla", "skank", "vitrin")},
    "stol": {"chair_kind": ("fatolj", "stol")},
}


def candidate_types(attrs: Attributes) -> Tuple[str, ...]:
    """Alla typer som fortfarande är möjliga givet det vi vet.

    Räknas genom att **räkna upp kompletteringarna** av de okända attributen och
    köra `derive_type` på var och en. Den handskrivna varianten kunde hamna i
    otakt med `derive_type` och gjorde det: med både `corner` och `convertible`
    kända som True gav den två möjliga typer, trots att `derive_type` är entydig
    (bäddfunktionen vinner). Följden var att en sammansatt L4-fråga såg ut att
    lämna kvar osäkerhet den faktiskt hade löst.

    Uppräkningen är billig — som mest tolv kombinationer — och kan per
    konstruktion inte avvika från `derive_type`.
    """
    base = attrs.get("base")
    if base is None:
        return ()
    space = COMPLETION_SPACE.get(str(base))
    if not space:
        return (str(base),)

    unknown = {name: values for name, values in space.items()
               if not attrs.known(name)}
    if not unknown:
        derived = derive_type(attrs)
        return (derived,) if derived else ()

    out = []
    for combination in itertools.product(*unknown.values()):
        probe = Attributes(dict(attrs.values))
        for name, value in zip(unknown, combination):
            if value is not None:
                probe.set(name, value, "user", 1.0, overwrite=True)
        derived = derive_type(probe)
        if derived:
            out.append(derived)
    return tuple(dict.fromkeys(out))
