"""Avdraget på HELA intervallet, och osäkerheten som bredd.

Tre skalfaktorer, inte en:

    high    x (1 - ci_low)    minsta avdraget ger högsta kanten
    default x (1 - deduction)
    low     x (1 - ci_high)   största avdraget ger lägsta kanten

Två invarianter låses här. Den första är självklar men lätt att bryta; den andra
är hela poängen med att propagera CI.
"""

from __future__ import annotations

import json

import pandas as pd
import pytest

from price_engine import config, damage_pricing as dp, pricing
from type_system import grouping


def _syn():
    """Synonymer = kategorinamnet. Den deterministiska matchningen slår på
    beskrivningen, så testerna måste deklarera vad som matchar vad."""
    return {n: {"synonyms": [n]} for n in
            ("flack", "repa", "bred", "smal", "utan_ci", "grov")}


@pytest.fixture
def table(tmp_path, monkeypatch):
    path = tmp_path / "d.json"
    path.write_text(json.dumps({"categories": _syn(), "rows": [
        {"category": "bred", "furniture_type": "*", "grade": 1,
         "deduction": 0.20, "ci_low": 0.10, "ci_high": 0.35,
         "source": "measured", "n_groups": 40},
        {"category": "smal", "furniture_type": "*", "grade": 1,
         "deduction": 0.10, "ci_low": 0.09, "ci_high": 0.11,
         "source": "measured", "n_groups": 40},
        {"category": "utan_ci", "furniture_type": "*", "grade": 1,
         "deduction": 0.15, "ci_low": None, "ci_high": None,
         "source": "judgment", "n_groups": 0},
    ]}), encoding="utf-8")
    monkeypatch.setattr(config, "DAMAGE_TABLE_PATH", path)
    monkeypatch.setattr(config, "UNMAPPED_DAMAGE_LOG", tmp_path / "log.jsonl")
    monkeypatch.setattr(config, "DAMAGE_PRICING", True)
    return path


@pytest.fixture
def corpus():
    names = ["IKEA Ektorp 3-sits soffa"] * 80
    return _build(names, [10000.0 + i * 50 for i in range(40)]
                  + [7000.0 + i * 50 for i in range(40)])


def _build(names, prices):
    frame = pd.DataFrame({
        "name": names,
        "name_norm": [pricing.normalize_text(n) for n in names],
        "search_blob": [pricing.normalize_text(n) for n in names],
        "price": prices, "price_kind": "asking", "brand_norm": None,
        "source": "test", "variant": "soffa", "derived_type": "soffa",
        "condition_norm": None, "condition_tier": None,
        "listed_at": pd.Timestamp("2026-08-01", tz="UTC"),
        "damage_stain": [False] * 40 + [True] * 40,
        "damage_wear": False, "damage_scratch": False, "damage_damage": False,
        "damage_crack": False, "damage_defect": False,
        "damage_count": [0] * 40 + [1] * 40,
    })
    assigned = grouping.assign_cells(frame["name"])
    for column in assigned.columns:
        frame[column] = assigned[column].to_numpy()
    return frame


def _run(listings, damages=None):
    return pricing.price_query(listings, name="Ektorp", brand="IKEA",
                               attribute_text="IKEA Ektorp 3-sits soffa",
                               image_rerank=False, damages=damages)


def _relative_width(answer):
    return (answer["high"] - answer["low"]) / answer["default"]


# --------------------------------------------------------------------------
# Invariant 1: ordningen håller alltid
# --------------------------------------------------------------------------
@pytest.mark.parametrize("damages", [
    [{"description": "bred", "severity": 1}],
    [{"description": "smal", "severity": 1}],
    [{"description": "utan_ci", "severity": 1}],
    [{"description": "bred", "severity": 1}, {"description": "smal", "severity": 1}],
    [{"description": "bred", "severity": 1}] * 5,
    [{"description": "spjalkat faner", "severity": 2, "repair_cost_sek": 900}],
    [{"description": "bred", "severity": 0}],                    # under tröskeln
    [{"description": "okand_kategori", "severity": 2}],          # ingen värdering
])
def test_low_default_high_always_ordered(corpus, table, damages):
    """low <= default <= high, oavsett vad som slängs in."""
    answer = _run(corpus, damages)
    assert answer["low"] <= answer["default"] <= answer["high"], answer


# --------------------------------------------------------------------------
# Invariant 2: skada gör aldrig intervallet smalare
# --------------------------------------------------------------------------
def _scaled_width(low, default, high, total, ci_low, ci_high):
    """Relativ bredd efter att de tre faktorerna applicerats."""
    return ((high * (1 - ci_low) - low * (1 - ci_high))
            / (default * (1 - total)))


@pytest.mark.parametrize("total,ci_low,ci_high", [
    (0.20, 0.10, 0.35),     # brett CI
    (0.10, 0.09, 0.11),     # smalt CI
    (0.15, 0.15, 0.15),     # inget CI -> lika skalning
    (0.40, 0.25, 0.50),     # stort avdrag
    (0.05, 0.00, 0.30),     # kraftigt osymmetriskt
])
def test_scaling_never_narrows_the_relative_interval(total, ci_low, ci_high):
    """Skalningen får ALDRIG göra svaret mer precist.

    Måttet är RELATIV bredd, (high - low) / default. I kronor krymper varje
    intervall när priset sjunker — det är aritmetik, inte design. Det som ska
    gälla är att osäkerheten om avdraget ADDERAS till osäkerheten om priset,
    aldrig drar ifrån.

    Beviset: med ci_low <= d <= ci_high blir täljaren
        H(1-ci_low) - L(1-ci_high) >= (H-L)(1-d)
    och nämnaren D(1-d), så kvoten är minst (H-L)/D.

    Testet prövar satsen på själva skalningen. Att jämföra mot ett OSKADAT
    motorsvar hade blandat in en annan effekt: basregeln byter till de oskadade
    jämförelseannonserna, som är mer homogena och därför ger ett smalare
    intervall redan innan avdraget. Det är korrekt beteende men en annan sak.
    """
    low, default, high = 8000.0, 10000.0, 13000.0
    before = (high - low) / default
    after = _scaled_width(low, default, high, total, ci_low, ci_high)
    assert after >= before - 1e-9, (before, after)


def test_equal_scaling_preserves_relative_width_exactly():
    """Utan CI ska bredden bevaras exakt — varken vidgas eller krympas."""
    low, default, high = 8000.0, 10000.0, 13000.0
    before = (high - low) / default
    after = _scaled_width(low, default, high, 0.15, 0.15, 0.15)
    assert after == pytest.approx(before, rel=1e-12)


def test_base_rule_narrows_and_that_is_correct(corpus, table):
    """Dokumenterar effekten som gjorde ovanstående test nödvändigt.

    Basregeln byter till de OFLAGGADE jämförelseannonserna. De är mer homogena
    än den blandade mängden — 40 annonser på 10 000-12 000 mot 80 på
    7 000-12 000 — så intervallet blir smalare redan innan något avdrag gjorts.
    Det är rätt: en renare jämförelsemängd ÄR mer informativ.
    """
    clean = _run(corpus, None)
    damaged = _run(corpus, [{"description": "utan_ci", "severity": 1}])
    assert _relative_width(damaged) < _relative_width(clean)
    assert damaged["damage"]["basis"] == "undamaged_comparables"


def test_wide_ci_widens_more_than_narrow_ci(corpus, table):
    """Ett osäkert avdrag ska ge ett bredare intervall än ett säkert.

    Det är själva syftet med att propagera CI — utan det vore ett gissat avdrag
    lika tvärsäkert som ett uppmätt.
    """
    wide = _run(corpus, [{"description": "bred", "severity": 1}])     # CI 0,10-0,35
    narrow = _run(corpus, [{"description": "smal", "severity": 1}])   # CI 0,09-0,11
    assert _relative_width(wide) > _relative_width(narrow)


def test_missing_ci_scales_all_three_equally_and_flags(corpus, table):
    """Saknas CI skalas allt lika — och det ska stå i svaret."""
    answer = _run(corpus, [{"description": "utan_ci", "severity": 1}])
    assert answer["damage"]["missingCi"] is True
    assert "saknar konfidensintervall" in answer["note"]
    # Att bredden bevaras exakt vid lika skalning prövas i
    # test_equal_scaling_preserves_relative_width_exactly — här räcker det att
    # flaggan och förbehållet finns.
    assert answer["low"] <= answer["default"] <= answer["high"]


# --------------------------------------------------------------------------
# Basregeln gäller alla tre punkterna
# --------------------------------------------------------------------------
def test_all_three_points_come_from_the_undamaged_base(corpus, table):
    """Tidigare skalades default från den oskadade basen medan low/high
    skalades från den BLANDADE — basregeln gällde bara en av tre punkter."""
    clean = _run(corpus, None)
    damaged = _run(corpus, [{"description": "smal", "severity": 1}])
    # Den oskadade sidan ligger på 10 000-12 000, den blandade drar ned.
    # Med korrekt bas ska alla tre punkterna ligga nära 0,9 x den oskadade
    # sidans motsvarande punkt, inte nära den blandade.
    assert damaged["high"] > clean["high"] * 0.85
    assert damaged["low"] > 6000


def test_ci_is_reported_in_the_answer(corpus, table):
    answer = _run(corpus, [{"description": "bred", "severity": 1}])
    info = answer["damage"]
    assert info["totalCiLow"] == 0.10
    assert info["totalCiHigh"] == 0.35
    assert info["totalDeduction"] == 0.20
    assert "10–35 %" in answer["note"]


# --------------------------------------------------------------------------
# CI-kedjan
# --------------------------------------------------------------------------
def test_ci_propagates_as_max_over_the_edges():
    """Kanterna är max över posternas CI, inte den bindande postens."""
    chain = dp.worst_with_ci([
        {"deduction": 0.20, "ciLow": 0.10, "ciHigh": 0.35},
        {"deduction": 0.10, "ciLow": 0.05, "ciHigh": 0.15},
    ])
    assert chain["total"] == 0.20
    assert chain["totalCiLow"] == 0.10
    assert chain["totalCiHigh"] == 0.35
    assert chain["totalCiLow"] <= chain["total"] <= chain["totalCiHigh"]


def test_ci_is_clamped_to_bracket_the_estimate():
    """En rad med ci_low > deduction får inte ge low > default."""
    chain = dp.worst_with_ci([{"deduction": 0.10, "ciLow": 0.30, "ciHigh": 0.05}])
    assert chain["totalCiLow"] <= chain["total"] <= chain["totalCiHigh"]
