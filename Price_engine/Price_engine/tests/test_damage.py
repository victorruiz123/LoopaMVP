"""Skadeflaggorna. Extraherade innan `condition_text` raderas.

Fältet är ifyllt på 470 278 rader och försvinner i upphovsrättssaneringen.
Testerna vaktar att det som ersätter det faktiskt fångar informationen — och
att auktionshusens standardfraser inte blir falska skador.
"""

from __future__ import annotations

import pytest

from type_system.damage import DAMAGE_WORDS, columns, flags, fold, score


@pytest.mark.parametrize("text,expected", [
    ("Bruksslitage", "wear"),
    ("Ytslitage och märken", "wear"),
    ("Bordets skiva med repor", "scratch"),
    ("Fläckar på sitsen", "stain"),
    ("Färgbortfall ställvis", "stain"),
    ("Fanerskador på sidan", "damage"),
    ("Stötmärken och slagmärken", "damage"),
    ("Torrsprickor i träet", "crack"),
    ("Spricka i ena sidan", "crack"),
    ("Nyckel saknas", "defect"),
    ("Trasig gångjärn", "defect"),
])
def test_damage_words_are_caught(text, expected):
    assert flags(text)[expected] is True


@pytest.mark.parametrize("text", [
    "Key/keys included",            # 12 319 förekomster, auktionshusfras
    "Keys missing",                 # "missing" ensamt om nyckel — se nedan
    "",
    "Mycket bra skick",
    "Nyskick",
])
def test_standard_phrases_are_not_damage(text):
    """Auktionshusens fraser får inte bli skador.

    "Keys missing" är gränsfallet: nyckeln till ett skåp saknas, vilket ÄR en
    defekt i möbelns fullständighet. Testet dokumenterar att vi flaggar det —
    hellre en flagga för mycket i råmaterialet än en förlorad signal, eftersom
    fritexten raderas och beslutet inte går att ompröva sedan.
    """
    result = flags(text)
    if text == "Keys missing":
        assert result["defect"] is True
    else:
        assert not any(result.values()), text


def test_repaired_is_not_defect():
    """En renoverad möbel är LAGAD, inte trasig."""
    assert flags("Renoverad och omklädd")["defect"] is False
    assert flags("Restaurerad 1990")["defect"] is False


def test_diacritics_are_folded():
    """condition_text är RÅ text — å/ä/ö måste fällas innan matchning."""
    assert fold("Fläckar") == "flackar"
    assert flags("Fläckar")["stain"] is True
    assert flags("FLÄCKAR")["stain"] is True


def test_several_categories_at_once():
    result = flags("Bruksslitage, repor och fläckar samt spricka")
    assert result["wear"] and result["scratch"] and result["stain"]
    assert result["crack"]
    assert score("Bruksslitage, repor och fläckar samt spricka") == 4


def test_empty_gives_all_false():
    assert score("") == 0
    assert score(None) == 0
    assert not any(flags(None).values())


def test_columns_shape():
    out = columns(["Bruksslitage", "", "Repor och fläckar"])
    assert set(out) == {f"damage_{k}" for k in DAMAGE_WORDS} | {"damage_count"}
    assert out["damage_wear"] == [True, False, False]
    assert out["damage_count"] == [1, 0, 2]


def test_word_boundary_prevents_varumarke():
    """`marke` finns inuti *varumärke* — som delsträng gav det 20 966 falska
    skador. Samma buggklass som `lsoffa` inuti *hallsoffa*."""
    assert flags("Varumärke IKEA")["damage"] is False
    assert flags("Marknadspris 5000")["damage"] is False
    assert flags("Märken på skivan")["damage"] is True


def test_negation_is_a_known_limitation():
    """Dokumenterar medvetet beteende, inte en bugg.

    "Inga märken" flaggas som skada. Negation förekommer i ~2,0 % av
    skicktexterna och hanteras inte: flaggorna är råmaterial för en framtida
    skickmodell, inte ett prisavdrag, så en falsk flagga kostar inget medan en
    förlorad signal är oåterkallelig när fritexten raderats.
    """
    assert flags("Inga märken")["damage"] is True


# --------------------------------------------------------------------------
# Gradering — spärr mot att graden går förlorad igen
# --------------------------------------------------------------------------
from type_system.damage import GRADE_WINDOW, grade_columns, grades   # noqa: E402


@pytest.mark.parametrize("text,expected", [
    ("Liten fläck på sitsen", {"stain": 0}),
    ("Knappt synlig spricka", {"crack": 0}),
    ("Smärre repor", {"scratch": 0}),
    ("Kraftigt slitage", {"wear": 2}),
    ("Omfattande skador", {"damage": 2}),
    ("Repor förekommer", {"scratch": 1}),
    ("Bruksslitage", {"wear": 1}),
])
def test_grades_are_read(text, expected):
    assert grades(text) == expected


def test_amplifier_wins_over_diminisher():
    """"små repor och kraftigt slitage" får inte läsas som en lindrig annons."""
    out = grades("Kraftigt slitage och små repor")
    assert out["wear"] == 2
    assert out["scratch"] == 0


def test_grade_only_for_triggered_categories():
    """En kategori som inte nämnts får ingen grad — "inte nämnd" är inte
    samma sak som "nämnd som liten"."""
    out = grades("Liten fläck")
    assert set(out) == {"stain"}


def test_distant_adjective_does_not_grade():
    """Ett adjektiv utanför fönstret beskriver något annat."""
    far = "Liten " + " ".join(["ord"] * (GRADE_WINDOW + 3)) + " fläck"
    assert grades(far)["stain"] == 1


def test_grade_columns_shape():
    out = grade_columns(["Liten fläck", "Kraftigt slitage", ""])
    assert out["grade_stain"] == [0, None, None]
    assert out["grade_wear"] == [None, 2, None]
    assert out["grade_max"] == [0, 2, None]


def test_existing_corpus_has_no_grades():
    """Dokumenterar förlusten. Graden fanns i `condition_text` och försvann med
    den — den här modulen är en spärr mot upprepning, inte en räddning."""
    assert grades("") == {}
