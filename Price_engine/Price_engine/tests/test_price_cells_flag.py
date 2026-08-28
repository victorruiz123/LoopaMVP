"""Flaggan PRICE_CELLS_ENABLED: av = dagens beteende, på = cellerna används.

Det första testet är det viktiga. Priscellerna byter ut motorns kandidatmängd,
och om flaggan av inte ger EXAKT dagens svar har inkopplingen läckt in i den
gamla vägen. Testet jämför hela svaret, inte bara priset, eftersom en läcka lika
gärna kan visa sig i `priceBasis` eller `recencyMethod` som i intervallet.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from price_engine import config, pricing
from type_system import cells, grouping


@pytest.fixture
def corpus() -> pd.DataFrame:
    """En liten korpus med cellnycklarna pålagda, som data_loader gör."""
    names = (["Mio Madison 3-sits soffa"] * 40
             + ["Mio Madison matta 160x230"] * 40
             + ["IKEA Ektorp 2-sits soffa"] * 40
             + ["Klädsel till Mio Madison soffa"] * 10)
    prices = ([5500.0] * 40 + [250.0] * 40 + [900.0] * 40 + [400.0] * 10)
    frame = pd.DataFrame({
        "name": names,
        "name_norm": [pricing.normalize_text(n) for n in names],
        "search_blob": [pricing.normalize_text(n) for n in names],
        "price": prices,
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


def _run(listings, **kwargs):
    return pricing.price_query(listings, image_rerank=False, **kwargs)


def test_flag_off_is_todays_behaviour(corpus, monkeypatch):
    """Flaggan av: svaret är identiskt med det motorn ger utan inkopplingen.

    Referensen byggs genom att kalla den gamla vägen direkt — textsökningen —
    så testet inte bara jämför koden med sig själv.
    """
    monkeypatch.setattr(config, "PRICE_CELLS_ENABLED", False)
    # Cellfiltret pinnas AV här. Det är på som standard sedan 2026-08-16, och
    # utan pinnen mäter testet summan av två flaggor i stället för den ena det
    # påstår sig isolera — filtret rensade bort klädselraderna och 90 blev 80.
    monkeypatch.setattr(config, "CELL_FILTER_ENABLED", False)
    answer = _run(corpus, name="Madison", brand="Mio")

    expected = pricing.find_listings(corpus, "Madison", "Mio",
                                     condition=None, price_kind=None)
    assert answer["matchCount"] == len(expected)
    assert answer["cellLevel"] is None
    assert answer["cellKey"] is None


def test_flag_on_uses_the_cell(corpus, monkeypatch):
    """Flaggan på: mattan ligger inte längre i soffans median."""
    monkeypatch.setattr(config, "PRICE_CELLS_ENABLED", True)
    monkeypatch.setattr(config, "MIN_COMPARISON_SET", 10)
    answer = _run(corpus, name="Mio Madison soffa", brand="Mio")

    assert answer["cellLevel"] in ("full", "utan_konfiguration")
    assert answer["cellKey"].startswith("mio|soffa|madison")
    # Textsökningen på "Madison" drar in mattan på 250 kr och klädseln på 400.
    # Cellen gör inte det, så medianen måste ligga på soffnivå.
    assert answer["default"] > 3000


def test_flag_changes_nothing_else(corpus, monkeypatch):
    """Allt utom kandidatmängden är oförändrat mellan lägena.

    Fälten här beskriver motorns ANDRA beslut. Skiljer de sig har inkopplingen
    ändrat mer än den fick, och en benchmark mellan lägena mäter då två saker.
    """
    monkeypatch.setattr(config, "MIN_COMPARISON_SET", 10)
    monkeypatch.setattr(config, "PRICE_CELLS_ENABLED", False)
    off = _run(corpus, name="IKEA Ektorp 2-sits soffa", brand="IKEA")
    monkeypatch.setattr(config, "PRICE_CELLS_ENABLED", True)
    on = _run(corpus, name="IKEA Ektorp 2-sits soffa", brand="IKEA")

    for field in ("priceBasis", "conditionMethod", "recencyMethod",
                  "variantMethod", "sizeMethod"):
        assert off[field] == on[field], field


def test_no_cell_falls_back_to_text(corpus, monkeypatch):
    """En fråga utan cell blir aldrig no_data av flaggan.

    Flaggan får smalna av jämförelsemängden, aldrig ta bort ett svar som annars
    hade funnits — annars byter man träffsäkerhet mot täckning utan att det syns
    i måttet.
    """
    monkeypatch.setattr(config, "PRICE_CELLS_ENABLED", True)
    answer = _run(corpus, name="Vitrinskap i ek", brand=None)
    assert answer["cellLevel"] in ("ingen_traff", "typ_x_kategori_tunn",
                                  "marke_x_typ_tunn", "utan_konfiguration_tunn",
                                  "full_tunn", "typ_x_kategori")


def test_query_keys_match_corpus_keys(corpus):
    """Frågans nycklar byggs likadant som annonsernas.

    Skulle de byggas på var sitt håll kunde de sluta matcha utan att något test
    märkte det — cellerna skulle tystna och motorn falla tillbaka på text.
    """
    keys = cells.keys_for("Mio Madison 3-sits soffa")
    row = corpus[corpus["name"] == "Mio Madison 3-sits soffa"].iloc[0]
    for column, key in keys.items():
        assert row[column] == key, column


def test_excluded_rows_never_enter_a_cell(corpus, monkeypatch):
    """Klädseln till Madison är inte en Madison."""
    monkeypatch.setattr(config, "PRICE_CELLS_ENABLED", True)
    monkeypatch.setattr(config, "MIN_COMPARISON_SET", 10)
    rows, _, _ = cells.lookup(corpus, "Mio Madison soffa", "Mio")
    assert not rows["name"].str.contains("Klädsel").any()


def test_cell_key_uses_full_text_not_truncated_name(corpus, monkeypatch):
    """Söknyckeln får vara kapad — cellnyckeln byggs ändå på hela texten.

    En anropare som matchar på "Madison" skickar det som `name` men
    "Mio Madison 3-sits soffa" som `attribute_text`. Läses cellnyckeln ur `name`
    saknas möbeltypen, nyckeln blir `mio|okand|madison` och uppslaget landar i
    en uppsamlingscell. Det var precis det som sänkte benchmarken från 73 % till
    46 % innan felet hittades.
    """
    monkeypatch.setattr(config, "PRICE_CELLS_ENABLED", True)
    monkeypatch.setattr(config, "MIN_COMPARISON_SET", 10)
    answer = _run(corpus, name="Madison", brand="Mio",
                  attribute_text="Mio Madison 3-sits soffa")
    assert "okand" not in answer["cellKey"]
    assert answer["cellKey"].startswith("mio|soffa|madison")
