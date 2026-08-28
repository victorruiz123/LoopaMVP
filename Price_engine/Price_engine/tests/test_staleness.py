"""Degraderingsskyddet: motorn får inte framställa gammal data som färsk.

Bakgrunden är ett tyst fel. Färskhetsfönstret rör sig med kalendern medan
korpusen står still, så när den dominerande källan passerar bakom gränsen faller
varje sökning till `extended` — och svaret ser precis likadant ut som förut, fast
byggt på en marknad som inte finns längre. Marknaden har fallit mätbart under
perioden, så felet är systematisk ÖVERprisning.

Testerna kräver att skyddet löser ut på ÅLDER och inte på metod ensam: en
`extended`-mängd som ändå råkar innehålla färska annonser är inte gammal.
"""

from __future__ import annotations

import pandas as pd
import pytest

from price_engine import config, pricing


def _corpus(ages_days, n_each=20) -> pd.DataFrame:
    """En korpus där varje angiven ålder får `n_each` annonser."""
    now = pd.Timestamp.now(tz="UTC")
    names, prices, dates = [], [], []
    for age in ages_days:
        for i in range(n_each):
            names.append("IKEA Ektorp 3-sits soffa")
            prices.append(1000.0 + i)
            dates.append(now - pd.Timedelta(days=age))
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
        "listed_at": dates,
    })
    from type_system import grouping

    assigned = grouping.assign_cells(frame["name"])
    for column in assigned.columns:
        frame[column] = assigned[column].to_numpy()
    return frame


def _run(listings, **kwargs):
    return pricing.price_query(listings, name="Ektorp", brand="IKEA",
                               attribute_text="IKEA Ektorp 3-sits soffa",
                               image_rerank=False, **kwargs)


def test_fresh_data_is_not_flagged():
    """Färsk mängd inom fönstret: ingen degradering, `window` används."""
    corpus = _corpus([10, 30, 60])
    answer = _run(corpus)
    assert answer["recencyMethod"] == "window"
    assert answer["dataStaleness"]["stale"] is False
    assert answer["confidence"] == "high"


def test_old_data_under_extended_is_flagged():
    """Allt äldre än fönstret OCH äldre än STALE_AFTER_MONTHS -> låg konfidens."""
    corpus = _corpus([500, 600, 700])          # ~16-23 månader
    answer = _run(corpus)
    assert answer["recencyMethod"] == "extended"
    assert answer["dataStaleness"]["stale"] is True
    assert answer["confidence"] == "low"
    assert "Prisläget kan ha ändrats" in answer["note"]
    assert "marknaden har fallit" in answer["note"].lower()


def test_extended_with_recent_rows_is_not_flagged():
    """Metoden ensam räcker inte — ÅLDERN avgör.

    En mängd som föll till `extended` för att den var för liten, men vars
    färskaste annons är från förra månaden, är inte gammal. Att flagga den vore
    att sänka konfidensen på ett svar som förtjänar den.
    """
    # Sex färska rader: under RECENCY_MIN_LISTINGS (15), så `extended` väljs,
    # men den färskaste raden är bara 20 dagar gammal.
    corpus = _corpus([20], n_each=6)
    answer = _run(corpus)
    assert answer["recencyMethod"] == "extended"
    assert answer["dataStaleness"]["stale"] is False
    assert "Prisläget kan ha ändrats" not in answer["note"]


def test_threshold_is_configurable(monkeypatch):
    """Gränsen är ett valt tal och ska gå att flytta utan kodändring."""
    corpus = _corpus([400])                    # ~13 månader
    monkeypatch.setattr(config, "STALE_AFTER_MONTHS", 24)
    assert _run(corpus)["dataStaleness"]["stale"] is False
    monkeypatch.setattr(config, "STALE_AFTER_MONTHS", 6)
    assert _run(corpus)["dataStaleness"]["stale"] is True


def test_staleness_reports_the_age_it_measured():
    """Åldern redovisas, inte bara flaggan.

    En granskare ska kunna se VARFÖR konfidensen sänktes utan att köra om.
    """
    corpus = _corpus([600])
    staleness = _run(corpus)["dataStaleness"]
    assert staleness["newest"]
    assert 18 < staleness["ageMonths"] < 22


def test_price_is_unchanged_by_the_flag():
    """Skyddet sänker konfidensen — det får inte röra priset.

    Att tysta ett osäkert svar genom att flytta priset vore att blanda två
    beslut. Intervallet ska vara detsamma; bara förbehållet ändras.
    """
    corpus = _corpus([600])
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(config, "STALE_AFTER_MONTHS", 240)
        without = _run(corpus)
    with_flag = _run(corpus)
    assert with_flag["dataStaleness"]["stale"] is True
    assert without["dataStaleness"]["stale"] is False
    for field in ("low", "default", "high", "matchCount"):
        assert with_flag[field] == without[field], field
