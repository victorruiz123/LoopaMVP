"""Antalsdetektering: hur många enheter säljer annonsen?

"Stolar, 6 st, Victoria Ghost, 2 667 kr" är sex stolar för 445 kr styck, inte en
stol för 2 667. Motorn läste den som en enhet, och Kartell Victoria Ghost blev
−45 % mot facit. Mönstret är regelbundet i auktionsdatan, där hela poster säljs.

**Konservativ av konstruktion.** Risken går bara ett håll: en felaktig
styckdelning gör priset katastrofalt lågt, och systemet lutar redan lågt — alla
sex katastrofmissar i benchmarken är negativa. Regeln delar därför bara vid
explicit antal i ett entydigt mönster, och rör inte priset vid minsta tvivel.

Mönstren och deras frekvens i korpusen (1 525 135 rader, mätt 2026-08-17):

    "N st"        76 577   5,02 %   Karmstolar, 8 st, "Louis Ghost"
    "par"         43 733   2,87 %   Fåtöljer "Mina", ett par
    "N stycken"   10 318   0,68 %   STOLAR, 2 stycken, gustavianska
    "N-pack"         284   0,02 %   Möbelben i vitt, 4-pack

UTESLUTNA mönster, med skäl:

    "N delar"     23 652   1,55 %   "3delar, bok, Avanti, DUX. tv-bänk" är en
                                    TREDELAD möbel, inte tre enheter. Ordet
                                    beskriver konstruktion, inte antal.
    "set om N"       196   0,01 %   för få för att gå att validera
    "N-sits"      24 768   1,62 %   FÄLLA: sitsantal, aldrig styckantal
    "N år"           508   0,03 %   FÄLLA: ålder

Vanligaste antalen i "N st": 2 (62 468), 4 (39 314), 6 (22 746), 3 (13 236).
"""

from __future__ import annotations

import re
from typing import Optional

#: Rimlighetstak. Fler än så här enheter i en möbelannons är sannolikt något
#: annat — ett artikelnummer, ett mått eller en beskrivning av innehållet.
MAX_UNITS = 12

#: Mönstren i den ordning de prövas. Först träff vinner.
_PATTERNS = (
    re.compile(r"\b(\d{1,2})\s*st\b"),
    re.compile(r"\b(\d{1,2})\s*stycken\b"),
    re.compile(r"\b(\d{1,2})\s*-?\s*pack\b"),
)

#: "ett par" och "1 par" betyder två. "par" utan bestämning gör det också, men
#: bara när inget annat antal står i titeln — se units().
_PAIR = re.compile(r"\b(?:ett|en|1)?\s*par\b")

#: Ord som gör en sifferträff till något ANNAT än ett styckantal. Prövas i ett
#: fönster efter siffran, eftersom "3-sits" och "3 st" ser likadana ut fram till
#: sista tecknet.
_NOT_COUNT = re.compile(
    r"\b\d{1,2}\s*-?\s*(?:sits|sitt|sittplatser|ar\b|arig|manader|cm|mm|m\b"
    r"|kg|tum|delar|del\b|pack\s*om)"
)


def units(title: str) -> Optional[int]:
    """Antal enheter annonsen säljer, eller None när det inte går att avgöra.

    None betyder "rör inte priset". Det är det säkra svaret och ska returneras
    vid minsta tvetydighet — flera olika antal i samma titel, orimliga tal, eller
    en sifferträff som lika väl kan vara ett sitsantal.
    """
    if not title:
        return None
    text = str(title).lower()

    # Ett sitsantal eller mått i titeln gör hela titeln misstänkt bara om det
    # ÄR den siffra vi skulle läsa. Därför maskeras de träffarna bort först, i
    # stället för att avvisa titeln helt: "Soffa 3-sits + 2 fåtöljer, 2 st"
    # ska fortfarande gå att läsa.
    masked = _NOT_COUNT.sub(" ", text)

    found = set()
    for pattern in _PATTERNS:
        for match in pattern.findall(masked):
            value = int(match)
            if 1 <= value <= MAX_UNITS:
                found.add(value)

    if not found and _PAIR.search(masked):
        found.add(2)

    if len(found) != 1:
        # Noll träffar -> okänt. Flera olika antal -> tvetydigt, och att gissa
        # vilket som gäller priset är precis den sorts gissning som gör felet
        # katastrofalt.
        return None
    value = found.pop()
    return value if value > 1 else None


def per_unit(price: float, title: str) -> tuple:
    """(styckpris, antal) — eller (priset orört, None) när antalet är okänt."""
    count = units(title)
    if not count or price is None or price <= 0:
        return price, None
    return price / count, count
