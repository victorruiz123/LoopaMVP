"""De två lexikonen ska säga samma sak om samma ord.

`config/vocab.yaml` styr cellfiltret och grupperingen. `type_system/lexicon.py`
styr attributkedjan. De läses av olika kodvägar, och när de divergerar ger SAMMA
fråga olika svar beroende på vilken väg som råkar köras.

Det hände: `u-soffa` fanns i lexicon.py men inte i vocab.yaml, så
"Mio Friday U-soffa" gav `typer=[]` i cellfiltret och `hornsoffa` i kedjan.
Cellfiltret gjorde därför ingenting alls för U-soffor, och premien blev osynlig.

Ett fel som inte syns i något enskilt test — bara i skillnaden mellan två.
"""

from __future__ import annotations

import pytest

from type_system import chain, grouping
from type_system import lexicon as lex


#: Formord som MÅSTE ge samma möbeltyp i båda vägarna.
SHARED_FORMS = [
    ("hörnsoffa", "hornsoffa"),
    ("hornsoffa", "hornsoffa"),
    ("l-soffa", "hornsoffa"),
    ("u-soffa", "hornsoffa"),
    ("vinkelsoffa", "hornsoffa"),
    ("bäddsoffa", "baddsoffa"),
    ("soffa", "soffa"),
]


@pytest.mark.parametrize("word,expected", SHARED_FORMS)
def test_both_lexicons_agree(word, expected):
    """Samma ord, samma typ, oavsett kodväg."""
    query = f"Mio Friday {word}"
    assert expected in grouping.classify(query).types, "vocab.yaml"
    assert chain.resolve(name=query, ask_user=False).derived_type == expected, \
        "lexicon.py"


#: Hörnord som med AVSIKT inte är hörnsoffor i vocab.yaml. En lös hörnsektion
#: eller modul är en DEL av en modulsoffa, inte en soffa — grouping hanterar dem
#: via `_SECTION_WORDS` och flaggar `is_section`. Att lägga dem under
#: `hornsoffa` hade gjort lösa delar till hela soffor.
SECTION_NOT_SOFA = frozenset({
    "hornsektion", "horndel", "hornmodul", "horngrupp",
})

#: Sammansatt form som hör till två typer samtidigt. Lämnad utanför tills
#: någon bestämmer vilken som ska vinna.
AMBIGUOUS = frozenset({"hornbaddsoffa"})


def test_corner_words_are_in_vocab():
    """Varje hörnord som betecknar en HEL hörnsoffa ska finnas i båda lexikonen.

    Riktningen som faktiskt gick sönder: lexicon.py växte, vocab.yaml följde
    inte med, och cellfiltret slutade tyst känna igen orden.

    Sektions- och modulorden är undantagna med avsikt och listade explicit —
    de ska INTE vara hörnsoffor, för en lös hörnsektion är en del av en
    modulsoffa.
    """
    vocab = set(grouping.vocab()["product_types"]["hornsoffa"])
    folded = {w.replace("-", "").replace(" ", "") for w in vocab}
    missing = [w for w in lex.CORNER_WORDS
               if w not in SECTION_NOT_SOFA and w not in AMBIGUOUS
               and w not in vocab
               and w.replace("-", "").replace(" ", "") not in folded]
    assert not missing, (
        f"Finns i lexicon.CORNER_WORDS men inte i vocab.yaml: {missing}. "
        "Lägg till dem under product_types.hornsoffa, eller i "
        "SECTION_NOT_SOFA om de betecknar en lös del."
    )


def test_section_words_stay_sections():
    """Undantagslistan ska stämma: sektionsorden får inte bli hela soffor."""
    from type_system.grouping import _SECTION_WORDS

    for word in ("hornsektion", "horndel"):
        assert word in _SECTION_WORDS, word
        assert grouping.classify(f"Mio Friday {word}").is_section


def test_u_sofa_is_recognised_by_both():
    """Regressionen som startade allt."""
    query = "Mio Friday U-soffa"
    assert grouping.classify(query).types == ["hornsoffa"]
    assert chain.resolve(name=query, ask_user=False).derived_type == "hornsoffa"
