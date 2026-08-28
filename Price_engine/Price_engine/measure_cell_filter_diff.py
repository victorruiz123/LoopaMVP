#!/usr/bin/env python
"""Vad cellfiltret kastade, möbel för möbel.

    python measure_cell_filter_diff.py --specs benchmark/items_11.json

En siffra som säger "filtret tog bort 20 rader" går inte att granska. Det här
skriptet visar de fem dyraste och fem billigaste raderna filtret kastade för
varje möbel, med orsak — så det går att se med egna ögon om det som försvann
verkligen var skräp, eller om filtret åt av jämförelsemängden.

Skriptet RÖR INTE motorn. Det kör samma textsökning och samma filterfunktion som
`price_query`, men beräknar inget pris och ändrar ingen konfiguration.
"""

from __future__ import annotations

import argparse
import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import pandas as pd

from price_engine import pricing
from price_engine.data_loader import load_listings

log = logging.getLogger("filterdiff")
OUT = Path("type_system/cell_filter_diff.csv")

#: Orsaksordens betydelse, för läsbarhet i utskriften.
REASONS = {
    "is_accessory_only": "tillbehör",
    "is_bundle": "bunt",
    "is_comparison": "jämförelse",
    "is_section": "sektion",
}


def core_name(model: str) -> str:
    from evaluate_examples import core_name as _core
    return _core(model)


def rows_for(item: dict) -> tuple:
    """Söknyckeln och den fulla texten, precis som harnessen bygger dem."""
    model = item.get("model")
    kind = str(item.get("variant") or item.get("category") or "").strip()
    if not model:
        name = kind
    elif not item.get("brand"):
        name = model
    else:
        name = core_name(model)
    full = " ".join(p for p in (model or "", kind) if p).strip() or name
    return name, full


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_cell_filter_diff.py")
    parser.add_argument("--specs", action="append", required=True)
    parser.add_argument("--top", type=int, default=5)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    records = []
    for spec in args.specs:
        tag = Path(spec).stem.replace("items_", "")
        for item in json.loads(Path(spec).read_text()):
            name, full = rows_for(item)
            label = item.get("label") or " ".join(
                p for p in (item.get("brand"), item.get("model")) if p) or name
            text = pricing.find_listings(listings, name, item.get("brand"),
                                         condition=None, price_kind=None)
            if text.empty:
                continue
            kept, soft, dropped = pricing._cell_filter(text, full, item.get("brand"))
            if not dropped:
                continue
            gone = text.loc[text.index.difference(kept.index)]
            print(f"\n=== {tag}#{item['nr']} {label} ===")
            print(f"    sökning {len(text):,} -> kvar {len(kept):,}   "
                  + "  ".join(f"{REASONS.get(k, k)} {v:,}"
                              for k, v in dropped.items()))
            if len(text):
                print(f"    median före {text['price'].median():,.0f} kr"
                      f"   efter {kept['price'].median():,.0f} kr"
                      if len(kept) else "    inget kvar")
            for edge, sel in (("dyrast", gone.nlargest(args.top, "price")),
                              ("billigast", gone.nsmallest(args.top, "price"))):
                for _, row in sel.iterrows():
                    why = next((REASONS[f] for f in REASONS
                                if f in row.index and bool(row[f])), "typmotsägelse")
                    print(f"      {edge:<10}{row['price']:>9,.0f}  {why:<12}"
                          f"{str(row['name'])[:52]}")
                    records.append({
                        "bench": tag, "nr": item["nr"], "möbel": label,
                        "kant": edge, "pris": row["price"], "orsak": why,
                        "rubrik": row["name"]})
    if records:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        pd.DataFrame(records).to_csv(args.out, index=False)
        print(f"\nskrivet till {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
