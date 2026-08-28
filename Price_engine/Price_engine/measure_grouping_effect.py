#!/usr/bin/env python
"""Steg 6 och 7: vad grupperingen gjorde med intervallen — och baksidan.

    python measure_grouping_effect.py

**Vinsten och kostnaden redovisas bredvid varandra.** En finare nyckel ger
smalare intervall OCH mindre celler. Att rapportera det ena utan det andra vore
att sälja in en förbättring som kanske är en försämring.

`FÖRE` är den gamla grupperingen rekonstruerad: möbeltyp ur `derived_type`,
modellnyckel som FÖRSTA distinktiva ordet, inget märke ur rubriken, ingen
uteslutning av tillbehör eller buntar. Det är hur motorn faktiskt grupperade.

Steg 7 skriver `data/experiment/spread_inspection.csv` — de 20 celler som
fortfarande har störst prisspridning, med sina fem dyraste och fem billigaste
rubriker. Det är där nästa Madison-fel syns.
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

from type_system import model_tokens

log = logging.getLogger("effekt")
CELLS = Path("type_system/price_cells.parquet")
OUT = Path("type_system/grouping_effect.json")
# INTE under ./data — den katalogen läses som datakälla av config.DATA_DIR,
# och att skriva hit bytte tyst motorns korpus mot den här 200-radiga filen.
INSPECT = Path("type_system/experiment/spread_inspection.csv")
MIN_CELL = 30
MIN_SPREAD_N = 20


def old_cells(frame: pd.DataFrame) -> pd.Series:
    """Den gamla grupperingen: typ ur derived_type, första distinktiva ordet."""
    known = model_tokens.distinctive(frame["name_norm"], 12, 40_000)
    first = [(model_tokens.of(n, known) or ("",))[0] for n in frame["name_norm"]]
    brand = frame["brand_norm"].fillna("").astype(str)
    kind = frame["derived_type"].fillna("okand").astype(str)
    return brand + "|" + kind + "|" + pd.Series(first, index=frame.index)


def width(group: pd.Series) -> float:
    """p30-p60 som andel av medianen. Motorns faktiska fönster."""
    median = group.median()
    if not median or median <= 0:
        return np.nan
    return float((group.quantile(0.60) - group.quantile(0.30)) / median)


def summarise(frame: pd.DataFrame, column: str, label: str) -> dict:
    sizes = frame.groupby(column).size()
    big = sizes[sizes >= MIN_CELL]
    widths = (frame[frame[column].isin(big.index)]
              .groupby(column)["price"].apply(width).dropna())
    return {
        "label": label,
        "cells": int(len(sizes)),
        "cells_big": int(len(big)),
        "share_in_big": round(float(big.sum() / len(frame)), 4),
        "median_width": round(float(widths.median()), 4) if len(widths) else None,
        "mean_width": round(float(widths.mean()), 4) if len(widths) else None,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_grouping_effect.py")
    parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    frame = pd.read_parquet(CELLS)
    frame = frame[frame["price"].gt(0)].copy()
    log.info("Rader med pris: %d", len(frame))

    frame["old_cell"] = old_cells(frame)
    after = frame[~frame["excluded"]]

    before_stats = summarise(frame, "old_cell", "FÖRE")
    after_stats = summarise(after, "cell_no_config", "EFTER")

    print(f"\n{'':<26}{'FÖRE':>12}{'EFTER':>12}")
    print(f"{'celler':<26}{before_stats['cells']:>12,}{after_stats['cells']:>12,}")
    print(f"{'celler med n>=30':<26}{before_stats['cells_big']:>12,}"
          f"{after_stats['cells_big']:>12,}")
    print(f"{'andel data i n>=30':<26}{before_stats['share_in_big']*100:>11.1f}%"
          f"{after_stats['share_in_big']*100:>11.1f}%")
    print(f"{'intervallbredd (median)':<26}{before_stats['median_width']*100:>11.1f}%"
          f"{after_stats['median_width']*100:>11.1f}%")

    # --- rader som bytte cell, per orsak ---------------------------------
    reasons = {
        "tillbehör (utesluts)": frame["is_accessory_only"],
        "jämförelse (utesluts)": frame["is_comparison"],
        "sektion (utesluts)": frame.get("is_section", pd.Series(False, index=frame.index)),
        "bunt (egen cell)": frame["is_bundle"],
    }
    print(f"\n=== rader som lämnade basproduktens cell ===")
    for label, mask in reasons.items():
        print(f"   {label:<26}{int(mask.sum()):>9,}")

    # --- celler vars median flyttade mer än 20 % -------------------------
    old_median = frame.groupby("old_cell")["price"].median()
    new_median = after.groupby("cell_no_config")["price"].median()
    link = (after.groupby("cell_no_config")["old_cell"]
            .agg(lambda s: s.value_counts().index[0]))
    moved = []
    for new_key, old_key in link.items():
        a, b = old_median.get(old_key), new_median.get(new_key)
        if not a or not b or a <= 0:
            continue
        n = int((after["cell_no_config"] == new_key).sum())
        if n < MIN_CELL:
            continue
        shift = b / a - 1
        if abs(shift) > 0.20:
            moved.append({"cell": new_key, "old_cell": old_key, "n": n,
                          "before": float(a), "after": float(b),
                          "shift": round(float(shift), 3)})
    moved.sort(key=lambda r: -abs(r["shift"]))
    print(f"\n=== celler (n>={MIN_CELL}) vars median flyttade >20 %: {len(moved)} ===")
    print(f"   {'cell':<44}{'n':>6}{'före':>9}{'efter':>9}{'skift':>8}")
    for row in moved[:20]:
        print(f"   {row['cell'][:43]:<44}{row['n']:>6}{row['before']:>9,.0f}"
              f"{row['after']:>9,.0f}{row['shift']*100:>7.0f}%")

    # --- steg 7: största kvarvarande spridning ---------------------------
    sizes = after.groupby("cell_no_config").size()
    candidates = sizes[sizes >= MIN_SPREAD_N].index
    subset = after[after["cell_no_config"].isin(candidates)]
    spread = (subset.groupby("cell_no_config")["price"]
              .apply(lambda s: s.quantile(0.95) / max(s.quantile(0.05), 1)))
    worst = spread.sort_values(ascending=False).head(20)

    INSPECT.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    print(f"\n=== steg 7: 20 celler med störst kvarvarande spridning ===")
    for cell, ratio in worst.items():
        part = subset[subset["cell_no_config"] == cell]
        print(f"\n   {cell}   n={len(part)}  p95/p05={ratio:.0f}x  "
              f"median={part['price'].median():,.0f}")
        for tag, sel in (("dyrast", part.nlargest(5, "price")),
                         ("billigast", part.nsmallest(5, "price"))):
            for _, r in sel.iterrows():
                print(f"      {tag:<10}{r['price']:>8,.0f}  {str(r['name'])[:56]}")
                rows.append({"cell": cell, "n": len(part), "spread": round(ratio, 1),
                             "kant": tag, "pris": r["price"], "rubrik": r["name"]})
    pd.DataFrame(rows).to_csv(INSPECT, index=False)

    OUT.write_text(json.dumps({"before": before_stats, "after": after_stats,
                               "moved_over_20pct": len(moved),
                               "top_moves": moved[:20]},
                              ensure_ascii=False, indent=2))
    print(f"\nskrivet till {OUT} och {INSPECT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
