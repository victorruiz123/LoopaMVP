#!/usr/bin/env python
"""Mäter L5:s egentliga påstående: unionen i stället för ett gissat typval.

    python measure_union_benefit.py

Kronofelsmåttet i `measure_type_system.py` jämför **punktskattningar**: den typ
motorn valde mot den rätta. Mot det måttet förlorar ett lager som medvetet avstår
från undertypen, även när avståendet är rätt beslut — bilden får rätt bas i
1 720 fall utan undertyp (0 kr fel) men äter 805 kr i snittfel på de 380 fall där
sanningen är en undertyp den aldrig gjorde anspråk på att kunna se.

Men det är inte vad L5 gör. L5:s svar på okänd undertyp är att **söka över unionen
av möjliga typer och bredda intervallet**. Den här mätningen prövar det:

  * `punkt`  — median i den valda typens jämförelsemängd (gamla måttet)
  * `union`  — median i unionen av alla fortfarande möjliga typer
  * `täckt`  — hamnar den rätta typens median INOM unionens spridning?

Det tredje talet är det som betyder något för en prismotor som svarar med
intervall. Ett bredare men täckande intervall är bättre än ett smalt som missar.
"""

from __future__ import annotations

import argparse
import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

from measure_type_system import MIN_CELL, TYPE2BASE, price_cells
from price_engine.data_loader import load_listings
from type_system import model_tokens
from type_system.attributes import Attributes, candidate_types

log = logging.getLogger("union")
OUT = Path("type_system/union_benefit.json")

#: Undertyper per bastyp — unionen bilden lämnar öppen när den bara vet basen.
UNION = {
    "soffa": ("soffa", "hornsoffa", "baddsoffa"),
    "bord": ("bord", "matbord", "matgrupp", "soffbord", "sidobord", "skrivbord"),
    "forvaring": ("forvaring", "byra", "hylla", "skank", "vitrin"),
}


def union_types(base: str) -> tuple:
    return UNION.get(str(base), (str(base),))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_union_benefit.py")
    parser.add_argument("--csv", default="type_system/system_measurement.csv")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    data = pd.read_csv(args.csv)
    listings = load_listings()
    known = model_tokens.distinctive(listings["name_norm"], 12, 40_000)
    log.info("Bygger prisceller ...")
    cells = price_cells(listings, known)
    log.info("Prisceller: %d", len(cells))

    rows = []
    for row in data.itertuples():
        token, kind = str(row.token), str(row.price_kind)
        truth = str(row.truth_type)
        right = cells.get((token, truth, kind))
        if right is None:
            continue
        med_true = float(np.median(right))
        if med_true <= 0:
            continue

        image_base = getattr(row, "_asdict", lambda: {})().get("bild (familj)|base")
        image_base = data.at[row.Index, "bild (familj)|base"]
        if not isinstance(image_base, str):
            continue

        # --- punktskattning: basen som typ ------------------------------
        point = cells.get((token, image_base, kind))
        point_med = float(np.median(point)) if point is not None else None

        # --- unionen: alla fortfarande möjliga typer -------------------
        pool, medians = [], []
        for candidate in union_types(image_base):
            cell = cells.get((token, candidate, kind))
            if cell is not None:
                pool.append(cell)
                medians.append(float(np.median(cell)))
        if not pool:
            continue
        merged = np.concatenate(pool)
        union_med = float(np.median(merged))
        low, high = (min(medians), max(medians)) if medians else (None, None)

        old = data.at[row.Index, "gammal platt klassificerare|type"]
        old_cell = cells.get((token, str(old), kind)) if isinstance(old, str) else None
        old_med = float(np.median(old_cell)) if old_cell is not None else None

        rows.append({
            "truth_type": truth,
            "truth_base": str(row.truth_base),
            "base_ok": image_base == str(row.truth_base),
            "n_union_cells": len(pool),
            "point_error": abs(point_med - med_true) if point_med else None,
            "union_error": abs(union_med - med_true),
            "old_error": abs(old_med - med_true) if old_med else None,
            "covered": bool(low is not None and low <= med_true <= high),
            "spread_ratio": round(high / low, 3) if low and low > 0 else None,
        })

    frame = pd.DataFrame(rows)
    log.info("Mätbara: %d", len(frame))

    report = {"n": int(len(frame))}
    for label, column in (("punkt (basen som typ)", "point_error"),
                          ("union (L5)", "union_error"),
                          ("gammal platt klassificerare", "old_error")):
        values = pd.to_numeric(frame[column], errors="coerce").dropna()
        report[label] = {
            "n": int(len(values)),
            "expected": round(float(values.mean()), 1),
            "median": round(float(values.median()), 1),
            "p90": round(float(values.quantile(0.90)), 1),
        }
    subtyped = frame["truth_type"] != frame["truth_base"]
    report["coverage_of_true_median"] = {
        "all": round(float(frame["covered"].mean()), 3),
        "subtyped_only": round(float(frame[subtyped]["covered"].mean()), 3),
        "n_subtyped": int(subtyped.sum()),
    }
    report["median_spread_ratio"] = round(
        float(pd.to_numeric(frame["spread_ratio"], errors="coerce").median()), 3)

    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    print(f"\nn = {report['n']:,}\n")
    print(f"{'skattning':<32}{'väntevärde':>12}{'median':>9}{'p90':>10}{'n':>8}")
    for label in ("punkt (basen som typ)", "union (L5)",
                  "gammal platt klassificerare"):
        r = report[label]
        print(f"{label:<32}{r['expected']:>12,.0f}{r['median']:>9,.0f}"
              f"{r['p90']:>10,.0f}{r['n']:>8,}")
    cov = report["coverage_of_true_median"]
    print(f"\nrätta typens median hamnar inom unionens spridning:")
    print(f"   alla fall:               {cov['all']*100:.1f} %")
    print(f"   bara undertypade fall:   {cov['subtyped_only']*100:.1f} %  "
          f"(n = {cov['n_subtyped']:,})")
    print(f"\nmedian spridningskvot i unionen: {report['median_spread_ratio']:.2f}x")
    print(f"\nskrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
