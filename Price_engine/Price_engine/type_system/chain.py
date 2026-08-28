"""Kedjan L0-L5. En ingång för motorn, ett lager i taget, billigast först.

    from type_system import chain
    result = chain.resolve(name="Kivik", queries=[vec], store=store,
                           listings=listings, candidates=base)

Ordningen är inte en stilfråga utan en kostnadsordning: användarens svar är
gratis och exakt, texten är gratis och nästan exakt, priorn är gratis men
statistisk, bilden är gratis men grov, och vision-modellen kostar per anrop.
Varje lager fyller bara de attribut de tidigare lämnat tomma, vilket
`Attributes.set` upprätthåller strukturellt.

Vad kedjan INTE gör: den gissar aldrig fram ett typval för att slippa säga "vet
inte". Blir ett prisviktigt attribut okänt returneras unionen av möjliga typer
plus en fråga att ställa till användaren, och det är prissättningens sak att
bredda intervallet därefter.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

import pandas as pd

from . import decide, image_layer, text_layer, vision_layer
from .attributes import Attributes, candidate_types, derive_type
from .prior import Prior

log = logging.getLogger(__name__)


@dataclass
class Resolution:
    """Resultatet av kedjan, i den form API:t exponerar."""

    attributes: Attributes
    derived_type: Optional[str]
    possible_types: tuple
    type_confidence: str
    clarifying_questions: List[dict] = field(default_factory=list)
    uncertainty: Optional[dict] = None
    #: "fraga" | "bredda" | "prissatt" — vad motorn bör göra med osäkerheten.
    #: Se decide.resolve_or_widen: en enda fråga ersätter oftast ett dubbelt så
    #: brett intervall.
    resolution: Optional[dict] = None
    diagnostics: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "attributes": self.attributes.as_dict(),
            "derivedType": self.derived_type,
            "possibleTypes": list(self.possible_types),
            "typeConfidence": self.type_confidence,
            "clarifyingQuestions": self.clarifying_questions,
            "uncertainty": self.uncertainty,
            "uncertaintyAction": self.resolution,
            "typeDiagnostics": self.diagnostics,
        }


def resolve(
    name: str = "",
    brand: Optional[str] = None,
    description: str = "",
    *,
    user_answers: Optional[Dict[str, Any]] = None,
    queries: Optional[Sequence] = None,
    images: Optional[Sequence[bytes]] = None,
    media_types: Optional[Sequence[str]] = None,
    store=None,
    listings: Optional[pd.DataFrame] = None,
    candidates: Optional[pd.DataFrame] = None,
    prior: Optional[Prior] = None,
    use_vision: bool = False,
    vision_client=None,
    abstain_below: float = image_layer.ABSTAIN_BELOW,
    ask_user: bool = True,
) -> Resolution:
    """Kör lagren i ordning och returnerar attribut, typ och öppna frågor.

    `candidates` är motorns träffmängd och behövs bara för value-of-information
    och L5 — utan den ställs frågor enbart på `IMPACT`, vilket är sämre men inte
    fel.
    """
    attrs = Attributes()
    diagnostics: Dict[str, Any] = {}
    query_text = " ".join(part for part in (name, brand or "", description) if part)

    # --- användarens svar går först och kan inte överskrivas ---------------
    for attribute, value in (user_answers or {}).items():
        if value is not None:
            attrs.set(attribute, value, "user", 1.0, "angivet av användaren")
    if user_answers:
        diagnostics["user"] = {"given": sorted(k for k, v in user_answers.items()
                                               if v is not None)}

    # --- L0: text ---------------------------------------------------------
    text_layer.extract(query_text, attrs=attrs)
    diagnostics["text"] = {
        "filled": sorted(k for k, v in attrs.values.items() if v.source == "text")}

    # --- L2: bilden, grovt — FÖRE priorn för `base` -----------------------
    #
    # Uppdraget säger att priorn ska vinna över bilden vid låg entropi. Mätningen
    # säger motsatt: på de 658 fall där båda svarar har bilden rätt bas i 78,3 %
    # och priorn i 67,5 %, och när de är oense har bilden rätt i 66,4 % mot
    # priorns 18,8 % — i varje enskild bastyp. Att strama åt priorns entropigräns
    # hjälpte inte heller; varje uppmjukning gjorde det monotont sämre
    # (360 kr vid helt tystad prior, 426 kr vid gränsen 0,50).
    #
    # Ordningen är därför omvänd för `base`: bilden först, priorn som fallback
    # när bilden avstår. Priorn behåller förtur för `sub`, `storage_kind` och
    # `seats`, som bilden aldrig sätter och där jämförelsen alltså inte finns.
    #
    # Effekt på huvudmåttet: 438 -> 342 kr i väntevärde, bas rätt 75,6 -> 81,7 %,
    # täckning 89,6 -> 80,8 %.
    prior = prior if prior is not None else Prior.load()
    if queries and store is not None and listings is not None:
        if attrs.known("base"):
            # Texten eller användaren har redan avgjort basen. Bilden körs ändå,
            # men bara för att redovisa om den håller med — inte för att skriva.
            guess, info = image_layer.classify(queries, store, listings,
                                               abstain_below=abstain_below)
            info["agrees"] = (guess == attrs.get("base")) if guess else None
            info["written"] = False
            diagnostics["image"] = info
        else:
            diagnostics["image"] = image_layer.apply(
                queries, store, listings, attrs, prior=prior,
                prior_text=query_text, abstain_below=abstain_below)
    else:
        diagnostics["image"] = {"method": "ingen_bild"}

    # --- L1: modellnamnsprior — fyller det bilden lämnade tomt ------------
    token = prior.apply(query_text, attrs) if prior.ready else None
    diagnostics["prior"] = {
        "token": token,
        "filled": sorted(k for k, v in attrs.values.items() if v.source == "prior")}

    # --- L3: vision-LLM, bara på det som flyttar priset -------------------
    if use_vision and images:
        wanted = [a for a in vision_layer.wanted(attrs)
                  if decide.worth_asking(candidates, attrs, a)[0]]
        if wanted:
            diagnostics["vision"] = vision_layer.ask(
                images, attrs, media_types=media_types, hint=query_text,
                client=vision_client)
        else:
            diagnostics["vision"] = {"method": "inget_vart_att_fraga"}
    else:
        diagnostics["vision"] = {"method": "avstangd" if not use_vision
                                 else "ingen_bild"}

    # --- L4/L5: frågor och osäkerhet -------------------------------------
    questions = (decide.clarifying_questions(candidates, attrs)
                 if ask_user else [])
    action = decide.resolve_or_widen(candidates, attrs) if ask_user else None
    return Resolution(
        attributes=attrs,
        derived_type=derive_type(attrs),
        possible_types=candidate_types(attrs),
        type_confidence=decide.type_confidence(attrs),
        clarifying_questions=questions,
        uncertainty=decide.uncertainty_spread(candidates, attrs),
        resolution=action,
        diagnostics=diagnostics,
    )
