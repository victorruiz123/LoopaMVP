#!/usr/bin/env python
"""Beslutsunderlag: vad ska `default` lova — p40 eller p50?

    python measure_default_percentile.py

**Måttkonflikten.** p40 är kalibrerat mot vad som SÄLJER: bryggmätningen landade
på p34 och omlistningsstudien visar att prissänkningarna passerar 50 % redan i
decilen p40-50. Benchmarkens facit är däremot satt som rimliga UTROPSintervall —
vad en säljare kan begära. Storheterna skiljer sig systematiskt, ungefär
betalt ~ p34 av begärt.

Det förklarar två mönster i utfallet: de måttliga minusmissarna (-10 till -17 %)
och att ALLA katastrofmissar är negativa. Motorn svarar på en annan fråga än
facit ställer.

Mätningen görs i EN körning, inte två. `percentileGrid` i svaret innehåller
p05-p95 räknade med motorns egen kvantilfunktion på exakt den jämförelsemängd
frågan gav, så båda tolkningarna kan läsas ur samma svar. Två körningar hade
riskerat att variera något annat.

RÖR INGET i produktionen. Skriptet läser och räknar.
"""

from __future__ import annotations

import argparse
import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import pandas as pd

log = logging.getLogger("percentil")
OUT = Path("type_system/default_percentile.json")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_default_percentile.py")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")

    from evaluate_examples import search_key
    from price_engine.condition import build_bands
    from price_engine.data_loader import load_listings
    from price_engine.pricing import price_query

    listings = load_listings()
    bands = build_bands(listings)

    rows = []
    for tag in ("11", "b1", "b2"):
        path = Path(f"benchmark/items_{tag}.json")
        if not path.is_file():
            continue
        for item in json.loads(path.read_text()):
            model = item.get("model")
            kind = str(item.get("variant") or item.get("category") or "").strip()
            name = search_key(item)
            full = " ".join(p for p in (model or "", kind) if p).strip() or name
            answer = price_query(listings, name=name, brand=item.get("brand"),
                                 attribute_text=full, multipliers=bands,
                                 image_rerank=False)
            grid = answer.get("percentileGrid") or {}
            low, high = item["facit_low"], item["facit_high"]
            row = {
                "id": f"{tag}#{item['nr']}",
                "mobel": item.get("label") or " ".join(
                    p for p in (item.get("brand"), model) if p) or name,
                "facit_low": low, "facit_high": high,
                "n": answer.get("matchCount"),
                "p40": answer.get("default"),
                "p50": grid.get("50"),
                "disputed": bool(item.get("disputed")),
            }
            for key in ("p40", "p50"):
                value = row[key]
                row[f"traff_{key}"] = bool(value is not None
                                           and low <= value <= high)
                row[f"avv_{key}"] = (
                    None if value is None else
                    0.0 if low <= value <= high else
                    round((value - high) / high, 3) if value > high
                    else round((value - low) / low, 3))
            rows.append(row)

    table = pd.DataFrame(rows)
    answered = table[table["p40"].notna()]

    print(f"\n{'tolkning':<34}{'inom facit':>13}{'för lågt':>10}{'för högt':>10}"
          f"{'katastrofer':>13}")
    for key, label in (("p40", "dagens: default = p40"),
                       ("p50", "alternativet: default = p50")):
        hit = table[f"traff_{key}"].mean()
        low_n = int((answered[f"avv_{key}"] < 0).sum())
        high_n = int((answered[f"avv_{key}"] > 0).sum())
        cat = int((answered[f"avv_{key}"].abs() > 0.50).sum())
        print(f"{label:<34}{hit*100:>11.1f} % {low_n:>9}{high_n:>10}"
              f"{cat:>10}/{len(table)}")

    print(f"\n=== möbler där tolkningen avgör träffen ===")
    flipped = table[table["traff_p40"] != table["traff_p50"]]
    print(f"{'id':<8}{'möbel':<26}{'facit':>14}{'p40':>9}{'p50':>9}  vinner")
    for row in flipped.itertuples():
        winner = "p50" if row.traff_p50 else "p40"
        p50 = "—" if row.p50 != row.p50 else f"{row.p50:,.0f}"
        p40 = "—" if row.p40 != row.p40 else f"{row.p40:,.0f}"
        print(f"{row.id:<8}{str(row.mobel)[:25]:<26}"
              f"{row.facit_low:>6,}-{row.facit_high:<7,}{p40:>9}{p50:>9}  {winner}")

    # Hur mycket högre ligger p50? Det är storleken på måttkonflikten.
    both = answered[answered["p50"].notna()]
    lift = (both["p50"] / both["p40"]).median()
    print(f"\np50 / p40, median över de {len(both)} besvarade: {lift:.3f}")
    print(f"   alltså {(lift-1)*100:.1f} % högre startläge")

    payload = {
        "traff_p40": round(float(table["traff_p40"].mean()), 4),
        "traff_p50": round(float(table["traff_p50"].mean()), 4),
        "p50_over_p40_median": round(float(lift), 4),
        "per_mobel": rows,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=1))
    print(f"\nskrivet till {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
