#!/usr/bin/env python
"""Skuggloggen: vad skulle skadeavdraget ha gjort?

    python report_unmapped_damages.py            # omappade skador
    python report_unmapped_damages.py --shadow   # tak och deduplicering

Taxonomin ska växa ur verklig användning, inte ur en gissning om vad som brukar
gå sönder på möbler. Varje skada systemet inte kunde värdera loggas, och den här
rapporten grupperar loggen: den mest återkommande omappade skadan är den
kategori som ger mest när den mäts och läggs i tabellen.
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
from pathlib import Path

from price_engine import config

log = logging.getLogger("omappade")


def _shadow(path: Path) -> int:
    """Hur ofta utlöser taket och dedupliceringen?

    Båda är mekanismer som kan platta ut systemet: taket gör alla svårt skadade
    möbler lika mycket värda, dedupliceringen gör alla lätt skadade det. Att
    veta hur ofta de biter är förutsättningen för att våga slå på flaggan.
    """
    if not path.is_file():
        print(f"Ingen skugglogg ännu: {path}")
        print("Loggen fylls när DAMAGE_PRICING är på och skador skickas in.")
        return 0

    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    if not rows:
        print("Skuggloggen är tom.")
        return 0

    total = len(rows)
    capped = sum(1 for r in rows if r.get("capped"))
    collapsed = sum(1 for r in rows if (r.get("collapsed") or 0) > 0)
    escalated = sum(1 for r in rows if r.get("escalated"))
    needed_model = sum(r.get("needs_model") or 0 for r in rows)
    items_in = sum(r.get("items_in") or 0 for r in rows)
    items_out = sum(r.get("items_after_dedup") or 0 for r in rows)

    print(f"\n{total:,} prissättningar med skador i {path}\n")
    print(f"{'mått':<40}{'antal':>9}{'andel':>9}")
    print(f"{'taket löste ut':<40}{capped:>9,}{capped/total*100:>8.1f}%")
    print(f"{'dedupliceringen slog ihop poster':<40}{collapsed:>9,}"
          f"{collapsed/total*100:>8.1f}%")
    print(f"{'gradhöjning på antal':<40}{escalated:>9,}"
          f"{escalated/total*100:>8.1f}%")
    print(f"\nskadeposter in:  {items_in:,}")
    print(f"efter deduplicering: {items_out:,}"
          f"  ({(1 - items_out / max(items_in, 1)) * 100:.1f} % bort)")
    print(f"krävde modellanrop: {needed_model:,}"
          f"  ({needed_model / max(items_in, 1) * 100:.1f} % av posterna)")

    deductions = sorted(r["total_deduction"] for r in rows
                        if r.get("total_deduction") is not None)
    if deductions:
        middle = deductions[len(deductions) // 2]
        print(f"\navdrag: median {middle*100:.1f} %"
              f"   max {deductions[-1]*100:.1f} %"
              f"   min {deductions[0]*100:.1f} %")

    counts = collections.Counter()
    for row in rows:
        for category in row.get("categories") or []:
            counts[category or "unmapped"] += 1
    print(f"\n{'kategori':<24}{'förekomster':>12}")
    for category, count in counts.most_common(12):
        print(f"{str(category):<24}{count:>12,}")

    if capped / total > 0.20:
        print(f"\nVARNING: taket löser ut i {capped/total*100:.0f} % av fallen. "
              f"Då är det normalfallet, inte ett skyddsnät — och alla svårt "
              f"skadade möbler får samma pris.")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="report_unmapped_damages.py")
    parser.add_argument("--log", type=Path, default=config.UNMAPPED_DAMAGE_LOG)
    parser.add_argument("--top", type=int, default=20)
    parser.add_argument("--shadow", action="store_true",
                        help="rapportera tak och deduplicering i stället")
    parser.add_argument("--shadow-log", type=Path,
                        default=config.DAMAGE_SHADOW_LOG)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if args.shadow:
        return _shadow(args.shadow_log)

    if not args.log.is_file():
        print(f"Ingen logg ännu: {args.log}")
        print("Loggen fylls när DAMAGE_PRICING är på och en skada inte kunde "
              "mappas mot tabellen.")
        return 0

    rows = []
    for line in args.log.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    if not rows:
        print("Loggen är tom.")
        return 0

    counts = collections.Counter(
        (r.get("description") or "?").strip().lower() for r in rows)
    costs = collections.defaultdict(list)
    types = collections.defaultdict(collections.Counter)
    for row in rows:
        key = (row.get("description") or "?").strip().lower()
        if row.get("repair_cost_sek"):
            costs[key].append(float(row["repair_cost_sek"]))
        if row.get("furniture_type"):
            types[key][row["furniture_type"]] += 1

    print(f"\n{len(rows):,} omappade skador i {args.log}\n")
    print(f"{'#':>4}  {'beskrivning':<38}{'antal':>7}{'median kr':>11}"
          f"  vanligaste möbeltyp")
    for index, (key, count) in enumerate(counts.most_common(args.top), 1):
        median = ""
        if costs[key]:
            values = sorted(costs[key])
            median = f"{values[len(values) // 2]:,.0f}"
        kind = types[key].most_common(1)[0][0] if types[key] else "—"
        print(f"{index:>4}  {key[:37]:<38}{count:>7}{median:>11}  {kind}")

    print(f"\nDe översta raderna är prioriteringsordningen för nästa "
          f"utbyggnad av config/damage_deductions.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
