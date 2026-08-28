#!/usr/bin/env python
"""Sammanställer BENCHMARK_RAPPORT.md ur de sex körningarna.

    python build_benchmark_report.py

Lägena är {celler av, celler på} x {utan bild, med bild}:

    A  celler av,  utan bild      C  celler på,  utan bild
    B  celler av,  med bild       D  celler på,  med bild

A mot C isolerar cellernas effekt, C mot D bildens effekt i det nya systemet.

**Överlapp redovisas aldrig utan intervallbredd bredvid.** Ett intervall som
sträcker sig från 500 till 50 000 överlappar varje facit och har ändå inte sagt
någonting. Bredden mäts som (high - low) / default.
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

log = logging.getLogger("rapport")

BENCHES = (("11", "De 11 första"), ("b1", "Benchmark 1"), ("b2", "Benchmark 2"))
MODES = (("A", "AB", "kärnnamn"), ("B", "AB", "kärnnamn + bild"),
         ("C", "CD", "kärnnamn"), ("D", "CD", "kärnnamn + bild"))


def load(root: Path) -> pd.DataFrame:
    frames = []
    for tag, title in BENCHES:
        for letter, suffix, mode in MODES:
            path = root / f"{tag}_{suffix}" / "resultat.csv"
            if not path.is_file():
                log.warning("saknas: %s", path)
                continue
            part = pd.read_csv(path)
            part = part[part["läge"] == mode].copy()
            part["bench"] = tag
            part["bench_namn"] = title
            part["mode"] = letter
            frames.append(part)
    if not frames:
        raise SystemExit("inga resultat att läsa — kör evaluate_examples.py först")
    return pd.concat(frames, ignore_index=True)


def width(frame: pd.DataFrame) -> float:
    """Medianintervallbredd som andel av default."""
    ok = frame[frame["default"].notna() & frame["default"].gt(0)]
    if ok.empty:
        return float("nan")
    return float(((ok["high"] - ok["low"]) / ok["default"]).median())


def summarise(frame: pd.DataFrame) -> dict:
    answered = frame[frame["default"].notna()]
    return {
        "n": len(frame),
        "svar": len(answered),
        "utan_svar": len(frame) - len(answered),
        "default_inom": float(frame["träff_default"].mean()) if len(frame) else float("nan"),
        "overlapp": float(frame["träff_intervall"].mean()) if len(frame) else float("nan"),
        "bredd": width(frame),
        "avvikelse": (float(answered.loc[answered["avvikelse"] != 0, "avvikelse"]
                            .abs().median())
                      if (answered["avvikelse"] != 0).any() else 0.0),
    }


def pct(value) -> str:
    return "—" if value != value else f"{value*100:.0f} %"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="build_benchmark_report.py")
    parser.add_argument("--root", type=Path, default=Path("bench4"))
    parser.add_argument("--out", type=Path, default=Path("BENCHMARK_RAPPORT.md"))
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    frame = load(args.root)
    floor = json.loads(Path("type_system/noise_floor.json").read_text())
    prints = {}
    for tag, _ in BENCHES:
        for suffix in ("AB", "CD"):
            path = args.root / f"{tag}_{suffix}" / "sammanfattning.json"
            if path.is_file():
                prints[f"{tag}_{suffix}"] = json.loads(path.read_text()).get(
                    "spec_fingerprint")

    lines = []
    add = lines.append
    add("# Benchmarkrapport — priscellerna inkopplade\n")
    add(f"Körd {pd.Timestamp.today():%Y-%m-%d} på {frame['nr'].count() // 4} "
        f"möbler i fyra lägen. Fixerat frö 20260816.\n")
    add("| läge | celler | bild |")
    add("|---|---|---|")
    add("| A | av | av |")
    add("| B | av | på |")
    add("| C | på | av |")
    add("| D | på | på |")
    add("")

    # --- huvudtabell ------------------------------------------------------
    add("## Huvudtabell\n")
    add("Överlapp står aldrig ensamt — ett brett intervall träffar allt.\n")
    add("| benchmark | läge | **default inom facit** | överlapp | "
        "intervallbredd | utan svar |")
    add("|---|---|---|---|---|---|")
    for tag, title in BENCHES:
        for letter, _, _ in MODES:
            part = frame[(frame["bench"] == tag) & (frame["mode"] == letter)]
            if part.empty:
                continue
            s = summarise(part)
            add(f"| {title} | {letter} | **{pct(s['default_inom'])}** "
                f"({int(s['default_inom']*s['n']+0.5)}/{s['n']}) | "
                f"{pct(s['overlapp'])} | {pct(s['bredd'])} | {s['utan_svar']} |")
    add("")
    add("### Alla 34 tillsammans\n")
    add("| läge | **default inom facit** | överlapp | intervallbredd | "
        "median avvikelse när utanför |")
    add("|---|---|---|---|---|")
    for letter, _, _ in MODES:
        part = frame[frame["mode"] == letter]
        if part.empty:
            continue
        s = summarise(part)
        add(f"| {letter} | **{pct(s['default_inom'])}** "
            f"({int(s['default_inom']*s['n']+0.5)}/{s['n']}) | "
            f"{pct(s['overlapp'])} | {pct(s['bredd'])} | {pct(s['avvikelse'])} |")
    add("")

    # --- brusgolvet -------------------------------------------------------
    add("## Brusgolvet\n")
    add(f"Mätt på {floor['grupper']:,} dubblettgrupper "
        f"({floor['rader']:,} annonser med identisk normaliserad rubrik). "
        f"Inom en sådan grupp är produkten densamma per konstruktion, så all "
        f"prisspridning är marknadens brus.\n")
    add(f"- **spridning p75–p25: {floor['spridning_p75_p25_median']*100:.0f} %** "
        f"av medianen")
    add(f"- en enskild annons ligger inom sin egen grupps p30–p60 i bara "
        f"**{floor['andel_inom_egen_p30_p60']*100:.0f} %** av fallen")
    add("")
    add("Två säljare med identisk möbel och identisk rubrik sätter alltså priser "
        "som skiljer sig med runt 70 %. Ingen prismotor kan komma under det, och "
        "accuracy ska läsas mot det golvet — inte mot 100 %.\n")

    # --- per felklass ------------------------------------------------------
    add("## Per felklass\n")
    add("| felklass | fall | A | B | C | D |")
    add("|---|---|---|---|---|---|")
    for klass in sorted(frame["felklass"].dropna().unique()):
        part = frame[frame["felklass"] == klass]
        cells = []
        for letter, _, _ in MODES:
            sub = part[part["mode"] == letter]
            cells.append(pct(sub["träff_default"].mean()) if len(sub) else "—")
        add(f"| {klass} | {len(part)//4} | " + " | ".join(cells) + " |")
    add("")

    # --- per möbel ---------------------------------------------------------
    add("## Per möbel\n")
    add("Läge D (celler på, med bild). Avvikelsen är avståndet till närmaste "
        "facitkant.\n")
    add("| # | möbel | facit | low–default–high | n | typkälla | cellnyckel | "
        "träff | avvikelse |")
    add("|---|---|---|---|---|---|---|---|---|")
    d = frame[frame["mode"] == "D"].sort_values(["bench", "nr"])
    for row in d.itertuples():
        interval = ("—" if row.default != row.default
                    else f"{row.low:,.0f}–**{row.default:,.0f}**–{row.high:,.0f}")
        dev = ("✓" if row.träff_default
               else ("—" if row.avvikelse != row.avvikelse
                     else f"{row.avvikelse*100:+.0f} %"))
        key = str(getattr(row, "cellKey", "") or "")[:34]
        add(f"| {row.bench}#{row.nr} | {str(row.möbel)[:26]} | "
            f"{row.facit_low:,}–{row.facit_high:,} | {interval} | {row.n:,} | "
            f"{str(row.variantSource)[:22]} | `{key}` | "
            f"{'✓' if row.träff_default else '✗'} | {dev} |")
    add("")

    # --- A mot C, per möbel -------------------------------------------------
    add("## Vad cellerna gjorde, möbel för möbel\n")
    pivot = frame.pivot_table(index=["bench", "nr", "möbel"], columns="mode",
                              values="default", aggfunc="first")
    moved = pivot[(pivot.get("A") != pivot.get("C"))].dropna(how="all")
    add(f"Cellerna ändrade priset för **{len(moved)} av {len(pivot)}** möbler.\n")
    if len(moved):
        add("| möbel | A (celler av) | C (celler på) | ändring |")
        add("|---|---|---|---|")
        for (bench, nr, name), row in moved.iterrows():
            a, c = row.get("A"), row.get("C")
            shift = ("—" if not a or a != a or c != c
                     else f"{(c/a-1)*100:+.0f} %")
            add(f"| {bench}#{nr} {str(name)[:24]} | "
                f"{'—' if a != a else f'{a:,.0f}'} | "
                f"{'—' if c != c else f'{c:,.0f}'} | {shift} |")
    add("")

    add("## Fingeravtryck\n")
    for key, value in sorted(prints.items()):
        add(f"- `{key}` — `{value}`")
    add("")

    args.out.write_text("\n".join(lines))
    print(f"skrivet till {args.out}  ({len(lines)} rader)")
    for letter, _, _ in MODES:
        part = frame[frame["mode"] == letter]
        if len(part):
            s = summarise(part)
            print(f"  läge {letter}: default inom facit {pct(s['default_inom'])}"
                  f"   överlapp {pct(s['overlapp'])}   bredd {pct(s['bredd'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
