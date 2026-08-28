#!/usr/bin/env python
"""Steg 2: är `fåtölj` mot `stol` prisrelevant nog att behålla som egen typ?

    python measure_chair_relevance.py

Den gamla taxonomin skiljer dem — 96 220 annonser är `fåtölj`. Den nya lägger
båda under `stol`, inte av övertygelse utan för att prisrelevansen aldrig
prövades: `measure_price_relevance.py` mätte soffor, bord och förvaring, men
aldrig stolar.

Att slå ihop dem utan att mäta vore samma fel som att låta `chaise` härleda
hörnsoffa hade varit — ett antagande som ser ut som ett beslut.

Metoden är identisk med den som avgjorde de andra familjerna: **parvisa medianer
inom modellord och priskälla**, så att märkesmix inte förväxlas med attributet.
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

from measure_price_relevance import MERGE_THRESHOLD, MIN_GROUPS, MIN_PER_BUCKET, pairwise
from price_engine.data_loader import load_listings
from type_system import model_tokens

log = logging.getLogger("stolar")
OUT = Path("type_system/chair_relevance.json")

#: Ord som gör en sittmöbel till fåtölj respektive vanlig stol. Ur korpusens
#: frekvensräkning, inte påhittade.
FATOLJ = r"fatolj|fatoljer|lansstol|vilstol|oronlappsfatolj|snurrfatolj"
STOL = r"\bstol\b|stolar|matstol|koksstol|pinnstol|karmstol|matsalsstol"
#: Ord som är någon av delarna men inte en fristående sittmöbel.
EXCLUDE = r"barnstol|barstol|kontorsstol|skrivbordsstol|pall|fotpall|stolsdyna|stolkladsel"


def bucket(blob: str):
    if pd.isna(blob):
        return None
    import re
    if re.search(EXCLUDE, blob):
        return None
    fatolj = re.search(FATOLJ, blob) is not None
    stol = re.search(STOL, blob) is not None
    if fatolj and not stol:
        return "fatolj"
    if stol and not fatolj:
        return "stol"
    return None            # båda eller ingen -> tvetydig, uteslut


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_chair_relevance.py")
    parser.add_argument("--min-token", type=int, default=20)
    parser.add_argument("--max-token", type=int, default=20_000)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    frame = listings[listings["search_blob"].str.contains(
        r"stol|fatolj", na=False)][["search_blob", "name_norm", "price", "price_kind"]]
    frame = frame.copy()
    frame["bucket"] = [bucket(b) for b in frame["search_blob"]]
    frame = frame[frame["bucket"].notna() & frame["price"].gt(0)]
    log.info("sittmöbler i buckets: %d  %s", len(frame),
             frame["bucket"].value_counts().to_dict())

    known = model_tokens.distinctive(frame["name_norm"], args.min_token,
                                     args.max_token)
    log.info("modellord: %d", len(known))
    rows = []
    for name, b, price, kind in zip(frame["name_norm"], frame["bucket"],
                                    frame["price"], frame["price_kind"]):
        for token in set(model_tokens.of(name, known)):
            rows.append((token, b, price, kind))
    tagged = pd.DataFrame(rows, columns=["model_token", "bucket", "price",
                                         "price_kind"])
    log.info("(annons, modellord)-par: %d", len(tagged))

    result = pairwise(tagged, ["fatolj", "stol"])
    report = {
        "n_listings": int(len(frame)),
        "bucket_counts": {k: int(v) for k, v in frame["bucket"].value_counts().items()},
        "pairwise": result,
    }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    print(f"\nsittmöbler: {len(frame):,}   "
          f"{frame['bucket'].value_counts().to_dict()}")
    print(f"\n{'par':<24}{'kvot':>7}{'skillnad':>10}{'grupper':>9}{'95% KI':>18}  beslut")
    for pair, r in result.items():
        ci = f"[{r['ci95'][0]:.2f}, {r['ci95'][1]:.2f}]"
        verdict = "SLÅ IHOP" if r["merge"] else "BEHÅLL"
        print(f"{pair:<24}{r['median_ratio']:>7.2f}{r['diff_pct']:>9.1f}%"
              f"{r['groups']:>9}{ci:>18}  {verdict}")
    if not result:
        print("  för få modellgrupper med båda typerna — ingen slutsats")
    print(f"\ntröskel: {MERGE_THRESHOLD*100:.0f} % skillnad, minst {MIN_GROUPS} grupper,"
          f" {MIN_PER_BUCKET} annonser per bucket och grupp")
    print(f"skrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
