"""Enhetstester för Del A (brygga), Del B (omlistning) och Del C (snapshots).

Tre saker måste vara rätt: modellkravets stränghet, kedjeidentifieringens
regler, och snapshot-händelselogiken — särskilt att en LUCKA i körningarna
aldrig får bli ett försvinnande.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

import bridge_matching as BM
import percentile_matching as M
import relist_chains as R
import snapshot_job as SJ
import study_config as S


# --------------------------------------------------------------------------
# Del A — modellkravet
# --------------------------------------------------------------------------
def _sales(blobs: list) -> pd.DataFrame:
    return pd.DataFrame({
        "search_blob": blobs,
        "price": [1000.0] * len(blobs),
        "brand": [""] * len(blobs),
    })


def test_modellnamn_kraver_att_market_ocksa_star_i_texten():
    # "kivik" är både en IKEA-soffa och en ort; "stockholm" både en IKEA-serie
    # och en stad. Utan märket i texten får modellnamnet inte räknas.
    frame = _sales(["ikea kivik 3-sits soffa", "soffa hamtas i kivik",
                    "matbord stockholm", "ikea stockholm soffbord"])
    result = BM.qualify(frame)["model"]
    assert result.iloc[0] == "kivik"
    assert result.iloc[1:3].isna().all()
    assert result.iloc[3] == "stockholm"


def test_modellnamn_hittas_for_designklassiker():
    frame = _sales(["swedese lamino fatolj ek", "fritz hansen sjuan stol",
                    "bruno mathsson pernilla 3"])
    assert BM.qualify(frame)["model"].tolist() == ["lamino", "sjuan", "pernilla"]


def test_omarkta_forsaljningar_far_inget_modellnamn():
    frame = _sales(["fin soffa i gott skick", "gungstol i teak"])
    assert BM.qualify(frame)["model"].isna().all()


def test_ingen_fallbackbreddning_i_bryggan():
    """Ger modellsökningen för få annonser ska försäljningen falla bort.

    Det är hela poängen med Del A: hellre färre mätpunkter än fel
    jämförelsemängd.
    """
    pool = pd.DataFrame({
        "name_norm": ["ikea lamino fatolj", "ikea soffa", "ikea bord"],
        "search_blob": ["ikea lamino fatolj", "ikea soffa", "ikea bord"],
        "brand_norm": ["ikea"] * 3,
        "price": [4000.0, 500.0, 800.0],
        "price_kind": ["asking"] * 3,
        "listed_at": pd.to_datetime(["2025-07-01"] * 3, utc=True),
        "variant": ["fåtölj", "soffa", "bord"],
    })
    matcher = BM.ModelMatcher(pool)
    found = matcher.candidates("ikea", "lamino", pd.Period("2025-07", "M"))
    assert len(found) == 1              # bara Lamino-annonsen
    assert len(found) < S.BRIDGE_MIN_ASKING   # och därmed under kravet


# --------------------------------------------------------------------------
# Del A — rang på motornivå, känd input -> känt svar
# --------------------------------------------------------------------------
def test_rang_pa_motorniva_ger_kant_svar():
    prices = np.array([100.0, 200, 300, 400, 500, 600, 700, 800, 900, 1000])
    assert M.percentile_rank(prices, 450) == pytest.approx(0.4)
    assert M.percentile_rank(prices, 950) == pytest.approx(0.9)


def test_rang_paverkas_av_jamforelsemangden_inte_av_priset_ensamt():
    """Samma pris ger olika rang i olika jämförelsemängder.

    Det är precis därför bryggmätningen behövdes: percentilen är inte en
    egenskap hos priset utan hos priset RELATIVT en mängd.
    """
    smal = np.array([3000.0, 3500, 4000, 4500, 5000])
    bred = np.array([200.0, 400, 800, 1500, 4000])
    assert M.percentile_rank(smal, 4000) == pytest.approx(0.5)
    assert M.percentile_rank(bred, 4000) == pytest.approx(0.9)


# --------------------------------------------------------------------------
# Del B — kedjeidentifieringen
# --------------------------------------------------------------------------
def _listings(rows: list) -> pd.DataFrame:
    frame = pd.DataFrame(rows)
    frame["price_kind"] = "asking"
    frame["listed_at"] = pd.to_datetime(frame["listed_at"], utc=True)
    frame["variant"] = frame.get("variant", "soffa")
    frame["source"] = "archive"
    frame["image_url"] = None
    frame["name"] = frame["name_norm"]
    return frame


def test_massdubbletter_samma_dag_blir_ingen_kedja():
    # Samma annons publicerad brett samma dag är en publiceringsrutin hos en
    # handlare, inte en omlistning.
    frame = _listings([
        {"name_norm": "vitt klaffbord ikea norden med tva stolar",
         "price": 900.0, "listed_at": "2025-03-01"},
        {"name_norm": "vitt klaffbord ikea norden med tva stolar",
         "price": 900.0, "listed_at": "2025-03-01"},
        {"name_norm": "vitt klaffbord ikea norden med tva stolar",
         "price": 900.0, "listed_at": "2025-03-01"},
    ])
    assert R.find_chains(frame).empty


def test_omlistning_med_dagar_emellan_blir_en_kedja():
    frame = _listings([
        {"name_norm": "vitt klaffbord ikea norden med tva stolar",
         "price": 1200.0, "listed_at": "2025-03-01"},
        {"name_norm": "vitt klaffbord ikea norden med tva stolar",
         "price": 900.0, "listed_at": "2025-04-15"},
    ])
    chains = R.find_chains(frame)
    assert len(chains) == 2
    summary = R.summarise_chains(chains)
    assert summary["lowered"].iloc[0]
    assert summary["price_change"].iloc[0] == pytest.approx(-0.25)


def test_for_langt_mellanrum_bryter_kedjan():
    # Ett år mellan två annonser med samma rubrik är sannolikt två olika
    # möbler, inte en omlistning.
    frame = _listings([
        {"name_norm": "vitt klaffbord ikea norden med tva stolar",
         "price": 1200.0, "listed_at": "2024-01-01"},
        {"name_norm": "vitt klaffbord ikea norden med tva stolar",
         "price": 900.0, "listed_at": "2025-06-01"},
    ])
    chains = R.find_chains(frame)
    assert chains.empty or chains["chain_id"].nunique() == 2


def test_prishojning_registreras_som_hojning_inte_sankning():
    frame = _listings([
        {"name_norm": "gammal fin byra i massiv ek fran sekelskiftet",
         "price": 800.0, "listed_at": "2025-03-01"},
        {"name_norm": "gammal fin byra i massiv ek fran sekelskiftet",
         "price": 1200.0, "listed_at": "2025-04-01"},
    ])
    summary = R.summarise_chains(R.find_chains(frame))
    assert summary["raised"].iloc[0]
    assert not summary["lowered"].iloc[0]


def test_smaprisandring_raknas_som_oforandrad():
    frame = _listings([
        {"name_norm": "gammal fin byra i massiv ek fran sekelskiftet",
         "price": 1000.0, "listed_at": "2025-03-01"},
        {"name_norm": "gammal fin byra i massiv ek fran sekelskiftet",
         "price": 1010.0, "listed_at": "2025-04-01"},
    ])
    summary = R.summarise_chains(R.find_chains(frame))
    assert not summary["lowered"].iloc[0]
    assert not summary["raised"].iloc[0]


def test_jaccard_ar_okanslig_for_ordfoljd():
    assert R._jaccard("ikea soffa gra", "gra soffa ikea") == pytest.approx(1.0)
    assert R._jaccard("ikea soffa", "helt annat bord") == 0.0


# --------------------------------------------------------------------------
# Del C — snapshot-händelser, och luckor
# --------------------------------------------------------------------------
def _runs(n: int, start: datetime = None) -> pd.DataFrame:
    start = start or datetime(2026, 8, 1, tzinfo=timezone.utc)
    return pd.DataFrame({
        "observed_at": [start + timedelta(days=i) for i in range(n)],
        "listings": [10] * n,
    })


def _observations(entries: list) -> pd.DataFrame:
    return pd.DataFrame(entries)


def test_lucka_i_korningar_ar_inte_ett_forsvinnande():
    """Designens känsligaste punkt.

    Uteblir en körning registreras ingen ny körning, och då ökar ingens
    missing_runs. Hade försvinnande räknats i kalendertid skulle ett
    driftstopp förvandla hela beståndet till försvunna annonser på en gång.
    """
    start = datetime(2026, 8, 1, tzinfo=timezone.utc)
    # Två körningar med en veckas mellanrum — alltså en lång LUCKA, men bara
    # två körningar. Annonsen syns i båda.
    runs = pd.DataFrame({
        "observed_at": [start, start + timedelta(days=7)],
        "listings": [10, 10],
    })
    observations = _observations([
        {"listing_id": "a", "price": 1000.0, "title": "soffa", "observed_at": start},
        {"listing_id": "a", "price": 1000.0, "title": "soffa",
         "observed_at": start + timedelta(days=7)},
    ])
    events = SJ.derive_events(observations, runs)
    assert not events["disappeared"].iloc[0]
    assert events["missing_runs"].iloc[0] == 0
    assert events["days_observed"].iloc[0] == 7


def test_forsvunnen_forst_efter_tva_missade_korningar():
    runs = _runs(3)
    start = runs["observed_at"].iloc[0]
    observations = _observations([
        {"listing_id": "a", "price": 1000.0, "title": "soffa", "observed_at": start},
    ])
    events = SJ.derive_events(observations, runs)
    assert events["missing_runs"].iloc[0] == 2
    assert events["disappeared"].iloc[0]


def test_en_missad_korning_racker_inte():
    runs = _runs(2)
    start = runs["observed_at"].iloc[0]
    observations = _observations([
        {"listing_id": "a", "price": 1000.0, "title": "soffa", "observed_at": start},
    ])
    events = SJ.derive_events(observations, runs)
    assert events["missing_runs"].iloc[0] == 1
    assert not events["disappeared"].iloc[0]


def test_prisandringar_registreras_med_datum_och_belopp():
    runs = _runs(3)
    times = runs["observed_at"].tolist()
    observations = _observations([
        {"listing_id": "a", "price": 1000.0, "title": "soffa", "observed_at": times[0]},
        {"listing_id": "a", "price": 900.0, "title": "soffa", "observed_at": times[1]},
        {"listing_id": "a", "price": 800.0, "title": "soffa", "observed_at": times[2]},
    ])
    events = SJ.derive_events(observations, runs)
    row = events.iloc[0]
    assert row["n_price_changes"] == 2
    assert row["price_changes"][0]["from"] == 1000.0
    assert row["price_changes"][0]["to"] == 900.0
    assert row["total_change"] == pytest.approx(-0.2)


def test_avrundningsbrus_raknas_inte_som_prisandring():
    runs = _runs(2)
    times = runs["observed_at"].tolist()
    observations = _observations([
        {"listing_id": "a", "price": 1000.0, "title": "soffa", "observed_at": times[0]},
        {"listing_id": "a", "price": 1002.0, "title": "soffa", "observed_at": times[1]},
    ])
    assert SJ.derive_events(observations, runs)["n_price_changes"].iloc[0] == 0


def test_overlevnadskurvan_vagrar_svara_pa_for_kort_tidsserie():
    """En kurva byggd på två dagars data skulle se ut som ett svar."""
    runs = _runs(2)
    times = runs["observed_at"].tolist()
    observations = _observations([
        {"listing_id": f"a{i}", "price": 1000.0, "title": "soffa",
         "observed_at": t}
        for i in range(40) for t in times
    ])
    events = SJ.derive_events(observations, runs)
    skeleton = SJ.survival_skeleton(events)
    assert skeleton["status"] == "för kort tidsserie"
    assert all(v is None for v in skeleton["survival"].values())


def test_observationen_ar_en_rad_per_annons():
    listings = pd.DataFrame({
        "price_kind": ["asking"] * 3 + ["realized"],
        "dedup_key": ["a", "a", "b", "c"],
        "name_norm": ["x", "x", "y", "z"],
        "price": [100.0, 100.0, 200.0, 300.0],
        "name": ["x", "x", "y", "z"],
    })
    snapshot = SJ.observe(listings, datetime(2026, 8, 1, tzinfo=timezone.utc))
    assert len(snapshot) == 2                 # a och b, inte dubbletten
    assert "c" not in set(snapshot["listing_id"])   # auktion observeras inte
