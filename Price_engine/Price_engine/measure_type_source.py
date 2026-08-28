#!/usr/bin/env python
"""Varifrån kom bastypen? Per möbel, för alla 34 benchmarkfallen.

    python measure_type_source.py

Benchmarken avslöjade tre svar som ser fel ut i typvalet: en kontorsstol blev
`fatolj`, en soffa blev `fotpall`, en soffa blev `sang`. Kinnarps träffade
dessutom facit (1 480 mot 1 300-1 600) **på fel grunder** — och sådana fel syns
inte i accuracy. De exploderar i produktion, där ingen facittabell skyddar.

Frågan den här mätningen svarar på är inte "hur ofta blir det fel" utan
**"vilken källa bestämde, och fick den bestämma enligt reglerna?"**

Reglerna som prövas:

  R1  Bilden får bara sätta FAMILJ (`base`), aldrig undertyp.
  R2  Bilden får aldrig vinna över en textsignal.
  R3  Bilden ska avstå under `image_layer.ABSTAIN_BELOW` röstenighet.
  R4  Priorn ska tiga över `prior.MAX_ENTROPY` entropi.
  R5  Priorn ska tiga under `prior.MIN_SHARE` andel.

Ingen fix görs här. Diagnos före medicin.
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import pandas as pd

from price_engine import vision as vision_mod
from price_engine.data_loader import load_listings
from price_engine.vectors import load_vectors
from type_system import chain, image_layer
from type_system import prior as prior_mod
from type_system.prior import Prior
from type_system.text_layer import extract

log = logging.getLogger("typkälla")
SCRATCH = Path("/private/tmp/claude-501/-Users-test-Price-engine-Price-engine/"
               "6e822209-bd34-4986-b32b-5f8ba2e1c7c2/scratchpad")
BENCHMARKS = (("11 första", "r11"), ("benchmark 1", "rb1"), ("benchmark 2", "rb2"))
OUT = Path("type_system/type_source.json")


def query_vector(path: Path):
    """Samma väg som pricing.py bygger frågevektorn. Ingen egen variant."""
    from PIL import Image

    try:
        vec, col, _ = vision_mod.prepare_one(Image.open(io.BytesIO(path.read_bytes())))
        return vec
    except Exception as exc:  # noqa: BLE001
        log.warning("kunde inte embedda %s: %s", path.name, exc)
        return None


def core_name(model: str) -> str:
    """Samma kapning av typord som evaluate_examples använder."""
    from evaluate_examples import core_name as _core

    return _core(model)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_type_source.py")
    parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    store = load_vectors()
    prior = Prior.load()

    rows = []
    for label, tag in BENCHMARKS:
        items = json.loads((SCRATCH / f"{tag}_items.json").read_text())
        images = json.loads((SCRATCH / f"{tag}_images.json").read_text())
        for item in items:
            model = item.get("model") or ""
            name = core_name(model) if item.get("brand") else model
            paths = images.get(str(item["nr"])) or []
            vec = query_vector(Path(paths[0])) if paths else None

            # Kedjan körd exakt som motorn kör den.
            result = chain.resolve(
                name=name, brand=item.get("brand") or None,
                queries=[vec] if vec is not None else None,
                store=store, listings=listings, prior=prior,
                use_vision=False, ask_user=False,
            )
            attrs = result.attributes
            text_only = extract(f"{name} {item.get('brand') or ''}")
            info = result.diagnostics.get("image") or {}
            ptoken, pentry = prior.lookup(f"{name} {item.get('brand') or ''}")
            pbase = (pentry.get("attributes") or {}).get("base") or {}

            source = attrs.source("base")
            share = info.get("share")
            violations = []
            # R1: bilden får bara sätta base — kontrolleras genom att inget
            #     annat attribut har source "image".
            if any(v.source == "image" for k, v in attrs.values.items() if k != "base"):
                violations.append("R1 bilden satte undertyp")
            # R2: bilden vann över en textsignal
            if source == "image" and text_only.known("base"):
                violations.append("R2 bilden vann över text")
            # R3: bilden svarade under avstå-tröskeln
            if source == "image" and share is not None and share < image_layer.ABSTAIN_BELOW:
                violations.append(f"R3 röstenighet {share:.2f} < {image_layer.ABSTAIN_BELOW}")
            # R4/R5: priorn talade trots svagt underlag
            if source == "prior":
                if pbase.get("entropy", 1.0) > prior_mod.MAX_ENTROPY:
                    violations.append(f"R4 entropi {pbase.get('entropy')}")
                if pbase.get("share", 0.0) < prior_mod.MIN_SHARE:
                    violations.append(f"R5 andel {pbase.get('share')}")

            rows.append({
                "benchmark": label, "nr": item["nr"],
                "möbel": f"{item.get('brand') or ''} {model}".strip(),
                "facit": f"{item['facit_low']}-{item['facit_high']}",
                "base": attrs.get("base"), "källa": source,
                "derivedType": result.derived_type,
                "union": len(result.possible_types),
                "typeConfidence": result.type_confidence,
                "bildröst": round(share, 2) if share is not None else None,
                "bildmetod": info.get("method"),
                "bildhåller_med": info.get("agrees"),
                "text_base": text_only.get("base"),
                "prior_token": ptoken,
                "prior_base": pbase.get("value"),
                "prior_entropi": pbase.get("entropy"),
                "prior_andel": pbase.get("share"),
                "regelbrott": "; ".join(violations) or "",
            })

    data = pd.DataFrame(rows)
    data.to_csv("type_system/type_source.csv", index=False)

    def num(value, width, decimals=2):
        if value is None or pd.isna(value):
            return "".rjust(width)
        return format(value, f".{decimals}f").rjust(width)

    print(f"\n{'möbel':<26}{'base':<11}{'källa':<8}{'röst':>6}"
          f"{'text':<11}{'prior':<11}{'H':>6}  regelbrott")
    for _, r in data.iterrows():
        print(f"{str(r['möbel'])[:25]:<26}{str(r['base'])[:10]:<11}"
              f"{str(r['källa'])[:7]:<8}{num(r['bildröst'], 6)}"
              f"{str(r['text_base'] or '-')[:10]:<11}"
              f"{str(r['prior_base'] or '-')[:10]:<11}"
              f"{num(r['prior_entropi'], 6)}  {r['regelbrott']}")

    print("\n=== varifrån kom bastypen ===")
    print(data["källa"].fillna("ingen").value_counts().to_string())
    brott = data[data["regelbrott"] != ""]
    print(f"\n=== regelbrott: {len(brott)} av {len(data)} ===")
    for _, r in brott.iterrows():
        print(f"   {str(r['möbel'])[:30]:<32}{r['regelbrott']}")

    report = {
        "n": int(len(data)),
        "by_source": data["källa"].fillna("ingen").value_counts().to_dict(),
        "violations": int(len(brott)),
        "violation_detail": brott[["möbel", "regelbrott"]].to_dict("records"),
    }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nskrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
