#!/usr/bin/env python
"""Del C — snapshot-jobbet: bygg tidsserien framåt.

    python snapshot_job.py observe          # en körning: observera allt just nu
    python snapshot_job.py events           # härled händelser ur observationerna
    python snapshot_job.py status           # vad har vi, och när bär det?

Allt annat i projektet är rekonstruktion ur stillbilder. Den riktiga valutan —
säljtid, osåld-andel, prissänkningar i realtid — kräver att SAMMA annons
observeras flera gånger. Varje vecka utan snapshots är omätbar tid.

Jobbet lägger ingen ny insamlingslogik ovanpå: det läser samma källa som
blocket-datan redan kommer från, och skriver en rad per (annons, datum, pris).
Inga bilder, inga beskrivningar — observationstabellen ska vara liten nog att
växa dagligen i åratal.

Se SNAPSHOT_DESIGN.md för schema, körschema och när datan börjar bära.
"""

from __future__ import annotations

import argparse
import logging
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

import study_config as S
from price_engine.data_loader import load_listings

log = logging.getLogger("snapshot")

SNAPSHOT_DIR = S.STUDY_DIR.parent / "snapshots"
OBSERVATIONS = SNAPSHOT_DIR / "observations.parquet"
EVENTS = SNAPSHOT_DIR / "events.parquet"
RUNS = SNAPSHOT_DIR / "runs.parquet"

#: Annonsen räknas som försvunnen först efter så här många körningar utan
#: att ha synts. Ett enda missat pass får ALDRIG tolkas som försvinnande —
#: se `missing_runs` i händelselogiken.
DISAPPEARED_AFTER_RUNS = 2

#: Prisändring under detta i relativa tal är avrundningsbrus, inte en ändring.
PRICE_CHANGE_EPS = 0.005


# --------------------------------------------------------------------------
# Observationer
# --------------------------------------------------------------------------
def observe(listings: pd.DataFrame, observed_at: datetime = None) -> pd.DataFrame:
    """En körning: annons-ID, pris, titel, observationstidpunkt.

    Bara aktiva utropsannonser observeras. Auktionsdata har redan sitt utfall
    och behöver ingen tidsserie.
    """
    observed_at = observed_at or datetime.now(timezone.utc)
    active = listings[listings["price_kind"] == "asking"]
    key = "dedup_key" if active["dedup_key"].notna().any() else "name_norm"

    snapshot = pd.DataFrame({
        "listing_id": active[key].astype(str),
        "price": active["price"].astype(float),
        "title": active["name"].astype(str),
        "observed_at": observed_at,
    })
    # En rad per annons och körning — samma annons kan förekomma flera gånger
    # i källan, men observationen är en.
    return snapshot.drop_duplicates("listing_id").reset_index(drop=True)


def append(snapshot: pd.DataFrame) -> Path:
    """Append-only. Dedupad på (annons, körning) så omkörning är ofarlig."""
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    if OBSERVATIONS.is_file():
        existing = pd.read_parquet(OBSERVATIONS)
        combined = pd.concat([existing, snapshot], ignore_index=True)
    else:
        combined = snapshot
    combined = combined.drop_duplicates(subset=["listing_id", "observed_at"],
                                        keep="last")
    combined.to_parquet(OBSERVATIONS, index=False)

    run = pd.DataFrame([{
        "observed_at": snapshot["observed_at"].iloc[0],
        "listings": len(snapshot),
    }])
    runs = (pd.concat([pd.read_parquet(RUNS), run], ignore_index=True)
            if RUNS.is_file() else run)
    runs.drop_duplicates("observed_at", keep="last").to_parquet(RUNS, index=False)

    log.info("Observationer: +%d rader (totalt %d, %d körningar)",
             len(snapshot), len(combined), len(runs))
    return OBSERVATIONS


# --------------------------------------------------------------------------
# Härledda händelser
# --------------------------------------------------------------------------
def derive_events(observations: pd.DataFrame, runs: pd.DataFrame) -> pd.DataFrame:
    """first_seen, last_seen, prisändringar, försvinnande.

    Luckhanteringen är hela poängen. En missad körning betyder att INGEN
    annons observerades, och då får ingen annons räknas som försvunnen. Därför
    utgår försvinnandet från antalet KÖRNINGAR en annons saknats i, inte från
    kalendertid — hade det varit kalendertid skulle en veckas driftstopp
    förvandla hela beståndet till försvunna annonser på en gång.
    """
    if observations.empty:
        return pd.DataFrame()

    run_times = np.sort(runs["observed_at"].unique())
    run_index = {t: i for i, t in enumerate(run_times)}
    last_run = len(run_times) - 1

    rows = []
    for listing_id, group in observations.sort_values("observed_at").groupby("listing_id"):
        prices = group["price"].to_numpy(float)
        times = group["observed_at"].to_numpy()

        changes = []
        for i in range(1, len(prices)):
            if prices[i - 1] <= 0:
                continue
            delta = (prices[i] - prices[i - 1]) / prices[i - 1]
            if abs(delta) > PRICE_CHANGE_EPS:
                changes.append({
                    "at": str(times[i]), "from": float(prices[i - 1]),
                    "to": float(prices[i]), "change": round(float(delta), 4),
                })

        seen_last_at = run_index.get(times[-1], last_run)
        missing_runs = last_run - seen_last_at
        rows.append({
            "listing_id": listing_id,
            "first_seen": times[0],
            "last_seen": times[-1],
            "observations": len(group),
            "first_price": float(prices[0]),
            "last_price": float(prices[-1]),
            "total_change": (round(float((prices[-1] - prices[0]) / prices[0]), 4)
                             if prices[0] > 0 else None),
            "price_changes": changes,
            "n_price_changes": len(changes),
            "missing_runs": int(missing_runs),
            "disappeared": bool(missing_runs >= DISAPPEARED_AFTER_RUNS),
            "days_observed": float(
                (pd.Timestamp(times[-1]) - pd.Timestamp(times[0])).days),
        })
    return pd.DataFrame(rows)


def survival_skeleton(events: pd.DataFrame, ranks: pd.DataFrame = None) -> dict:
    """Skelett för överlevnadskurvan — glidknappens slutgiltiga facit.

    "Andel kvar efter X dagar som funktion av startrang." Fylls när datan
    vuxit; strukturen byggs nu så att analysen inte behöver uppfinnas när
    datan väl finns.

    Kurvan kräver att annonser HUNNIT försvinna. Med daglig körning och
    DISAPPEARED_AFTER_RUNS = 2 betyder det tidigast efter ett par dagar för de
    snabbaste, men en meningsfull kurva kräver att fördelningen av
    observationslängder täcker de intervall man vill uttala sig om.
    """
    if events.empty:
        return {"status": "inga observationer än"}

    horizons = (7, 14, 30, 60, 90)
    span = float(events["days_observed"].max())
    curve = {}
    for days in horizons:
        if span < days:
            curve[f"{days}d"] = None  # täcks inte av datan än
            continue
        at_risk = events[events["days_observed"] >= days]
        if len(at_risk) < 30:
            curve[f"{days}d"] = None
            continue
        curve[f"{days}d"] = round(float(1 - at_risk["disappeared"].mean()), 4)

    return {
        "status": "ok" if any(v is not None for v in curve.values())
                  else "för kort tidsserie",
        "observation_span_days": span,
        "survival": curve,
        "n_events": int(len(events)),
        "n_disappeared": int(events["disappeared"].sum()),
        "note": ("Startrang kräver att varje annons matchas mot sin samtida "
                 "fördelning via motorns pipeline — samma kod som Del A. "
                 "Kopplas in när tidsserien bär."),
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def status() -> dict:
    if not OBSERVATIONS.is_file():
        return {"observations": 0, "runs": 0,
                "note": "Inga körningar än — kör `observe`."}
    observations = pd.read_parquet(OBSERVATIONS)
    runs = pd.read_parquet(RUNS)
    events = pd.read_parquet(EVENTS) if EVENTS.is_file() else pd.DataFrame()

    first = pd.Timestamp(runs["observed_at"].min())
    weeks = (datetime.now(timezone.utc) - first.to_pydatetime()).days / 7
    return {
        "observations": len(observations),
        "unique_listings": int(observations["listing_id"].nunique()),
        "runs": len(runs),
        "first_run": str(first),
        "weeks_of_data": round(weeks, 1),
        "weeks_until_survival_curves": max(0, round(6 - weeks, 1)),
        "events": len(events),
        "survival": survival_skeleton(events) if len(events) else None,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="snapshot_job.py")
    parser.add_argument("command", choices=["observe", "events", "status"])
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if args.command == "observe":
        append(observe(load_listings()))
    elif args.command == "events":
        if not OBSERVATIONS.is_file():
            log.error("Inga observationer än — kör `observe` först")
            return 1
        events = derive_events(pd.read_parquet(OBSERVATIONS),
                               pd.read_parquet(RUNS))
        events.to_parquet(EVENTS, index=False)
        log.info("Händelser: %d annonser, %d försvunna, %d med prisändring",
                 len(events), int(events["disappeared"].sum()),
                 int((events["n_price_changes"] > 0).sum()))
    else:
        import json
        print(json.dumps(status(), ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
