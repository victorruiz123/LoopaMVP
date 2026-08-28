"""Funktionsord är aldrig hårda sökkrav.

Sökningen är konjunktiv: varje ord i söknyckeln måste finnas i annonstexten. Ett
`med` blir därmed ett krav som halverar underlaget utan att identifiera något.

Uppmätt: av 632 Mio Madison-annonser innehåller 95 ordet "med", så tre
formuleringar av samma fråga gav tre olika priser (4 275 / 3 794 / 2 968 kr).
Testerna kräver att formuleringarna konvergerar.
"""

from __future__ import annotations

import pandas as pd
import pytest

from price_engine import config, pricing
from type_system import grouping


@pytest.fixture
def corpus() -> pd.DataFrame:
    """Madison-annonser där bara en minoritet råkar skriva "med"."""
    names = (["Mio Madison divansoffa ljusgra"] * 30
             + ["Mio Madison soffa med divan"] * 10)
    frame = pd.DataFrame({
        "name": names,
        "name_norm": [pricing.normalize_text(n) for n in names],
        "search_blob": [pricing.normalize_text(n) for n in names],
        "price": [5000.0 + i for i in range(30)] + [5100.0 + i for i in range(10)],
        "price_kind": "asking", "brand_norm": None, "source": "test",
        "variant": "soffa", "derived_type": "soffa",
        "condition_norm": None, "condition_tier": None,
        "listed_at": pd.Timestamp("2026-08-01", tz="UTC"),
    })
    assigned = grouping.assign_cells(frame["name"])
    for column in assigned.columns:
        frame[column] = assigned[column].to_numpy()
    return frame


def test_stopwords_are_stripped():
    clean, ignored = pricing.strip_stopwords("Mio Madison med divan")
    assert clean == "mio madison divan"
    assert ignored == ["med"]


def test_only_stopwords_is_left_alone():
    """Tom söknyckel matchar hela korpusen — mycket värre än en dålig nyckel."""
    text = "med och till"
    clean, ignored = pricing.strip_stopwords(text)
    assert clean == text
    assert ignored == []


def test_empty_input_is_safe():
    assert pricing.strip_stopwords("") == ("", [])
    assert pricing.strip_stopwords(None) == (None, [])


def test_furniture_words_are_never_stripped():
    """`soffa`, `divan`, `ek` bär produktinformation och står i GENERIC_TOKENS
    men får ALDRIG strykas ur sökningen — listorna har olika jobb."""
    for word in ("soffa", "divan", "ek", "hornsoffa", "matbord"):
        assert word not in config.SEARCH_STOPWORDS, word
        clean, _ = pricing.strip_stopwords(f"Mio Madison {word}")
        assert word in clean


def test_phrasings_converge(corpus):
    """Kärnkravet: samma fråga, olika formulering, samma svar."""
    answers = {}
    for text in ("Mio Madison med divan", "Mio Madison divan",
                 "Mio Madison +divan"):
        answers[text] = pricing.price_query(
            corpus, name=text, brand=None, attribute_text=text,
            image_rerank=False)
    defaults = {a["default"] for a in answers.values()}
    assert len(defaults) == 1, {k: v["default"] for k, v in answers.items()}
    counts = {a["matchCount"] for a in answers.values()}
    assert len(counts) == 1, counts


def test_ignored_terms_are_reported(corpus):
    """Strukna ord ska synas i svaret, annars är beteendet osynligt."""
    answer = pricing.price_query(corpus, name="Mio Madison med divan",
                                 brand=None, image_rerank=False)
    assert answer["ignoredTerms"] == ["med"]
    answer = pricing.price_query(corpus, name="Mio Madison divan",
                                 brand=None, image_rerank=False)
    assert answer["ignoredTerms"] is None


def test_stopword_removal_widens_not_narrows(corpus):
    """Strykningen får bara ge FLER träffar, aldrig färre."""
    with_stop = pricing.find_listings(corpus, "Mio Madison med divan", None,
                                      condition=None, price_kind=None)
    without = pricing.find_listings(corpus, "Mio Madison divan", None,
                                    condition=None, price_kind=None)
    assert len(with_stop) == len(without) == 40
