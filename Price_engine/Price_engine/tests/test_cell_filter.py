"""CELL_FILTER_ENABLED: cellflaggorna som rensning PÅ textsökningen.

Skillnaden mot `PRICE_CELLS_ENABLED` är hela poängen och testas därför explicit:
cellfiltret får aldrig ändra VILKA annonser sökningen hittar, bara ta bort skräp
ur det den hittade. Mätningen som ledde hit visade att en cell som ersätter
sökningen kollapsar till märke x typ och blir bredare än sökningen den ersatte.
"""

from __future__ import annotations

import pandas as pd
import pytest

from price_engine import config, pricing
from type_system import grouping


def _corpus(names, prices) -> pd.DataFrame:
    frame = pd.DataFrame({
        "name": names,
        "name_norm": [pricing.normalize_text(n) for n in names],
        "search_blob": [pricing.normalize_text(n) for n in names],
        "price": [float(p) for p in prices],
        "price_kind": "asking",
        "brand_norm": None,
        "source": "test",
        "variant": "soffa",
        "derived_type": "soffa",
        "condition_norm": None,
        "condition_tier": None,
        "listed_at": pd.Timestamp("2026-06-01", tz="UTC"),
    })
    assigned = grouping.assign_cells(frame["name"])
    for column in assigned.columns:
        frame[column] = assigned[column].to_numpy()
    return frame


@pytest.fixture
def corpus() -> pd.DataFrame:
    """Ektorp-soffor plus det skräp som textsökningen på "Ektorp" drar in."""
    names = (["IKEA Ektorp 3-sits soffa"] * 40
             + ["Klädsel till IKEA Ektorp soffa"] * 20
             + ["IKEA Ektorp soffa med fotpall"] * 15
             + ["Soffa liknande IKEA Ektorp"] * 10)
    prices = [3000] * 40 + [300] * 20 + [4500] * 15 + [1200] * 10
    return _corpus(names, prices)


def _run(listings, **kwargs):
    return pricing.price_query(listings, image_rerank=False, **kwargs)


def test_flag_off_is_todays_behaviour(corpus, monkeypatch):
    """Flaggan av: träffmängden är exakt textsökningens, som idag."""
    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", False)
    monkeypatch.setattr(config, "PRICE_CELLS_ENABLED", False)
    answer = _run(corpus, name="Ektorp", brand="IKEA")

    expected = pricing.find_listings(corpus, "Ektorp", "IKEA",
                                     condition=None, price_kind=None)
    assert answer["matchCount"] == len(expected)
    assert answer["cellFilterDropped"] is None


def test_junk_rows_are_dropped(corpus, monkeypatch):
    """Klädsel, bunt och jämförelseannons lämnar jämförelsemängden."""
    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", True)
    answer = _run(corpus, name="Ektorp", brand="IKEA",
                  attribute_text="IKEA Ektorp 3-sits soffa")

    dropped = answer["cellFilterDropped"]
    assert dropped, "inget rensades"
    assert dropped.get("is_accessory_only") == 20
    assert dropped.get("is_bundle") == 15
    assert dropped.get("is_comparison") == 10
    # Klädseln på 300 kr drog medianen ned i den gamla vägen.
    assert answer["default"] > 2000


def test_search_itself_is_untouched(corpus, monkeypatch):
    """Filtret tar bort rader — det lägger aldrig till några.

    Det är skillnaden mot PRICE_CELLS_ENABLED, som bytte ut hela mängden och
    därmed kunde ta IN rader som sökningen aldrig hittat.
    """
    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", True)
    text = pricing.find_listings(corpus, "Ektorp", "IKEA",
                                 condition=None, price_kind=None)
    kept, _, _ = pricing._cell_filter(text, "IKEA Ektorp 3-sits soffa", "IKEA")
    assert set(kept.index) <= set(text.index)


def test_unknown_type_is_not_a_contradiction(monkeypatch):
    """Rader utan utskriven möbeltyp behålls.

    Två tredjedelar av korpusen saknar möbelord i rubriken. Att behandla okänt
    som en motsägelse hade tömt mängden på sitt underlag utan att ta bort ett
    enda fel.
    """
    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", True)
    names = ["IKEA Ektorp 3-sits soffa"] * 30 + ["IKEA Ektorp"] * 30
    corpus = _corpus(names, [3000] * 30 + [2800] * 30)
    kept, soft, dropped = pricing._cell_filter(
        corpus, "IKEA Ektorp 3-sits soffa", "IKEA")
    assert len(kept) == 60
    assert soft is None
    assert "typmotsagelse" not in dropped


def test_contradiction_is_dropped_when_floor_holds(monkeypatch):
    """En fotpall i en soffsökning kastas när mängden tål det."""
    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", True)
    names = ["IKEA Ektorp 3-sits soffa"] * 40 + ["IKEA Ektorp fotpall"] * 12
    corpus = _corpus(names, [3000] * 40 + [400] * 12)
    kept, soft, dropped = pricing._cell_filter(
        corpus, "IKEA Ektorp 3-sits soffa", "IKEA")
    assert dropped.get("typmotsagelse") == 12
    assert soft is None
    assert len(kept) == 40


def test_contradiction_becomes_weight_under_the_floor(monkeypatch):
    """Filtergolvet: under 30 rader viktas motsägelsen ned i stället.

    Golvet är arkitektur, inte en tröskel att trimma — ingen filterkedja får ta
    jämförelsemängden under MIN_COMPARISON_SET. Skräpflaggade rader kastas ändå,
    eftersom de aldrig är rätt jämförelse hur tunn mängden än blir.
    """
    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", True)
    names = ["IKEA Ektorp 3-sits soffa"] * 20 + ["IKEA Ektorp fotpall"] * 20
    corpus = _corpus(names, [3000] * 20 + [400] * 20)
    kept, soft, dropped = pricing._cell_filter(
        corpus, "IKEA Ektorp 3-sits soffa", "IKEA")
    assert dropped.get("typmotsagelse_nedviktad") == 20
    assert soft is not None and len(soft) == 20
    assert len(kept) == 40, "raderna ska ligga kvar, inte kastas"


def test_junk_is_dropped_even_below_the_floor(monkeypatch):
    """Skräpraderna kastas utan golvprövning.

    En klädsel är aldrig rätt jämförelse för en soffa, inte ens när det är det
    enda som finns. Att behålla den för att nå 30 rader hade gett ett svar som
    ser välunderbyggt ut och är fel.
    """
    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", True)
    names = ["IKEA Ektorp 3-sits soffa"] * 5 + ["Klädsel till IKEA Ektorp"] * 40
    corpus = _corpus(names, [3000] * 5 + [300] * 40)
    kept, _, dropped = pricing._cell_filter(
        corpus, "IKEA Ektorp 3-sits soffa", "IKEA")
    assert dropped.get("is_accessory_only") == 40
    assert len(kept) == 5


def test_bundle_query_keeps_bundles(monkeypatch):
    """Söker användaren en matgrupp är buntarna rätt jämförelse.

    Att kasta dem hade lämnat kvar lösa bord och prissatt hela gruppen som ett
    bord — felet går åt fel håll och blir stort.
    """
    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", True)
    names = ["PINNTORP bord och 4 stolar"] * 30 + ["PINNTORP bord"] * 10
    corpus = _corpus(names, [2000] * 30 + [600] * 10)
    kept, _, dropped = pricing._cell_filter(
        corpus, "PINNTORP bord och 4 stolar", "IKEA")
    assert "is_bundle" not in dropped
    assert len(kept) >= 30


def test_downweighting_reaches_the_price(monkeypatch):
    """Nedviktningen ska faktiskt påverka priset, inte bara loggas."""
    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", True)
    monkeypatch.setattr(config, "PRICE_CELLS_ENABLED", False)
    names = ["IKEA Ektorp 3-sits soffa"] * 20 + ["IKEA Ektorp fotpall"] * 20
    corpus = _corpus(names, [3000] * 20 + [400] * 20)

    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", False)
    off = _run(corpus, name="Ektorp", brand="IKEA",
               attribute_text="IKEA Ektorp 3-sits soffa")
    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", True)
    on = _run(corpus, name="Ektorp", brand="IKEA",
              attribute_text="IKEA Ektorp 3-sits soffa")
    assert on["default"] > off["default"]
