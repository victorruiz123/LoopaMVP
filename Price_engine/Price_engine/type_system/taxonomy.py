"""Bron mellan de två taxonomierna.

Motorn har haft två oberoende typindelningar som aldrig talat med varandra:

* **Den gamla** i `price_engine/variant.py` typar korpusen (`listings["variant"]`)
  och driver sökningen. Etiketterna är skrivna med å/ä/ö: `hörnsoffa`, `byrå`,
  `fåtölj`.
* **Den nya** i `type_system` typar frågan. Etiketterna är ASCII-vikta, eftersom
  korpustexten är det: `hornsoffa`, `byra`.

Att koppla ihop dem naivt filtrerar bort **allt**: `"hornsoffa" in ["hörnsoffa"]`
är falskt. Den här modulen gör översättningen explicit och testbar i stället för
att låta den vara en tyst antagelse på båda sidor.

**Bara teckenkodning översätts här.** De semantiska skillnaderna — att gamla har
`fåtölj` som egen typ medan nya lägger den under `stol`, och att nya har `skank`
och `vitrin` som gamla saknar — är prisfrågor, inte kodningsfrågor. De avgörs av
mätning, inte av en mappningstabell. Se `LEGACY_ONLY` och `NEW_ONLY`.
"""

from __future__ import annotations

from typing import Optional, Set

from price_engine.data_loader import normalize_text

#: Gamla etiketter som saknar motsvarighet i den nya taxonomin.
#: `fatolj` låg här tills prisrelevansen mättes: 2,60x en stol, 1 973
#: modellgrupper. Distinktionen behölls och finns nu i BÅDA taxonomierna.
LEGACY_ONLY = {
    "okand": "nya systemet returnerar None i stället",
    "del/tillbehor": "hanteras separat, inte en möbeltyp",
}

#: Nya typer den gamla taxonomin inte kan uttrycka. Alla tre är MÄTT
#: prisrelevanta, vilket är skälet att de finns:
#:   skank    1,691x en hylla
#:   vitrin   1,814x en hylla
#:   soffbord 0,492x ett matbord
NEW_ONLY = {"skank", "vitrin", "soffbord", "sidobord", "skrivbord"}

#: Etiketter som betyder samma sak men stavas olika. Nyckeln är den VIKTA gamla
#: formen, värdet den nya kanoniska.
_ALIASES = {
    "okand": None,          # gamla UNKNOWN -> nya "vet inte"
    "del/tillbehor": None,  # inte en möbeltyp
}


#: Hela den kanoniska vokabulären. Byggs ur attributmodellen så att den aldrig
#: kan hamna i otakt med vad `derive_type` faktiskt kan returnera.
def canonical_types() -> Set[str]:
    from .attributes import COMPLETION_SPACE, RELEVANT, Attributes, candidate_types

    out: Set[str] = set()
    for base in RELEVANT:
        attrs = Attributes()
        attrs.set("base", base, "text", 1.0)
        out.update(candidate_types(attrs))
    return {t for t in out if t}


def is_canonical(label: Optional[str]) -> bool:
    """Är etiketten en typ systemet känner igen?

    Behövs för att en explicit angiven `variant` inte ska godtas bara för att
    den går att vika till ASCII. "obegripligt" är en giltig sträng men ingen
    möbeltyp, och att filtrera på den ger noll träffar.
    """
    return label in canonical_types()


#: Kanonisk form -> svensk visningsform. Den kanoniska är ASCII-vikt eftersom
#: korpusen är det, men "Endast soffa eller baddsoffa" i ett prissvar ser ut som
#: en bugg för användaren. Bara de former som faktiskt skiljer sig står här.
DISPLAY = {
    "hornsoffa": "hörnsoffa",
    "baddsoffa": "bäddsoffa",
    "byra": "byrå",
    "fatolj": "fåtölj",
    "sang": "säng",
    "sanggavel": "sänggavel",
    "skank": "skänk",
}


def display(canonical: Optional[str]) -> Optional[str]:
    """Svensk visningsform av en kanonisk typ. För text som användaren läser."""
    if canonical is None:
        return None
    return DISPLAY.get(canonical, canonical)


def fold(label: Optional[str]) -> Optional[str]:
    """Vikter en etikett till ASCII, som korpusen och den nya taxonomin.

    `hörnsoffa` -> `hornsoffa`, `byrå` -> `byra`, `fåtölj` -> `fatolj`.
    """
    if label is None:
        return None
    folded = normalize_text(str(label)).strip()
    return folded or None


def from_legacy(label: Optional[str]) -> Optional[str]:
    """Gammal etikett -> kanonisk. None när typen inte har någon motsvarighet.

    Returnerar `fatolj` oförändrad: den distinktionen får inte försvinna i en
    kodningsöversättning. Om den ska bort ska det ske efter mätning, synligt.
    """
    folded = fold(label)
    if folded is None:
        return None
    if folded in _ALIASES:
        return _ALIASES[folded]
    return folded


def to_legacy(canonical: Optional[str], available: Optional[Set[str]] = None):
    """Kanonisk -> gammal etikett, för filtrering mot `listings["variant"]`.

    `available` är de etiketter som faktiskt finns i kolumnen. Anges den
    returneras bara etiketter som existerar där — annars filtrerar motorn på ett
    värde som ger noll träffar, vilket är värre än att inte filtrera alls.
    """
    if canonical is None:
        return None
    if canonical in NEW_ONLY:
        # Gamla taxonomin kan inte uttrycka typen. Att tvinga fram närmaste
        # granne (skank -> byrå) vore att kasta bort just den prisskillnad
        # typen finns för. Hellre inget filter.
        return None
    if available is None:
        return canonical
    for label in available:
        if fold(label) == canonical:
            return label
    return None


def legacy_vocabulary(listings) -> Set[str]:
    """De etiketter som faktiskt förekommer i korpusens `variant`-kolumn."""
    if "variant" not in getattr(listings, "columns", ()):
        return set()
    return {v for v in listings["variant"].dropna().unique()}


def bridge_report(listings) -> dict:
    """Vad som går att översätta och vad som går förlorat. För rapporten."""
    legacy = legacy_vocabulary(listings)
    mapped, lost = {}, {}
    for label in sorted(legacy):
        canonical = from_legacy(label)
        if canonical is None:
            lost[label] = "ingen motsvarighet"
        else:
            mapped[label] = canonical
    return {
        "legacy_labels": len(legacy),
        "mapped": mapped,
        "lost": lost,
        "new_only": sorted(NEW_ONLY),
        "legacy_only": sorted(LEGACY_ONLY),
    }
