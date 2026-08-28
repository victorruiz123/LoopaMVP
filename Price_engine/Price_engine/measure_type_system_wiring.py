#!/usr/bin/env python
"""Mäter vad KOPPLINGEN gjorde — attributsystemet mot den gamla taxonomin.

    python measure_type_system_wiring.py

`measure_type_system.py` mäter lagren i isolering: hur ofta L0/L1/L2 träffar rätt
bastyp mot korpusfacit. Den anropar aldrig `price_query`, och kan därför inte se
om det spelar någon roll att typerna nu driver sökningen. Före och efter
kopplingen gav den identiska siffror, vilket var korrekt men oanvändbart.

Den här mätningen kör motorn två gånger per möbel — med `TYPE_SYSTEM_DRIVES_SEARCH`
av och på — i separata processer, så flaggan garanterat gäller.

**Två mått, av olika skäl:**

* `default inom facit` är huvudmåttet. Det straffar både för brett och för smalt.
* `överlapp` redovisas men bör läsas med misstro: det belönar bredd, vilket
  blindlägesmätningen visade när 42x breda intervall räknades som träff.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import pandas as pd

SCRATCH = Path("/private/tmp/claude-501/-Users-test-Price-engine-Price-engine/"
               "6e822209-bd34-4986-b32b-5f8ba2e1c7c2/scratchpad")
BENCHMARKS = (
    ("11 första", SCRATCH / "items.json", SCRATCH / "images.json"),
    ("benchmark 1", SCRATCH / "bench_items_fixed.json", SCRATCH / "bench_images.json"),
    ("benchmark 2", SCRATCH / "b2_items.json", SCRATCH / "b2_images.json"),
)
MODES = "kärnnamn,kärnnamn + bild"
OUT = Path("type_system/wiring_effect.json")

log = logging.getLogger("koppling")


def run(specs: Path, images: Path, out: Path, enabled: bool) -> dict:
    """Egen process per flagginställning — annars mäts fel kodläge.

    Att sätta flaggan i den här processen och importera hade fungerat, men
    exakt det felet har redan kostat en halv körning en gång i det här
    projektet. En separat process gör det omöjligt.
    """
    env = {**os.environ, "PYTHONPATH": ".",
           "PRICE_ENGINE_TYPE_SYSTEM": "1" if enabled else "0"}
    code = (
        "import sys; import evaluate_examples as E;"
        f"sys.exit(E.main(['--specs', {str(specs)!r}, '--images', {str(images)!r},"
        f" '--out', {str(out)!r}, '--modes', {MODES!r}, '--frozen']))"
    )
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True,
                          text=True, env=env)
    if proc.returncode != 0:
        log.error("misslyckades (flagga=%s): %s", enabled, proc.stderr[-600:])
        return {}
    return json.loads((out / "sammanfattning.json").read_text())["totalt"]


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    rows = []
    for label, specs, images in BENCHMARKS:
        for enabled in (False, True):
            tag = "på" if enabled else "av"
            out = Path(f"eval_wire_{'on' if enabled else 'off'}_"
                       f"{label.split()[-1].replace('första', '11')}")
            log.info("%s, attributsystemet %s", label, tag)
            totals = run(specs, images, out, enabled)
            for mode, values in totals.items():
                rows.append({
                    "benchmark": label, "flagga": tag, "läge": mode,
                    "överlapp": values["accuracy_intervall_överlapp"],
                    "default": values["accuracy_default_inom_facit"],
                    "svar": values["svar_gavs"], "möbler": values["möbler"],
                })

    frame = pd.DataFrame(rows)
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=2))

    print(f"\n{'benchmark':<14}{'läge':<18}{'flagga':<8}{'överlapp':>10}{'default':>10}")
    for _, r in frame.iterrows():
        print(f"{r['benchmark']:<14}{r['läge'][:17]:<18}{r['flagga']:<8}"
              f"{r['överlapp']*100:>9.1f}%{r['default']*100:>9.1f}%")

    print("\n=== skillnad, attributsystemet PÅ minus AV ===")
    print(f"{'benchmark':<14}{'läge':<18}{'överlapp':>11}{'default':>11}")
    for (bm, mode), g in frame.groupby(["benchmark", "läge"], sort=False):
        av = g[g["flagga"] == "av"]
        pa = g[g["flagga"] == "på"]
        if av.empty or pa.empty:
            continue
        d_o = (pa["överlapp"].iloc[0] - av["överlapp"].iloc[0]) * 100
        d_d = (pa["default"].iloc[0] - av["default"].iloc[0]) * 100
        print(f"{bm:<14}{mode[:17]:<18}{d_o:>+10.1f}p{d_d:>+10.1f}p")
    print("\ndefault inom facit är huvudmåttet — överlapp belönar bredd.")
    print(f"skrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
