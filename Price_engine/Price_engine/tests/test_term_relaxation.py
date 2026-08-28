"""Termuppmjukning: ett okänt ord får inte tysta hela frågan.

Sökningen är konjunktiv utan reservväg, så "Matgrupp byCrea" gav noll träffar
och inget svar — trots att "matgrupp" ensamt ger 17 386 annonser. Rätt beteende
är att släppa ordet som ingen annons innehåller och svara på resten, med
osäkerheten redovisad.

Kravet som testerna vaktar: **uppmjukningen får aldrig ersätta ett svar som
redan bar.** Den ska fylla tystnad, inte bredda en fungerande sökning.
"""

from __future__ import annotations

import pandas as pd
import pytest

from price_engine import config, pricing
from type_system import grouping


def _corpus(spec) -> pd.DataFrame:
    names, prices = [], []
    for title, count, price in spec:
        names += [title] * count
        prices += [float(price) + i for i in range(count)]
    frame = pd.DataFrame({
        "name": names,
        "name_norm": [pricing.normalize_text(n) for n in names],
        "search_blob": [pricing.normalize_text(n) for n in names],
        "price": prices, "price_kind": "asking", "brand_norm": None,
        "source": "test", "variant": "matgrupp", "derived_type": "matgrupp",
        "condition_norm": None, "condition_tier": None,
        "listed_at": pd.Timestamp("2026-08-01", tz="UTC"),
    })
    assigned = grouping.assign_cells(frame["name"])
    for column in assigned.columns:
        frame[column] = assigned[column].to_numpy()
    return frame


@pytest.fixture
def corpus():
    return _corpus([("Matgrupp ek bord och stolar", 40, 3000),
                    ("Matgrupp furu", 20, 2000)])


def test_unknown_word_is_dropped(corpus):
    """"bycrea" finns inte i korpusen -> släpps, frågan besvaras ändå."""
    answer = pricing.price_query(corpus, name="Matgrupp byCrea", brand=None,
                                 image_rerank=False)
    assert answer["default"] is not None, "tystnad i stället för svar"
    assert answer["relaxedTerms"] == ["bycrea"]
    assert answer["confidence"] == "low"
    assert "utelämnades" in answer["note"]


def test_working_search_is_never_relaxed(corpus):
    """Kärnkravet: en sökning som bär rörs inte."""
    answer = pricing.price_query(corpus, name="Matgrupp ek", brand=None,
                                 image_rerank=False)
    assert answer["relaxedTerms"] is None
    assert answer["confidence"] != "low" or "utelämnades" not in answer["note"]


def test_missing_words_are_dropped_before_known_ones(corpus):
    """Prioritetsordningen: ord utan egna träffar går först."""
    hits, dropped, trail = pricing._relax_search(
        corpus, "Matgrupp bycrea ek", None)
    assert dropped[0] == "bycrea"
    assert trail[0]["aloneInCorpus"] == 0


def test_relaxation_reports_before_and_after(corpus):
    """Spåret ska gå att granska utan att köra om."""
    _, _, trail = pricing._relax_search(corpus, "Matgrupp byCrea", None)
    assert trail and trail[0]["term"] == "bycrea"
    assert trail[0]["before"] == 0
    assert trail[0]["after"] >= config.TERM_RELAX_MIN


def test_single_token_is_never_relaxed(corpus):
    """En ensam term kan inte släppas — det ger tom sökning."""
    hits, dropped, _ = pricing._relax_search(corpus, "bycrea", None)
    assert hits is None and dropped == []


def test_relaxation_only_widens(corpus):
    """Uppmjukningen får aldrig ge FÄRRE träffar än utgångsläget."""
    before = pricing.find_listings(corpus, "Matgrupp byCrea", None,
                                   condition=None, price_kind=None)
    after, dropped, _ = pricing._relax_search(corpus, "Matgrupp byCrea", None)
    assert len(after) > len(before)


def test_attributes_read_before_relaxation(corpus):
    """Ett släppt ord ska ändå ha hunnit styra typen.

    Läs först, stryk sen — samma princip som core_name-fixen. Annars förlorar
    uppmjukningen den information den bara flyttade ur sökningen.
    """
    answer = pricing.price_query(
        corpus, name="Matgrupp byCrea", brand=None,
        attribute_text="Matgrupp byCrea", image_rerank=False)
    assert answer["derivedType"] == "matgrupp"


def test_threshold_is_configurable(corpus, monkeypatch):
    monkeypatch.setattr(config, "TERM_RELAX_MIN", 1)
    answer = pricing.price_query(corpus, name="Matgrupp byCrea", brand=None,
                                 image_rerank=False)
    assert answer["relaxedTerms"] is None or answer["default"] is not None
