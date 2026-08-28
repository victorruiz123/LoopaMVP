"""Deduplicering: skadesystemet rapporterar allt, motorn värderar en gång per typ.

Utan det här steget ger en normalsliten möbel 8-12 poster som staplas till
50-procentstaket. Då blir taket normalfallet i stället för ett skyddsnät, och
alla slitna möbler hamnar på samma pris oavsett hur slitna de är.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from price_engine import config, damage_pricing as dp


@pytest.fixture(autouse=True)
def logs(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "UNMAPPED_DAMAGE_LOG", tmp_path / "u.jsonl")
    monkeypatch.setattr(config, "DAMAGE_SHADOW_LOG", tmp_path / "s.jsonl")


def _items(description, severity, n):
    return dp.normalise([{"description": description, "severity": severity}] * n)


# --------------------------------------------------------------------------
# Kärnkravet
# --------------------------------------------------------------------------
def test_ten_small_never_beat_one_large():
    """Tio småskador i samma kategori får inte kosta mer än en stor.

    Det är hela skälet till dedupliceringen. Utan den staplas de tio till
    taket, och en möbel med tio ytliga repor blir lika illa som en med en
    genomgående spricka.
    """
    many, _ = dp.deduplicate(_items("repa i lacken", 0, 10))
    one, _ = dp.deduplicate(_items("repa i lacken", 2, 1))
    small = dp.resolve(many, "soffa", 10000)["totalDeduction"]
    large = dp.resolve(one, "soffa", 10000)["totalDeduction"]
    assert small <= large, (small, large)


@pytest.mark.parametrize("n", [3, 5, 10, 25, 100])
def test_more_of_the_same_never_costs_more_than_the_worst(n):
    """Antalet får aldrig driva avdraget förbi den grövsta enskilda skadan."""
    many, _ = dp.deduplicate(_items("flack", 1, n))
    worst, _ = dp.deduplicate(_items("flack", 2, 1))
    assert (dp.resolve(many, "soffa", 10000)["totalDeduction"]
            <= dp.resolve(worst, "soffa", 10000)["totalDeduction"])


def test_normal_wear_does_not_hit_the_cap():
    """Scenariot som motiverade hela ändringen.

    En normalsliten möbel: repor, fläckar, missfärgning och nedsutten dyna,
    flera av varje. Före dedupliceringen blev det tolv poster och taket.
    """
    raw = ([{"description": "repa i lacken", "severity": 0}] * 4
           + [{"description": "fläck", "severity": 1}] * 3
           + [{"description": "solblekt", "severity": 1}] * 3
           + [{"description": "nedsutten dyna", "severity": 1}] * 2)
    items, stats = dp.deduplicate(dp.normalise(raw))
    out = dp.resolve(items, "soffa", 10000)
    assert stats["before"] == 12 and stats["after"] == 4
    assert out["capped"] is False
    assert out["totalDeduction"] < config.MAX_TOTAL_DEDUCTION


# --------------------------------------------------------------------------
# Gruppering
# --------------------------------------------------------------------------
def test_highest_grade_in_the_group_wins():
    items = dp.normalise([{"description": "flack", "severity": 0},
                          {"description": "flack", "severity": 2},
                          {"description": "flack", "severity": 1}])
    out, _ = dp.deduplicate(items)
    assert len(out) == 1
    assert out[0]["grade"] == 2


def test_different_categories_are_kept_apart():
    items = dp.normalise([{"description": "flack", "severity": 1},
                          {"description": "reva i tyget", "severity": 1},
                          {"description": "luktar rök", "severity": 1}])
    out, stats = dp.deduplicate(items)
    assert len(out) == 3
    assert stats["collapsed"] == 0


def test_unmapped_group_on_description():
    """Tio identiska omappade skador är en skada, inte tio.

    De saknar kategori, så grupperingen sker på beskrivningen i stället.
    """
    items = dp.normalise([{"description": "spjälkat fanér", "severity": 1}] * 10)
    out, stats = dp.deduplicate(items)
    assert len(out) == 1
    assert out[0]["count"] == 10


def test_different_unmapped_stay_separate():
    items = dp.normalise([{"description": "spjälkat fanér", "severity": 1},
                          {"description": "böjd metallfot", "severity": 1}])
    out, _ = dp.deduplicate(items)
    assert len(out) == 2


def test_count_is_reported_but_does_not_add():
    """Antalet syns i svaret men höjer inte avdraget — bortsett från
    gradhöjningen, som är en egen och explicit regel."""
    one = dp.resolve(dp.deduplicate(_items("flack", 2, 1))[0], "soffa", 10000)
    ten = dp.resolve(dp.deduplicate(_items("flack", 2, 10))[0], "soffa", 10000)
    assert one["totalDeduction"] == ten["totalDeduction"]
    assert ten["items"][0]["count"] == 10
    assert "count" not in one["items"][0]


# --------------------------------------------------------------------------
# Gradhöjningen
# --------------------------------------------------------------------------
def test_three_of_a_kind_escalates_one_step():
    below, _ = dp.deduplicate(_items("flack", 0, 2))
    at, _ = dp.deduplicate(_items("flack", 0, 3))
    assert below[0]["grade"] == 0 and not below[0].get("gradeEscalated")
    assert at[0]["grade"] == 1 and at[0]["gradeEscalated"] is True


def test_escalation_stops_at_two():
    out, _ = dp.deduplicate(_items("flack", 2, 20))
    assert out[0]["grade"] == 2
    assert not out[0].get("gradeEscalated")


def test_escalation_can_be_switched_off(monkeypatch):
    monkeypatch.setattr(config, "COUNT_ESCALATION_AT", 0)
    out, stats = dp.deduplicate(_items("flack", 0, 10))
    assert out[0]["grade"] == 0
    assert stats["escalated"] == []


def test_escalation_is_reported():
    _, stats = dp.deduplicate(_items("flack", 1, 5))
    assert stats["escalated"] == ["flack"]
    assert stats["counts"] == {"flack": 5}


# --------------------------------------------------------------------------
# Skuggloggen
# --------------------------------------------------------------------------
def test_shadow_log_records_cap_and_dedup():
    items, stats = dp.deduplicate(_items("flack", 2, 6))
    info = dp.resolve(items, "soffa", 10000)
    info["needsModel"] = 0
    dp.log_shadow(info, stats, "soffa")
    row = json.loads(config.DAMAGE_SHADOW_LOG.read_text().strip())
    assert row["items_in"] == 6 and row["items_after_dedup"] == 1
    assert row["collapsed"] == 5
    assert row["capped"] is False
    assert row["counts"] == {"flack": 6}


def test_shadow_log_never_fells_a_price(monkeypatch, tmp_path):
    """Loggningen får aldrig kasta."""
    monkeypatch.setattr(config, "DAMAGE_SHADOW_LOG",
                        tmp_path / "finns-inte" / "x" / "s.jsonl")
    bad = object()
    dp.log_shadow({"items": [bad]}, {"before": 1}, "soffa")   # inte JSON-bart


# --------------------------------------------------------------------------
# Staplingen är borttagen — inte avstängd
# --------------------------------------------------------------------------
def test_stack_decay_stays_removed():
    """`STACK_DECAY` ska inte finnas kvar någonstans.

    Konstanten togs bort den 2026-08-20 när staplingen ersattes av max(). Den
    sattes medvetet INTE till noll: ett kvarlämnat värde hade inbjudit till att
    koppla in dämpningen igen utan att beslutet omprövas.

    Testet failar om någon återinför den — i konfigen eller i modulen.
    """
    from price_engine import damage_pricing

    assert not hasattr(config, "STACK_DECAY")
    assert not hasattr(damage_pricing, "stack")
    assert not hasattr(damage_pricing, "stack_with_ci")

    source = (pathlib.Path("price_engine/damage_pricing.py").read_text()
              + pathlib.Path("price_engine/pricing.py").read_text())
    # Bara kommentarer får nämna namnet.
    code = [line for line in source.splitlines()
            if "STACK_DECAY" in line and not line.strip().startswith("#")]
    assert not code, code


def test_total_is_the_single_worst_damage():
    """Kärnan i max(): fler skador flyttar inte priset."""
    one = dp.resolve(dp.deduplicate(_items("stor reva i tyget", 2, 1))[0],
                     "soffa", 10000)
    many_raw = ([{"description": "stor reva i tyget", "severity": 2}]
                + [{"description": "flack", "severity": 2}]
                + [{"description": "solblekt", "severity": 2}]
                + [{"description": "repa i lacken", "severity": 2}])
    many = dp.resolve(dp.deduplicate(dp.normalise(many_raw))[0], "soffa", 10000)
    assert many["totalDeduction"] == one["totalDeduction"]
    assert len(many["items"]) == 4          # alla redovisas
