#!/usr/bin/env python
"""Vilken percentil ska `default` ligga på? Svep över alla 34 benchmarkfallen.

    python measure_percentile_sweep.py

`default` ligger i dag på ~p40, och den punkten valdes av två oberoende
mätningar: bryggmätningen landade på p34 och omlistningsstudien visade att
prissänkningarna passerar 50 % redan i decilen p40-50. **Ingen av dem mätte mot
det här facitet.**

Frågan här är en annan: vilken percentil av jämförelsemängden hamnar oftast inom
DITT godkända prisintervall?

**Två saker gör svaret mindre självklart än det ser ut:**

* Percentilen är en enda parameter anpassad mot 34 punkter. Svepet redovisas
  därför både rakt och med **leave-one-out**: percentilen väljs på 33 möbler och
  prövas på den 34:e. Skillnaden mellan de två talen ÄR överanpassningen.
* En möbel kan vara omöjlig oavsett percentil — ligger hela fördelningen under
  facit finns ingen punkt som träffar. De redovisas separat, för de sätter taket
  för vad någon percentil kan uppnå.

Percentilerna hämtas ur motorns eget `percentileGrid`, som använder samma
kvantilfunktion som prissättningen. Ett eget np.percentile hade mätt något annat.
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

from price_engine.data_loader import load_listings
from price_engine.pricing import price_query
from price_engine.vectors import load_vectors

log = logging.getLogger("percentil")
SCRATCH = Path("/private/tmp/claude-501/-Users-test-Price-engine-Price-engine/"
               "6e822209-bd34-4986-b32b-5f8ba2e1c7c2/scratchpad")
BENCHMARKS = (("11 första", "r11"), ("benchmark 1", "rb1"), ("benchmark 2", "rb2"))
OUT = Path("type_system/percentile_sweep.json")
GRID = list(range(5, 96, 5))


def collect(listings, store) -> pd.DataFrame:
    """Kör motorn en gång per möbel och plockar ut prisrutnätet."""
    from evaluate_examples import core_name
    from price_engine import vision as vision_mod
    from PIL import Image

    rows = []
    for label, tag in BENCHMARKS:
        items = json.loads((SCRATCH / f"{tag}_items.json").read_text())
        images = json.loads((SCRATCH / f"{tag}_images.json").read_text())
        for item in items:
            model = item.get("model") or ""
            kind = str(item.get("variant") or item.get("category") or "").strip()
            name = core_name(model) if item.get("brand") else model
            full = " ".join(p for p in (model, kind) if p).strip()

            image = None
            paths = images.get(str(item["nr"])) or []
            if paths and Path(paths[0]).is_file():
                image = Path(paths[0]).read_bytes()

            payload = price_query(
                listings, name=name, brand=item.get("brand") or None,
                price_kind="asking", image=image, vectors=store,
                attribute_text=full or name, image_rerank=False,
                classifier=None,
            )
            grid = payload.get("percentileGrid")
            rows.append({
                "benchmark": label, "nr": item["nr"],
                "möbel": f"{item.get('brand') or ''} {model}".strip(),
                "facit_low": item["facit_low"], "facit_high": item["facit_high"],
                "n": payload.get("matchCount") or 0,
                "default_nu": payload.get("default"),
                **{f"p{p}": (grid or {}).get(str(p)) for p in GRID},
            })
            log.info("%-30s n=%-5s default=%s", rows[-1]["möbel"][:30],
                     rows[-1]["n"], rows[-1]["default_nu"])
    return pd.DataFrame(rows)


def hits(data: pd.DataFrame, p: int) -> pd.Series:
    col = pd.to_numeric(data[f"p{p}"], errors="coerce")
    return (col >= data["facit_low"]) & (col <= data["facit_high"])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_percentile_sweep.py")
    parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    data = collect(load_listings(), load_vectors())
    answered = data[data["n"] > 0].copy()
    log.info("Möbler med svar: %d av %d", len(answered), len(data))

    # --- per möbel: vilka percentiler träffar? ---------------------------
    print(f"\n{'möbel':<28}{'facit':>14}{'n':>6}  percentiler som träffar")
    impossible = []
    for _, r in answered.iterrows():
        ok = [p for p in GRID
              if r[f"p{p}"] is not None and not pd.isna(r[f"p{p}"])
              and r["facit_low"] <= r[f"p{p}"] <= r["facit_high"]]
        facit = f"{r['facit_low']:.0f}-{r['facit_high']:.0f}"
        if not ok:
            impossible.append(r["möbel"])
            span = f"p5={r['p5']:.0f} p95={r['p95']:.0f}"
            print(f"{str(r['möbel'])[:27]:<28}{facit:>14}{r['n']:>6}  INGEN ({span})")
        else:
            print(f"{str(r['möbel'])[:27]:<28}{facit:>14}{r['n']:>6}  "
                  f"p{min(ok)}-p{max(ok)}  ({len(ok)} av {len(GRID)})")

    # --- globalt svep ----------------------------------------------------
    print(f"\n{'percentil':<12}{'träffar':>9}{'andel':>9}")
    scores = {}
    for p in GRID:
        h = hits(answered, p)
        scores[p] = float(h.mean())
        star = "  <- nuvarande ~p40" if p == 40 else ""
        print(f"p{p:<11}{int(h.sum()):>9}{h.mean()*100:>8.1f}%{star}")
    best = max(scores, key=scores.get)
    print(f"\nbäst rakt: p{best} med {scores[best]*100:.1f} % "
          f"({int(hits(answered, best).sum())} av {len(answered)})")

    # --- leave-one-out ---------------------------------------------------
    # Percentilen väljs på 33 möbler och prövas på den 34:e. Skillnaden mot
    # talet ovan ÄR överanpassningen, inte en teoretisk risk.
    loo_hits, loo_choice = [], []
    for i in answered.index:
        rest = answered.drop(index=i)
        pick = max(GRID, key=lambda p: hits(rest, p).mean())
        loo_choice.append(pick)
        loo_hits.append(bool(hits(answered.loc[[i]], pick).iloc[0]))
    loo = float(np.mean(loo_hits))
    print(f"leave-one-out: {loo*100:.1f} %   "
          f"(vald percentil varierade: {sorted(set(loo_choice))})")
    print(f"överanpassning: {(scores[best]-loo)*100:+.1f} procentenheter")

    if impossible:
        print(f"\n=== omöjliga oavsett percentil: {len(impossible)} ===")
        for m in impossible:
            print(f"   {m}")
        tak = 1 - len(impossible) / len(answered)
        print(f"taket för ALLA percentiler: {tak*100:.1f} %")

    report = {
        "n_answered": int(len(answered)),
        "scores": {f"p{p}": round(v, 3) for p, v in scores.items()},
        "best": f"p{best}", "best_rate": round(scores[best], 3),
        "loo_rate": round(loo, 3),
        "overfit_points": round(scores[best] - loo, 3),
        "impossible": impossible,
        "ceiling": round(1 - len(impossible) / len(answered), 3) if len(answered) else None,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    data.to_csv("type_system/percentile_sweep.csv", index=False)
    print(f"\nskrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
