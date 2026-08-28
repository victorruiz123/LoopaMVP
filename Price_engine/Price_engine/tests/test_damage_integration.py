"""Skadeavdraget i motorn: flaggan, kedjan och tio syntetiska fall.

Det viktigaste testet är det första. `DAMAGE_PRICING` av ska ge EXAKT dagens
svar — allt annat betyder att en avstängd funktion läcker in i produktionen.
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
        {"category": "flack", "furniture_type": "soffa", "grade": 1,
         "deduction": 0.10, "source": "measured", "n_groups": 40},
        {"category": "flack", "furniture_type": "soffa", "grade": 2,
         "deduction": 0.20, "source": "measured", "n_groups": 40},
        {"category": "repa", "furniture_type": "*", "grade": 1,
         "deduction": 0.08, "source": "measured", "n_groups": 31},
    ]}), encoding="utf-8")
    monkeypatch.setattr(config, "DAMAGE_TABLE_PATH", path)
    monkeypatch.setattr(config, "UNMAPPED_DAMAGE_LOG", tmp_path / "log.jsonl")
    return path


@pytest.fixture
def corpus():
    """40 oskadade à 10 000 kr och 40 skadade à 7 000 — så basregeln syns."""
    names = ["IKEA Ektorp 3-sits soffa"] * 80
    frame = pd.DataFrame({
        "name": names,
        "name_norm": [pricing.normalize_text(n) for n in names],
        "search_blob": [pricing.normalize_text(n) for n in names],
        "price": [10000.0 + i for i in range(40)] + [7000.0 + i for i in range(40)],
        "price_kind": "asking", "brand_norm": None, "source": "test",
        "variant": "soffa", "derived_type": "soffa",
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


def _run(listings, damages=None, **kwargs):
    return pricing.price_query(listings, name="Ektorp", brand="IKEA",
                               attribute_text="IKEA Ektorp 3-sits soffa",
                               image_rerank=False, damages=damages, **kwargs)


# --------------------------------------------------------------------------
# Flaggan
# --------------------------------------------------------------------------
def test_flag_off_is_todays_behaviour(corpus, table, monkeypatch):
    monkeypatch.setattr(config, "DAMAGE_PRICING", False)
    with_damage = _run(corpus, [{"description": "flack", "severity": 2}])
    without = _run(corpus, None)
    for field in ("low", "default", "high", "matchCount", "confidence"):
        assert with_damage[field] == without[field], field
    assert with_damage["damage"] is None


def test_flag_on_applies_the_deduction(corpus, table, monkeypatch):
    monkeypatch.setattr(config, "DAMAGE_PRICING", True)
    out = _run(corpus, [{"description": "flack", "severity": 2, "location": "sittyta"}])
    assert out["damage"]["totalDeduction"] == 0.20
    assert out["damage"]["items"][0]["source"] == "table"
    assert out["damage"]["basis"] == "undamaged_comparables"


# --------------------------------------------------------------------------
# Basregeln i motorn
# --------------------------------------------------------------------------
def test_base_is_the_undamaged_median(corpus, table, monkeypatch):
    """Kärnan mot dubbelräkning: basen ska vara ~10 000, inte den blandade ~8 500."""
    monkeypatch.setattr(config, "DAMAGE_PRICING", True)
    out = _run(corpus, [{"description": "flack", "severity": 2}])
    # 20 % av den oskadade basen (~10 000) ger ~8 000, klart över den blandade
    # medianens 20 %-avdrag (~6 800).
    assert out["default"] > 7300
    assert out["damage"]["basisN"] == 40


def test_thin_clean_side_halves_the_deduction(corpus, table, monkeypatch):
    monkeypatch.setattr(config, "DAMAGE_PRICING", True)
    thin = corpus.iloc[35:]          # 5 oskadade, 40 skadade
    out = _run(thin, [{"description": "flack", "severity": 2}])
    assert out["damage"]["basis"] == "mixed_halved"
    assert out["damage"]["halved"] is True
    assert out["damage"]["totalDeductionApplied"] == 0.10
    assert out["confidence"] == "low"


# --------------------------------------------------------------------------
# Kedjan: table -> estimated_repair -> inget
# --------------------------------------------------------------------------
def test_dead_model_never_fells_a_price(corpus, table, monkeypatch):
    """Ett dött API får aldrig fälla ett prissvar."""
    monkeypatch.setattr(config, "DAMAGE_PRICING", True)
    for payload in (None, [], "trasigt", 42, {"x": 1}):
        # Modellen svarar skräp i steg 2 -> posten blir ovärderad, inte ett
        # kraschat prissvar.
        mapping = dp.parse_mapping(payload)
        item = dp.normalise([{"description": "spjalkat faner",
                              "severity": 2}])[0]
        out = _run(corpus, [dp.apply_mapping(item, mapping)])
        assert out["default"] is not None and out["default"] > 0


def test_pricing_survives_a_broken_table(corpus, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DAMAGE_PRICING", True)
    bad = tmp_path / "bad.json"
    bad.write_text("{ trasig json")
    monkeypatch.setattr(config, "DAMAGE_TABLE_PATH", bad)
    out = _run(corpus, [{"description": "flack", "severity": 2}])
    assert out["default"] is not None


def test_estimated_repair_lowers_confidence(corpus, table, monkeypatch):
    monkeypatch.setattr(config, "DAMAGE_PRICING", True)
    item = dp.normalise([{"description": "spjälkat fanér", "severity": 2}])[0]
    merged = dp.apply_mapping(item, {"category": "unmapped",
                                     "repair_action": "fanerlagning",
                                     "repair_cost_sek": 900})
    out = _run(corpus, [merged])
    assert out["damage"]["items"][0]["source"] == "estimated_repair"
    assert out["damage"]["items"][0]["deduction"] == pytest.approx(0.18, abs=1e-3)
    assert out["confidence"] == "low"


def test_unmapped_is_logged(corpus, table, monkeypatch):
    """Loggen är prioriteringsordningen för tabellen."""
    monkeypatch.setattr(config, "DAMAGE_PRICING", True)
    item = dp.normalise([{"description": "spjälkat fanér", "severity": 2}])[0]
    _run(corpus, [dp.apply_mapping(item, {"category": "unmapped",
                                          "repair_cost_sek": 900})])
    rows = config.UNMAPPED_DAMAGE_LOG.read_text(encoding="utf-8").strip().splitlines()
    assert len(rows) == 1
    assert json.loads(rows[0])["description"] == "spjälkat fanér"


# --------------------------------------------------------------------------
# Tio syntetiska fall: känd skada + känd bas -> känt avdrag
# --------------------------------------------------------------------------
SYNTHETIC = [
    # (skador, baspris, förväntat totalavdrag, kommentar)
    ([{"description": "flack", "severity": 1}], 10000, 0.10, "tabell, typspecifik"),
    ([{"description": "flack", "severity": 2}], 10000, 0.20, "tabell, högre grad"),
    ([{"description": "repa", "severity": 1}], 10000, 0.08, "tabell, generisk *"),
    ([{"description": "flack", "severity": 0}], 10000, 0.00, "under väsentlighet"),
    ([{"description": "mogel", "severity": 2}], 10000, 0.00, "okänd, ingen kostnad"),
    ("_cost1000", 10000, 0.20, "1000 x 2,0 / 10000"),
    ("_cost100000", 10000, 0.25, "kapat till MAX_UNMAPPED"),
    ([{"description": "flack", "severity": 2}, {"description": "repa", "severity": 1}],
     10000, 0.20, "max(): största vinner"),
    ([{"description": "repa", "severity": 1}, {"description": "flack", "severity": 2}],
     10000, 0.20, "samma, ordningen spelar ingen roll"),
    ([{"description": "flack", "severity": 2}, {"description": "flack", "severity": 0}],
     10000, 0.20, "grad 0 bidrar inte"),
]


@pytest.mark.parametrize("items,base,expected,why", SYNTHETIC)
def test_synthetic_cases(table, items, base, expected, why):
    if isinstance(items, str) and items.startswith("_cost"):
        # Kostnadsfallen kommer ur steg 2, inte ur API:t — kontraktet har
        # inget kostnadsfält.
        cost = int(items[len("_cost"):])
        item = dp.normalise([{"description": "spjalkat faner", "severity": 2}])[0]
        prepared = [dp.apply_mapping(item, {"category": "unmapped",
                                            "repair_cost_sek": cost})]
    else:
        # Samma väg som motorn: API-format -> normalise -> resolve.
        prepared = dp.normalise(items)
    out = dp.resolve(prepared, "soffa", base)
    assert out["totalDeduction"] == pytest.approx(expected, abs=0.002), why
