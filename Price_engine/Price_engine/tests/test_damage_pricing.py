"""Skadeavdraget: mekaniken som omvandlar en sedd skada till ett pris.

    LLM:en SER och KLASSIFICERAR.  Tabellen VÄRDERAR.
    Uppskattad lagningskostnad täcker gapet däremellan.

Testerna vaktar den arbetsdelningen och de fyra reglerna som gör avdraget
försvarbart: basen mot dubbelräkning, staplingens mättnad, taken, och att ett
dött API aldrig fäller ett prissvar.
"""

from __future__ import annotations

import json
import pathlib

import pandas as pd
import pytest

from price_engine import config, damage_pricing as dp, pricing
from type_system import grouping


@pytest.fixture
def table(tmp_path, monkeypatch):
    """En liten tabell med kända värden, så avdragen går att räkna för hand."""
    path = tmp_path / "damage.json"
    path.write_text(json.dumps({"rows": [
        {"category": "flack", "furniture_type": "soffa", "grade": 1,
         "deduction": 0.10, "source": "measured", "n_groups": 40},
        {"category": "flack", "furniture_type": "soffa", "grade": 2,
         "deduction": 0.20, "source": "measured", "n_groups": 35},
        {"category": "flack", "furniture_type": "*", "grade": 1,
         "deduction": 0.05, "source": "repair_anchor", "n_groups": 0},
        {"category": "repa", "furniture_type": "*", "grade": 1,
         "deduction": 0.08, "source": "measured", "n_groups": 31},
        {"category": "spricka", "furniture_type": "matbord", "grade": 2,
         "deduction": None, "source": "insufficient_data", "n_groups": 6},
    ]}), encoding="utf-8")
    monkeypatch.setattr(config, "DAMAGE_TABLE_PATH", path)
    return path


# --------------------------------------------------------------------------
# Tabellen
# --------------------------------------------------------------------------
def test_specific_type_beats_generic(table):
    assert dp.lookup("flack", "soffa", 1)["deduction"] == 0.10
    assert dp.lookup("flack", "matbord", 1)["deduction"] == 0.05   # faller till *


def test_insufficient_data_never_gives_a_deduction(table):
    """En omätt rad dokumenterar att kategorin är känd — den prissätter inte."""
    assert dp.lookup("spricka", "matbord", 2) is None


def test_unknown_category_is_none(table):
    assert dp.lookup("mogel", "soffa", 1) is None


# --------------------------------------------------------------------------
# max(): totalen är den värsta enskilda skadan
# --------------------------------------------------------------------------
def test_total_is_the_largest_single_deduction():
    """En köpare prissätter möbelns värsta problem."""
    out = dp.worst_with_ci([{"deduction": 0.20}, {"deduction": 0.38},
                            {"deduction": 0.06}])
    assert out["total"] == 0.38


def test_more_damages_never_raise_the_total():
    """Ytterligare skador bekräftar intrycket utan att flytta priset."""
    one = dp.worst_with_ci([{"deduction": 0.38}])["total"]
    many = dp.worst_with_ci([{"deduction": 0.38}] + [{"deduction": 0.20}] * 20)
    assert many["total"] == one


def test_order_does_not_matter():
    assert (dp.worst_with_ci([{"deduction": 0.1}, {"deduction": 0.3}])["total"]
            == dp.worst_with_ci([{"deduction": 0.3}, {"deduction": 0.1}])["total"])


def test_no_damages_gives_zero():
    for items in (None, [], [{"deduction": 0.0}], [{}]):
        assert dp.worst_with_ci(items)["total"] == 0.0


def test_ci_edges_are_max_not_the_binding_items_ci():
    """I det optimistiska scenariot kan en ANNAN skada bli den värsta.

    Med A(0,38, CI 0,25-0,50) och B(0,35, CI 0,30-0,45) är den lägsta rimliga
    totalen 0,30 — B:s undre kant — inte A:s 0,25, för B finns kvar även när A
    visar sig mild.
    """
    out = dp.worst_with_ci([{"deduction": 0.38, "ciLow": 0.25, "ciHigh": 0.50},
                            {"deduction": 0.35, "ciLow": 0.30, "ciHigh": 0.45}])
    assert out["total"] == 0.38
    assert out["totalCiLow"] == 0.30
    assert out["totalCiHigh"] == 0.50


def test_ci_always_brackets_the_total():
    out = dp.worst_with_ci([{"deduction": 0.10, "ciLow": 0.30, "ciHigh": 0.05}])
    assert out["totalCiLow"] <= out["total"] <= out["totalCiHigh"]


# --------------------------------------------------------------------------
# Basregeln
# --------------------------------------------------------------------------
def _frame(n_clean, n_flagged):
    rows = []
    for i in range(n_clean):
        rows.append({"price": 10000.0 + i, "damage_stain": False,
                     "damage_wear": False})
    for i in range(n_flagged):
        rows.append({"price": 7000.0 + i, "damage_stain": True,
                     "damage_wear": False})
    return pd.DataFrame(rows)


def test_base_uses_undamaged_comparables():
    """Basen räknas på de OFLAGGADE — annars straffas skadan två gånger."""
    frame, label, halve = dp.select_base(_frame(40, 40))
    assert label == "undamaged_comparables"
    assert halve is False
    assert len(frame) == 40
    assert frame["price"].min() >= 10000


def test_thin_clean_side_falls_back_and_halves():
    """Under filtergolvet: blandad bas, men avdraget halveras."""
    frame, label, halve = dp.select_base(_frame(5, 40))
    assert label == "mixed_halved"
    assert halve is True
    assert len(frame) == 45


def test_missing_flag_columns_is_safe():
    frame, label, halve = dp.select_base(pd.DataFrame({"price": [1.0, 2.0]}))
    assert label == "mixed_no_flags" and halve is True


# --------------------------------------------------------------------------
# Lagningskostnad
# --------------------------------------------------------------------------
def test_repair_cost_uses_hassle_factor():
    """800 kr * 2,0 / 10 000 kr = 16 %."""
    assert dp.from_repair_cost(800, 10000) == pytest.approx(0.16)


def test_repair_cost_is_capped():
    """En felgissad kostnad får inte halvera priset."""
    assert dp.from_repair_cost(50000, 10000) == config.MAX_UNMAPPED_DEDUCTION


def test_repair_cost_without_base_is_none():
    assert dp.from_repair_cost(800, 0) is None
    assert dp.from_repair_cost(None, 10000) is None


# --------------------------------------------------------------------------
# Väsentlighetströskeln och taken
# --------------------------------------------------------------------------
def test_grade_zero_is_listed_but_free(table):
    """AI:n ser mer än köparen bryr sig om."""
    out = dp.resolve([{"category": "flack", "grade": 0}], "soffa", 10000)
    assert out["items"][0]["source"] == "below_materiality"
    assert out["items"][0]["deduction"] == 0.0
    assert out["totalDeduction"] == 0.0


def test_total_is_capped_and_flagged(table):
    """Taket ska lösa ut och flaggas — men det krävs stora avdrag."""
    # Med max() krävs en ENSKILD rad över taket. Det finns ingen sådan i den
    # riktiga tabellen — se testet nedan.
    out = dp.resolve([{"category": "grov", "grade": 2}], "soffa", 10000,
                     table_path=_big_table())
    assert out["capped"] is True
    assert out["totalDeduction"] == config.MAX_TOTAL_DEDUCTION


def _big_table():
    """Tabell med ett stort avdrag, bara för att prova att taket biter."""
    import tempfile
    path = pathlib.Path(tempfile.mkdtemp()) / "big.json"
    path.write_text(json.dumps({"rows": [
        {"category": "grov", "furniture_type": "*", "grade": 2,
         "deduction": 0.60, "source": "measured", "n_groups": 40}]}))
    return path


def test_caps_can_only_bind_on_a_single_row():
    """Med max() är taken skyddsnät mot ENSKILDA rader, inte mot långa listor.

    Ingen rad i den riktiga tabellen överstiger MAX_TOTAL_DEDUCTION, så taket
    kan inte lösa ut i dag. Det skyddar mot framtida rader och mot
    kostnadsuppskattningar som spårar ur — inte mot en möbel med många fel.
    """
    many = dp.worst_with_ci([{"deduction": 0.20}] * 500)
    assert many["total"] == 0.20


def test_estimated_repair_alone_can_never_reach_the_cap():
    """Strukturell egenskap som är värd att känna till.

    Med max() är taket för en omappad skada helt enkelt MAX_UNMAPPED_DEDUCTION
    (25 %), oavsett hur många omappade skador som hittas. Under den dämpade
    staplingen låg gränsen på 49,4 % (decay 0,6) respektive 36,9 % (0,4).
    MAX_TOTAL_DEDUCTION (50 %) kan därför ALDRIG lösa ut på enbart uppskattade
    lagningskostnader.

    Det är ett skydd, inte ett fel: en kedja av modellgissningar kan inte
    ensam halvera priset. Men det betyder att totaltaket bara biter när
    tabellen innehåller stora uppmätta avdrag.
    """
    theoretical_max = dp.worst_with_ci(
        [{"deduction": config.MAX_UNMAPPED_DEDUCTION}] * 500)["total"]
    assert theoretical_max < config.MAX_TOTAL_DEDUCTION
    assert theoretical_max == config.MAX_UNMAPPED_DEDUCTION


def test_unmapped_falls_back_to_repair_cost(table):
    out = dp.resolve([{"category": "unmapped", "grade": 2,
                       "description": "spjälkat fanér",
                       "repair_action": "fanerlagning",
                       "repair_cost_sek": 900}], "byra", 10000)
    item = out["items"][0]
    assert item["source"] == "estimated_repair"
    assert item["deduction"] == pytest.approx(0.18, abs=1e-3)
    assert item["repairAction"] == "fanerlagning"
    assert out["estimatedCount"] == 1


def test_unmapped_without_cost_gets_no_valuation(table):
    out = dp.resolve([{"category": "unmapped", "grade": 2,
                       "description": "något konstigt"}], "soffa", 10000)
    assert out["items"][0]["source"] == "no_valuation"
    assert out["totalDeduction"] == 0.0


# --------------------------------------------------------------------------
# Robusthet: ett dött API får aldrig fälla ett prissvar
# --------------------------------------------------------------------------

def test_resolve_handles_garbage_items(table):
    out = dp.resolve([{}, {"category": None, "grade": None}], "soffa", 10000)
    assert out["totalDeduction"] == 0.0



def test_table_repair_cost_never_enters_valuation(tmp_path, monkeypatch):
    """`repair_cost_sek` i TABELLEN är dokumentation, aldrig indata.

    Två rader med identisk `deduction` men helt olika `repair_cost_sek` måste ge
    samma avdrag. Skulle någon återinföra kostnaden i värderingen — som en
    min()-regel, ett tak eller en omräkning — går det här testet sönder.

    Skälet står i schemat: kostnadsbaserade avdrag underskattar marknadens
    straff systematiskt, eftersom köparen prisar in osäkerhet och stigma utöver
    lagningen. Tabellen är därför andelsbaserad, och kostnaden finns bara för
    att en människa ska kunna se om en uppmätt andel är rimlig.
    """
    path = tmp_path / "t.json"
    path.write_text(json.dumps({"rows": [
        {"category": "billig", "furniture_type": "*", "grade": 1,
         "deduction": 0.15, "source": "measured", "n_groups": 40,
         "repair_cost_sek": 50},
        {"category": "dyr", "furniture_type": "*", "grade": 1,
         "deduction": 0.15, "source": "measured", "n_groups": 40,
         "repair_cost_sek": 40000},
    ]}))
    monkeypatch.setattr(config, "DAMAGE_TABLE_PATH", path)

    billig = dp.resolve([{"category": "billig", "grade": 1}], "soffa", 10000)
    dyr = dp.resolve([{"category": "dyr", "grade": 1}], "soffa", 10000)
    assert billig["totalDeduction"] == dyr["totalDeduction"] == 0.15
    assert billig["items"][0]["source"] == "table"


def test_share_is_independent_of_base_price(table):
    """Andelen gäller alltid — samma kategori, olika basbelopp, samma andel."""
    for base in (800, 10000, 90000):
        out = dp.resolve([{"category": "flack", "grade": 2}], "soffa", base)
        assert out["totalDeduction"] == 0.20


def test_repair_hassle_factor_is_two():
    """Höjt från 1,3. Riktningen är känd även om storleken inte är mätt."""
    assert config.REPAIR_HASSLE_FACTOR == 2.0
    assert dp.from_repair_cost(1000, 10000) == pytest.approx(0.20)
