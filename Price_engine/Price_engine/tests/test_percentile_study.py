"""Enhetstester för percentilstudien.

Tre saker måste vara rätt för att resultatet ska betyda något: percentilrangen,
budspärrens nedtrappning och tidsmatchningen. Går någon av dem sönder blir
siffrorna fortfarande rimliga att titta på — och därför farliga.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

import percentile_estimate as E
import percentile_matching as M
import study_config as S


# --------------------------------------------------------------------------
# Percentilrang
# --------------------------------------------------------------------------
def test_rang_ar_andelen_under():
    priser = np.array([100.0, 200, 300, 400, 500])
    assert M.percentile_rank(priser, 250) == pytest.approx(0.4)
    assert M.percentile_rank(priser, 50) == pytest.approx(0.0)
    assert M.percentile_rank(priser, 1000) == pytest.approx(1.0)


def test_rang_vid_prisklump_hamnar_mitt_i():
    # Utropspriser klumpar hårt på jämna tal. En försäljning på exakt 1 000 kr
    # ska varken få noll kredit för klumpen eller full kredit för den.
    priser = np.array([500.0] + [1000.0] * 8 + [2000.0])
    assert M.percentile_rank(priser, 1000) == pytest.approx(0.5)


def test_rang_pa_tom_fordelning_ar_nan():
    assert np.isnan(M.percentile_rank(np.empty(0), 500))


def test_rang_ar_monoton():
    priser = np.sort(np.random.default_rng(0).uniform(100, 5000, 500))
    ranger = [M.percentile_rank(priser, v) for v in (200, 800, 1500, 3000, 4500)]
    assert ranger == sorted(ranger)


# --------------------------------------------------------------------------
# Budspärrens nedtrappning
# --------------------------------------------------------------------------
def _bud(antal_per_niva: dict) -> pd.Series:
    return pd.Series([b for b, n in antal_per_niva.items() for _ in range(n)])


def test_stark_grupp_behaller_hogsta_troskeln():
    bids = _bud({7: S.BID_STEPDOWN_BELOW + 10})
    assert E.choose_bid_threshold(bids) == (5, S.BID_STEPDOWN_BELOW + 10)


def test_trappas_ned_till_fyra_nar_femman_ar_for_tunn():
    bids = _bud({5: 10, 4: S.BID_STEPDOWN_BELOW})
    threshold, n = E.choose_bid_threshold(bids)
    assert threshold == 4
    assert n == S.BID_STEPDOWN_BELOW + 10


def test_trappas_ned_till_tre_nar_fyran_ocksa_ar_for_tunn():
    bids = _bud({5: 5, 4: 5, 3: S.BID_STEPDOWN_BELOW})
    threshold, _ = E.choose_bid_threshold(bids)
    assert threshold == 3


def test_gar_aldrig_under_tre():
    # Ett ensamt bud är en likvidation, inte prisupptäckt — hur tunn gruppen
    # än blir får spärren inte släppa ned till 1 eller 2.
    bids = _bud({1: 500, 2: 500})
    threshold, n = E.choose_bid_threshold(bids)
    assert threshold == 3
    assert n == 0


# --------------------------------------------------------------------------
# Tidsmatchning
# --------------------------------------------------------------------------
def _pool(dates: list, prices: list) -> pd.DataFrame:
    return pd.DataFrame({
        "listed_at": pd.to_datetime(dates, utc=True),
        "price": prices,
        "variant": ["soffa"] * len(dates),
        "name_norm": [f"soffa {i}" for i in range(len(dates))],
        "price_kind": ["asking"] * len(dates),
    })


def test_bara_samtida_annonser_matchas():
    pool = _pool(
        ["2024-01-15", "2025-06-15", "2025-07-15", "2025-08-15", "2026-06-15"],
        [100.0, 1000, 1100, 1200, 9000],
    )
    cache = M.MatchCache(pool, {})
    prices = cache.prices("variant", "", "soffa", pd.Period("2025-07", "M"))
    # ±3 månader kring juli 2025 -> april till oktober 2025.
    assert sorted(prices) == [1000.0, 1100.0, 1200.0]


def test_fonstret_ar_symmetriskt():
    pool = _pool(
        ["2025-04-01", "2025-07-15", "2025-10-31", "2025-03-31", "2025-11-01"],
        [1.0, 2, 3, 4, 5],
    )
    cache = M.MatchCache(pool, {})
    prices = cache.prices("variant", "", "soffa", pd.Period("2025-07", "M"))
    assert sorted(prices) == [1.0, 2.0, 3.0]


def test_marknadsfall_skulle_synas_utan_tidsfilter():
    # Marknaden föll mätbart under datans tidsspann. Utan tidsfilter skulle
    # en försäljning 2024 jämföras med 2026 års priser och få fel rang.
    pool = _pool(
        ["2024-08-01"] * 3 + ["2026-05-01"] * 3,
        [2000.0, 2200, 2400, 700, 800, 900],
    )
    cache = M.MatchCache(pool, {})
    gammal = cache.prices("variant", "", "soffa", pd.Period("2024-08", "M"))
    ny = cache.prices("variant", "", "soffa", pd.Period("2026-05", "M"))
    assert list(gammal) == [2000.0, 2200.0, 2400.0]
    assert list(ny) == [700.0, 800.0, 900.0]
    # Samma slutpris ger helt olika rang beroende på när det såldes.
    assert M.percentile_rank(gammal, 2100) < M.percentile_rank(ny, 2100)


def test_cachen_ger_samma_svar_som_forsta_uppslaget():
    pool = _pool(["2025-07-01", "2025-08-01"], [500.0, 700.0])
    cache = M.MatchCache(pool, {})
    first = cache.prices("variant", "", "soffa", pd.Period("2025-07", "M"))
    second = cache.prices("variant", "", "soffa", pd.Period("2025-07", "M"))
    assert list(first) == list(second)
    assert cache.hits == 1 and cache.misses == 1


# --------------------------------------------------------------------------
# Cirkelbrytaren
# --------------------------------------------------------------------------
def test_prisnivan_bygger_pa_matchad_median_inte_slutpris():
    """Klassas grupperna på slutpriset blir resultatet förutbestämt."""
    frame = pd.DataFrame({
        "variant": ["soffa"] * 6,
        # Slutpriset går uppåt, den matchade medianen nedåt — de får alltså
        # inte ge samma tercilindelning.
        "price": [100.0, 200, 300, 400, 500, 600],
        "matched_median": [6000.0, 5000, 4000, 3000, 2000, 1000],
    })
    tiers = M.assign_price_tier(frame)
    assert tiers.iloc[0] == S.PRICE_TIER_NAMES[-1]   # högst matchad median
    assert tiers.iloc[-1] == S.PRICE_TIER_NAMES[0]   # lägst matchad median


def test_prisnivan_klarar_klumpade_medianer():
    # Samma sökning ger samma median för hundratals försäljningar; då
    # kollapsar kvantilkanter och en naiv pd.cut kraschar.
    frame = pd.DataFrame({
        "variant": ["soffa"] * 9,
        "price": list(range(9)),
        "matched_median": [1000.0] * 6 + [5000.0, 5000.0, 9000.0],
    })
    tiers = M.assign_price_tier(frame)
    assert tiers.notna().all()
    assert set(tiers) <= set(S.PRICE_TIER_NAMES)


# --------------------------------------------------------------------------
# Kanalgapets extrapolering
# --------------------------------------------------------------------------
def test_lag_end_arver_aldrig_mid_gapet():
    table = {"high": {"gap": -0.05}, "mid": {"gap": -0.10}, "low": {"gap": None}}
    gap, status = E.extrapolate_low_gap(table)
    assert status == "gap_extrapolated"
    assert gap == pytest.approx(-0.15)  # trenden fortsätter, inte mid-värdet


def test_brant_trend_ger_insufficient_market_i_stallet():
    # Ett underkorrigerat low-end-värde ser ut som ett svar och används som
    # ett. Hellre inget värde.
    table = {"high": {"gap": -0.02}, "mid": {"gap": -0.30}, "low": {"gap": None}}
    gap, status = E.extrapolate_low_gap(table)
    assert gap is None
    assert status == "insufficient_market"


def test_uppmatt_lag_gap_anvands_rakt_av():
    table = {"high": {"gap": -0.05}, "mid": {"gap": -0.10}, "low": {"gap": -0.42}}
    assert E.extrapolate_low_gap(table) == (-0.42, "gap_measured")
