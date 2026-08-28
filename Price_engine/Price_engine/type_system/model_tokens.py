"""Modellord — grupperingsnyckeln som ersätter den tomma märkeskolumnen.

`brand_norm` är tom för 141 067 av 145 219 soffannonser: bara 3 % har märke. En
prior nycklad på (märke, modell) skulle därför täcka nästan ingenting. Ett
distinktivt ord i annonsnamnet — `kivik`, `lamino`, `strandmon` — täcker desto
mer, och ligger dessutom närmare hur användaren faktiskt söker.
"""

from __future__ import annotations

import collections
import re
from typing import Iterable, Set

from price_engine import config

from . import lexicon as lex

TOKEN = re.compile(r"[0-9a-z]+(?:-[0-9a-z]+)*")

#: Ord som aldrig är modellnamn: generiska ord, attributord, material, färg.
NOT_MODEL: Set[str] = (
    set(config.GENERIC_TOKENS)
    | {w for words in lex.BASE_WORDS.values() for w in words}
    | set(lex.CHAISE_WORDS) | set(lex.CORNER_WORDS) | set(lex.CONVERTIBLE_WORDS)
    | set(lex.CHAISE_EXCLUDE) | set(lex.CONVERTIBLE_EXCLUDE)
    | set(lex.CORNER_NOT_SOFA) | set(lex.CORNER_AMBIGUOUS)
    | set(lex.STORAGE_EXCLUDE)
    | {w for words in lex.STORAGE_KINDS.values() for w in words}
    | {w for words in lex.TABLE_SUBS.values() for w in words}
)


def distinctive(names: Iterable[str], lo: int = 12, hi: int = 40_000) -> Set[str]:
    """Tokens vanliga nog att gruppera på, men inte generiska.

    Övre gränsen finns för att ett ord som förekommer i hundratusen annonser är
    ett vanligt ord, inte ett modellnamn — oavsett om det står i stopplistan.
    """
    counter: collections.Counter = collections.Counter()
    for name in names:
        counter.update(set(TOKEN.findall(name)))
    return {
        token for token, count in counter.items()
        if lo <= count <= hi and len(token) >= 3
        and token not in NOT_MODEL and not token.isdigit()
    }


def of(name: str, known: Set[str]) -> tuple:
    """Modellorden i ett annonsnamn, i den ordning de står."""
    return tuple(t for t in TOKEN.findall(name or "") if t in known)
