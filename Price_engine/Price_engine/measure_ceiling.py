#!/usr/bin/env python
"""Det teoretiska taket: vad skulle en PERFEKT motor få på benchmarken?

    python measure_ceiling.py

En accuracy-siffra utan tak är obegriplig. 63 % kan vara nära perfekt eller
uselt, och skillnaden avgörs av hur brett facit är och hur mycket marknaden
själv sprider sig.

Räkningen har tre delar:

1. **Marknadens logspridning** mätt inom dubblettgrupper — annonser med
   IDENTISK normaliserad rubrik. Där är produkten densamma per konstruktion,
   så all kvarvarande spridning är brus.

2. **Skattningsfelet.** Även en motor som mäter rätt sak har samplingsfel:
   medianens standardfel i logrummet är ~1,2533 * sigma / sqrt(n). En möbel med
   15 jämförelseannonser kan inte skattas exakt hur bra metoden än är.

3. **Facitbredden.** Ett facit på 300-800 kr rymmer ett fel på +/-33 % i log;
   ett på 2 000-2 500 rymmer +/-11 %. Samma motor träffar det första oftare.

Taket är sannolikheten att en OBIASAD skattning med det samplingsfelet hamnar
inom facit, antaget att facits mitt ÄR marknadens mitt. Det antagandet är
generöst mot facit — där det inte håller (matgruppsfallen) är det verkliga taket
lägre.
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

from price_engine.data_loader import load_listings

log = logging.getLogger("tak")
OUT = Path("type_system/ceiling.json")
MIN_GROUP = 5
#: Medianens asymptotiska standardfel i förhållande till medelvärdets:
#: sqrt(pi/2) = 1,2533. Gäller normalfördelning, vilket log-pris ligger nära.
MEDIAN_SE_FACTOR = 1.2533


def _norm_cdf(x: float) -> float:
    from math import erf, sqrt
    return 0.5 * (1.0 + erf(x / sqrt(2.0)))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_ceiling.py")
    parser.add_argument("--results", type=Path,
                        default=Path("bench5/alla_lagen.csv"))
    parser.add_argument("--mode", default="D")
    parser.add_argument("--sigma", type=float, default=None,
                        help="tvinga sigma, t.ex. 0.638 för modellnamnsgrupperna")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    # --- 1. marknadens logspridning inom dubblettgrupper ------------------
    listings = load_listings()
    frame = listings[listings["price"].gt(0) & listings["name_norm"].notna()]
    sizes = frame.groupby("name_norm").size()
    groups = frame[frame["name_norm"].isin(sizes[sizes >= MIN_GROUP].index)]
    logp = np.log(groups["price"].to_numpy(float))
    keys = groups["name_norm"].to_numpy()
    inner = pd.Series(logp).groupby(keys).transform(lambda s: s - s.mean())
    sigma = float(np.std(inner.to_numpy(), ddof=1))
    log.info("Dubblettgrupper: %d, rader %d, sigma(log) = %.4f",
             groups["name_norm"].nunique(), len(groups), sigma)
    if args.sigma:
        log.info("Sigma tvingad till %.4f (var %.4f)", args.sigma, sigma)
        sigma = args.sigma

    # --- 2 och 3. per möbel: facitbredd mot samplingsfel ------------------
    results = pd.read_csv(args.results)
    part = results[results["mode"] == args.mode].copy()
    rows = []
    for row in part.itertuples():
        low, high = float(row.facit_low), float(row.facit_high)
        if low <= 0 or high <= low:
            continue
        half = np.log(high / low) / 2.0          # halva facitbredden i log
        n = 0 if pd.isna(row.n) else int(row.n)
        # Möbelns EGEN logspridning, härledd ur motorns rapporterade percentiler.
        # low = p30 och high = p60, så för en lognormal fördelning gäller
        #   ln(p60/p30) = (z60 - z30) * sigma = (0,2533 + 0,5244) * sigma
        # Global sigma är fel instrument per möbel: en Ektorp-mängd och en
        # "matbord"-mängd har helt olika inre spridning, och att ge dem samma
        # tak döljer var arbetet finns.
        own = None
        if (not pd.isna(row.low) and not pd.isna(row.high)
                and row.low > 0 and row.high > row.low):
            own = float(np.log(row.high / row.low) / 0.7777)
        if n < 1:
            # Ingen jämförelsemängd alls -> ingen motor kan svara. Taket för
            # den här möbeln är 0, och det ska INTE döljas.
            rows.append({"id": f"{row.bench}#{row.nr}", "möbel": row.möbel,
                         "n": 0, "facitbredd": round(high / low, 2),
                         "tak": 0.0, "orsak": "inget underlag"})
            continue
        se_global = MEDIAN_SE_FACTOR * sigma / np.sqrt(n)
        p_global = 2.0 * _norm_cdf(half / se_global) - 1.0
        se_own = (MEDIAN_SE_FACTOR * own / np.sqrt(n)) if own else None
        p_own = (2.0 * _norm_cdf(half / se_own) - 1.0) if se_own else None
        rows.append({"id": f"{row.bench}#{row.nr}", "möbel": row.möbel, "n": n,
                     "facitbredd": round(high / low, 2),
                     "halvbredd_log": round(float(half), 3),
                     "sigma_egen": round(own, 3) if own else None,
                     "se_log": round(float(se_global), 3),
                     "tak": round(float(p_global), 4),
                     "tak_egen_sigma": round(float(p_own), 4) if p_own else None,
                     "orsak": ""})

    table = pd.DataFrame(rows)
    ceiling = float(table["tak"].mean())
    with_data = table[table["n"] > 0]

    print(f"\nmarknadens logspridning (sigma)      {sigma:.3f}")
    print(f"  motsvarar p75/p25                  "
          f"{np.exp(1.349 * sigma):.2f}x")
    print(f"\nfacitbredd (high/low), median         "
          f"{table['facitbredd'].median():.2f}x")
    print(f"jämförelsemängd (n), median           {with_data['n'].median():.0f}")
    own_col = table["tak_egen_sigma"]
    ceiling_own = float(own_col.fillna(0.0).mean())
    print(f"\n{'':<38}{'global sigma':>14}{'egen sigma':>13}")
    print(f"{'TAK, alla ' + str(len(table)) + ' möbler':<38}"
          f"{ceiling*100:>13.1f} %{ceiling_own*100:>12.1f} %")
    print(f"{'TAK, de ' + str(len(with_data)) + ' med underlag':<38}"
          f"{with_data['tak'].mean()*100:>13.1f} %"
          f"{float(with_data['tak_egen_sigma'].fillna(0).mean())*100:>12.1f} %")

    print(f"\n=== svårast (lägst tak) ===")
    for r in table.nsmallest(8, "tak").itertuples():
        own = ("—" if r.tak_egen_sigma != r.tak_egen_sigma
               else f"{r.tak_egen_sigma*100:5.1f} %")
        print(f"   {r.id:<8}{str(r.möbel)[:24]:<26}n={r.n:<5}"
              f"facit {r.facitbredd:>5.2f}x  tak {r.tak*100:>5.1f} %"
              f"  egen {own}  {r.orsak}")
    print(f"\n=== lättast ===")
    for r in table.nlargest(5, "tak").itertuples():
        own = ("—" if r.tak_egen_sigma != r.tak_egen_sigma
               else f"{r.tak_egen_sigma*100:5.1f} %")
        print(f"   {r.id:<8}{str(r.möbel)[:24]:<26}n={r.n:<5}"
              f"facit {r.facitbredd:>5.2f}x  tak {r.tak*100:>5.1f} %  egen {own}")

    OUT.write_text(json.dumps({
        "sigma_log": round(sigma, 4),
        "p75_p25_ratio": round(float(np.exp(1.349 * sigma)), 3),
        "groups": int(groups["name_norm"].nunique()),
        "rows": int(len(groups)),
        "ceiling_all": round(ceiling, 4),
        "ceiling_all_own_sigma": round(ceiling_own, 4),
        "ceiling_with_data": round(float(with_data["tak"].mean()), 4),
        "median_facit_width": round(float(table["facitbredd"].median()), 3),
        "per_item": rows,
    }, ensure_ascii=False, indent=1))
    print(f"\nskrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
