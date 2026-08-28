#!/usr/bin/env python
"""Mäter CUE_FILTER_ENABLED separat — ledorden är textsignaler, inte bildsignaler.

    python measure_cue_filter.py

Ledordsfiltret stängdes av tillsammans med bildomrankningen i Del 1 av
BILDROLL_RAPPORT.md. Det var ett metodfel: slutsatsen om bilden vilade på
bildparmätningen, och ledorden är ord ur grannarnas TITLAR. De omfattas inte av
den slutsatsen och förtjänar en egen mätning.

Körningen jämför samma tre benchmarkar med filtret av och på, i övrigt identiskt
kodläge. Ingen tröskel justeras — mätningen avgör bara om flaggan ska stå på.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

SCRATCH = Path("/private/tmp/claude-501/-Users-test-Price-engine-Price-engine/"
               "6e822209-bd34-4986-b32b-5f8ba2e1c7c2/scratchpad")
BENCHMARKS = (
    ("11 första", SCRATCH / "items.json", SCRATCH / "images.json"),
    ("benchmark 1", SCRATCH / "bench_items_fixed.json", SCRATCH / "bench_images.json"),
    ("benchmark 2", SCRATCH / "b2_items.json", SCRATCH / "b2_images.json"),
)
MODES = "kärnnamn,kärnnamn + bild"

log = logging.getLogger("cue")


def run(specs: Path, images: Path, out: Path, cue: bool) -> dict:
    """Kör benchmarken i en egen process, så flaggan garanterat gäller.

    Att sätta `config.CUE_FILTER_ENABLED` i den här processen och sedan importera
    hade fungerat, men en separat process gör det omöjligt att av misstag mäta ett
    annat kodläge än det avsedda — vilket redan hänt en gång i det här projektet.
    """
    env_flag = "1" if cue else "0"
    code = (
        "import os, sys;"
        "from price_engine import config;"
        f"config.CUE_FILTER_ENABLED = {bool(cue)!r};"
        "import evaluate_examples as E;"
        f"sys.exit(E.main(['--specs', {str(specs)!r}, '--images', {str(images)!r},"
        f" '--out', {str(out)!r}, '--modes', {MODES!r}, '--frozen']))"
    )
    proc = subprocess.run([sys.executable, "-c", code],
                          capture_output=True, text=True,
                          env={**__import__("os").environ,
                               "PYTHONPATH": ".", "PRICE_ENGINE_CUE": env_flag})
    if proc.returncode != 0:
        log.error("misslyckades (cue=%s): %s", cue, proc.stderr[-800:])
        return {}
    return json.loads((out / "sammanfattning.json").read_text())["totalt"]


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    rows = []
    for label, specs, images in BENCHMARKS:
        for cue in (False, True):
            tag = "på" if cue else "av"
            out = Path(f"eval_cue_{'on' if cue else 'off'}_"
                       f"{label.split()[-1].replace('första', '11')}")
            log.info("%s, ledord %s -> %s", label, tag, out)
            totals = run(specs, images, out, cue)
            for mode, values in totals.items():
                rows.append({
                    "benchmark": label, "cue": tag, "mode": mode,
                    "overlap": values["accuracy_intervall_överlapp"],
                    "default": values["accuracy_default_inom_facit"],
                    "n": values["möbler"], "answered": values["svar_gavs"],
                })

    Path("type_system/cue_filter.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2))

    print(f"\n{'benchmark':<14}{'läge':<20}{'ledord':<8}{'överlapp':>10}{'default':>10}")
    for row in rows:
        print(f"{row['benchmark']:<14}{row['mode'][:19]:<20}{row['cue']:<8}"
              f"{row['overlap']*100:>9.1f}%{row['default']*100:>9.1f}%")
    print("\nskrivet till type_system/cue_filter.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
