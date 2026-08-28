#!/usr/bin/env python
"""Mäter om typdistinktionerna är prisrelevanta — datan avgör granulariteten.

    python measure_price_relevance.py

Frågan: ska hörnsoffa, divansoffa och schäslong vara tre attributvärden eller
ett? Språkkänsla räcker inte. Om medianpriset inom samma modell skiljer < 10 %
är distinktionen inbillad och ska slås ihop; annars behålls den.

**Metoden är parvis inom grupp**, aldrig globala medianer per nivå. Ett globalt
snitt jämför Ikea-soffor med Svenskt Tenn-soffor och mäter märkesmix, inte
attributet. Här jämförs varje bucket mot varje annan *inom samma modell och
samma priskälla*, och medianen av kvoterna rapporteras.

Grupperingsnyckeln är ett **modellord** — ett distinktivt, icke-generiskt token i
annonsnamnet. Märkeskolumnen duger inte: 97 % av soffannonserna saknar märke.
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import re
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

from price_engine import config
from price_engine.data_loader import load_listings
from type_system import lexicon as lex
from type_system.attributes import derive_type
from type_system.text_layer import extract

log = logging.getLogger("prisrelevans")
OUT = Path("type_system/price_relevance.json")

MIN_PER_BUCKET = 5      # per bucket och modellgrupp
MIN_GROUPS = 8          # minsta antal modellgrupper för ett rapporterbart tal
MERGE_THRESHOLD = 0.10  # < 10 % skillnad -> slå ihop, enligt uppdraget

_TOKEN = re.compile(r"[0-9a-z]+(?:-[0-9a-z]+)*")

#: Vidare än bucketern med flit — får släppa igenom för mycket, aldrig för lite.
PREFILTER = {
    "soffa": r"soff|sofa|divan|schaslong|shaslong|chaise|chaselong|schaslang",
    "forvaring": r"byra|hylla|skank|sideboard|vitrin|kommod|buffe|dragkista|skap|garderob",
    "bord": r"bord|matgrupp|matsalsgrupp|sekretar",
}

#: Ord som aldrig är modellnamn: attributord, generiska ord, material, färg.
_NOT_MODEL = (
    set(config.GENERIC_TOKENS)
    | {w for words in lex.BASE_WORDS.values() for w in words}
    | set(lex.CHAISE_WORDS) | set(lex.CORNER_WORDS) | set(lex.CONVERTIBLE_WORDS)
    | {w for words in lex.STORAGE_KINDS.values() for w in words}
    | {w for words in lex.TABLE_SUBS.values() for w in words}
    | set(lex.CONVERTIBLE_EXCLUDE) | set(lex.CORNER_NOT_SOFA)
)


def sofa_bucket(text: str):
    """Håller chaise och corner ÅTSKILDA — det är hypotesen som prövas."""
    a = extract(text, prenormalized=True)
    if a.get("base") != "soffa":
        return None
    if a.get("convertible"):
        return "baddsoffa"
    corner, chaise = a.get("corner"), a.get("chaise")
    if corner and chaise:
        return "horn+divan"
    if corner:
        return "hornsoffa"
    if chaise:
        return "divan/schaslong"
    return "rak soffa"


def storage_bucket(text: str):
    a = extract(text, prenormalized=True)
    if a.get("base") != "forvaring":
        return None
    return a.get("storage_kind")


def table_bucket(text: str):
    a = extract(text, prenormalized=True)
    if a.get("base") != "bord":
        return None
    return derive_type(a)


def model_tokens(names: pd.Series, lo: int, hi: int) -> set:
    """Distinktiva tokens: tillräckligt vanliga att gruppera på, inte generiska."""
    counter = collections.Counter()
    for name in names:
        counter.update(set(_TOKEN.findall(name)))
    return {
        token for token, count in counter.items()
        if lo <= count <= hi and len(token) >= 3 and token not in _NOT_MODEL
        and not token.isdigit()
    }


def pairwise(frame: pd.DataFrame, buckets: list) -> dict:
    """Median av kvoten mellan varje bucketpar, beräknad inom modellgrupp.

    Varje grupp bidrar med högst en kvot per par, så en modell med tusentals
    annonser väger inte tyngre än en med tjugo.
    """
    ratios = collections.defaultdict(list)
    for _, group in frame.groupby(["model_token", "price_kind"], observed=True):
        medians = {
            bucket: float(part["price"].median())
            for bucket, part in group.groupby("bucket", observed=True)
            if len(part) >= MIN_PER_BUCKET
        }
        for i, a in enumerate(buckets):
            for b in buckets[i + 1:]:
                if a in medians and b in medians and medians[b] > 0:
                    ratios[(a, b)].append(medians[a] / medians[b])
    out = {}
    for (a, b), values in sorted(ratios.items()):
        if len(values) < MIN_GROUPS:
            continue
        arr = np.array(values)
        median = float(np.median(arr))
        boot = [float(np.median(np.random.default_rng(s).choice(arr, len(arr))))
                for s in range(400)]
        out[f"{a} / {b}"] = {
            "median_ratio": round(median, 3),
            "diff_pct": round(abs(median - 1.0) * 100, 1),
            "groups": len(values),
            "ci95": [round(float(np.percentile(boot, 2.5)), 3),
                     round(float(np.percentile(boot, 97.5)), 3)],
            "merge": bool(abs(median - 1.0) < MERGE_THRESHOLD),
        }
    return out


def study(listings: pd.DataFrame, name: str, bucketer, buckets: list,
          lo: int, hi: int, prefilter: str = "") -> dict:
    """Grovfiltrerar vektoriserat innan L0 körs per rad.

    `extract` kostar ~80 µs. Över 1,5 miljoner rader är det två minuter per
    studie; över de rader som ens kan tillhöra familjen är det sekunder. Filtret
    är avsiktligt vidare än bucketern — det får släppa igenom för mycket, aldrig
    för lite.
    """
    log.info("--- %s ---", name)
    frame = listings[["search_blob", "name_norm", "price", "price_kind"]]
    if prefilter:
        frame = frame[frame["search_blob"].str.contains(prefilter, na=False, regex=True)]
        log.info("%s: %d rader efter grovfilter", name, len(frame))
    frame = frame.copy()
    frame["bucket"] = [bucketer(t) for t in frame["search_blob"]]
    frame = frame[frame["bucket"].notna() & frame["price"].gt(0)]
    log.info("%s: %d annonser i buckets", name, len(frame))
    if not len(frame):
        return {}

    tokens = model_tokens(frame["name_norm"], lo, hi)
    log.info("%s: %d modellord", name, len(tokens))
    rows = []
    for blob_name, bucket, price, kind in zip(
            frame["name_norm"], frame["bucket"], frame["price"], frame["price_kind"]):
        for token in _TOKEN.findall(blob_name):
            if token in tokens:
                rows.append((token, bucket, price, kind))
    tagged = pd.DataFrame(rows, columns=["model_token", "bucket", "price", "price_kind"])
    log.info("%s: %d (annons, modellord)-par", name, len(tagged))

    return {
        "n_listings": int(len(frame)),
        "n_model_tokens": int(len(tokens)),
        "bucket_counts": {str(k): int(v) for k, v in
                          frame["bucket"].value_counts().items()},
        "pairwise": pairwise(tagged, buckets),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_price_relevance.py")
    parser.add_argument("--min-token", type=int, default=20)
    parser.add_argument("--max-token", type=int, default=20000)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    report = {
        "soffa": study(listings, "soffa", sofa_bucket,
                       ["baddsoffa", "hornsoffa", "divan/schaslong", "horn+divan",
                        "rak soffa"], args.min_token, args.max_token,
                       PREFILTER["soffa"]),
        "forvaring": study(listings, "förvaring", storage_bucket,
                           ["byra", "hylla", "skank", "vitrin"],
                           args.min_token, args.max_token, PREFILTER["forvaring"]),
        "bord": study(listings, "bord", table_bucket,
                      ["matgrupp", "matbord", "soffbord", "sidobord", "skrivbord"],
                      args.min_token, args.max_token, PREFILTER["bord"]),
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    for family, block in report.items():
        if not block:
            continue
        print(f"\n===== {family} =====  {block['n_listings']:,} annonser, "
              f"{block['n_model_tokens']:,} modellord")
        print("  buckets:", block["bucket_counts"])
        print(f"  {'par':<34}{'kvot':>7}{'skillnad':>10}{'grupper':>9}{'95% KI':>18}  beslut")
        for pair, r in sorted(block["pairwise"].items(),
                              key=lambda kv: -kv[1]["diff_pct"]):
            ci = f"[{r['ci95'][0]:.2f}, {r['ci95'][1]:.2f}]"
            verdict = "SLÅ IHOP" if r["merge"] else "behåll"
            print(f"  {pair:<34}{r['median_ratio']:>7.2f}{r['diff_pct']:>9.1f}%"
                  f"{r['groups']:>9}{ci:>18}  {verdict}")
    print(f"\nskrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
