#!/usr/bin/env python
"""Vad kopplingen gjorde med JÄMFÖRELSEMÄNGDEN — mätt på korpusskala.

    python measure_wiring_purity.py --n 120

Benchmarkerna kan inte användas: specfilerna är rensade, och att återskapa dem
vore inte identiskt med de frysta, vilket gör jämförelsen med tidigare körningar
ogiltig. Det här måttet är dessutom bättre lämpat — flera hundra möbler i stället
för 34, och det mäter det kopplingen faktiskt ändrar.

**Måttet är storleken på jämförelsemängden och prisets förflyttning.** Utan facit
går det inte att säga vilket pris som är rätt. Motorn returnerar inte heller
träffmängden, bara dess storlek, så renheten går inte att räkna utan att
duplicera hela kandidatkedjan — och en duplicerad kedja mäter sig själv, inte
motorn.

Det som går att mäta ärligt: hur mycket mängden krymper, hur ofta priset rör sig,
och hur långt. Att priset rör sig är ett faktum; att det rör sig ÅT RÄTT HÅLL kan
den här mätningen inte avgöra.
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

from price_engine import config
from price_engine.data_loader import load_listings
from price_engine.pricing import price_query
from type_system import model_tokens

log = logging.getLogger("renhet")
OUT = Path("type_system/wiring_purity.json")
SEED = 20260811


def build(listings: pd.DataFrame, n: int) -> pd.DataFrame:
    """Annonser med entydig typ och ett modellord att söka på."""
    frame = listings[listings["derived_type"].notna()].copy()
    known = model_tokens.distinctive(frame["name_norm"], 30, 20_000)
    frame["tokens"] = [model_tokens.of(name, known) for name in frame["name_norm"]]
    frame = frame[frame["tokens"].map(len) > 0]
    # Balanserat över typer, annars mäter man vilken typ som är vanligast.
    picked = []
    for kind, group in frame.groupby("derived_type", observed=True):
        take = min(len(group), max(4, n // frame["derived_type"].nunique()))
        picked.append(group.sample(take, random_state=SEED))
    return pd.concat(picked, ignore_index=True).sample(
        frac=1.0, random_state=SEED).head(n)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_wiring_purity.py")
    parser.add_argument("--n", type=int, default=120)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    test = build(listings, args.n)
    log.info("Testmängd: %d annonser över %d typer",
             len(test), test["derived_type"].nunique())

    records = []
    for done, row in enumerate(test.itertuples(), start=1):
        if done % 25 == 0:
            log.info("%d / %d", done, len(test))
        query = row.tokens[0]
        truth = str(row.derived_type)

        config.TYPE_SYSTEM_DRIVES_SEARCH = False
        off = price_query(listings, name=query, price_kind="asking")
        config.TYPE_SYSTEM_DRIVES_SEARCH = True
        on = price_query(listings, name=query, price_kind="asking")

        records.append({
            "query": query, "truth": truth,
            "n_off": off.get("matchCount") or 0, "n_on": on.get("matchCount") or 0,
            "default_off": off.get("default"), "default_on": on.get("default"),
            "method_off": off.get("variantMethod"), "method_on": on.get("variantMethod"),
            "variant_on": str(on.get("query", {}).get("variant")),
        })

    data = pd.DataFrame(records)
    data.to_csv("type_system/wiring_purity.csv", index=False)

    both = data[(data["n_off"] > 0) & (data["n_on"] > 0)].copy()
    both["moved"] = both["default_off"] != both["default_on"]
    with np.errstate(divide="ignore", invalid="ignore"):
        both["shift"] = pd.to_numeric(both["default_on"], errors="coerce") / \
            pd.to_numeric(both["default_off"], errors="coerce") - 1

    report = {
        "n": int(len(data)),
        "n_both_answered": int(len(both)),
        "median_n_off": int(both["n_off"].median()),
        "median_n_on": int(both["n_on"].median()),
        "share_moved": round(float(both["moved"].mean()), 3),
        "median_abs_shift": round(float(both.loc[both["moved"], "shift"].abs().median()), 4)
        if both["moved"].any() else 0.0,
        "filtered_off": int((data["method_off"] == "filtered").sum()),
        "filtered_on": int((data["method_on"] == "filtered").sum()),
    }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    print(f"\nn = {report['n']}   båda svarade: {report['n_both_answered']}")
    print(f"\n{'':<28}{'AV':>10}{'PÅ':>10}")
    print(f"{'median jämförelsemängd':<28}{report['median_n_off']:>10,}"
          f"{report['median_n_on']:>10,}")
    print(f"{'filtrerade faktiskt':<28}{report['filtered_off']:>10}"
          f"{report['filtered_on']:>10}")
    print(f"\npriset rörde sig i {report['share_moved']*100:.0f} % av fallen")
    print(f"medianförflyttning när det rörde sig: "
          f"{report['median_abs_shift']*100:.1f} %")
    print("\nOBS: förflyttning är inte förbättring. Utan facit kan den här")
    print("mätningen inte säga vilket pris som är rätt — bara att det ändrades.")
    print(f"\nskrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
