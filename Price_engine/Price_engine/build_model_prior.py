#!/usr/bin/env python
"""Bygger L1 — modellnamnspriorn ur databasen. Omkörbar.

    python build_model_prior.py            # -> model_type_prior.json

För varje distinktivt modellord räknas attributfördelningen över de annonser där
texten är tydlig. `Lamino` blir `base=stol` i ~98 % av fallen; `Kivik` fördelar
sig brett och får därför hög entropi och tystas.

**Bara kategoriska attribut får en prior.** `base`, `sub`, `storage_kind` och
`seats` har ett bestämt värde i texten när de nämns alls. `corner`, `chaise` och
`convertible` har det inte: texten ger dem bara som `True`, och att ordet
"hörnsoffa" saknas är inget bevis för att hörnet saknas. En prior byggd på dem
skulle luta systematiskt mot False och därmed återskapa exakt det fel hela
omdesignen finns för att bli av med — nedgradering mot den generiska typen.

Räknarna sparas råa, inte bara som andelar. Det är vad som gör leave-one-out
möjligt i `measure_type_system.py`: annonsens eget bidrag måste kunna dras av,
annars mäter man att priorn känner igen den annons den byggdes av.
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

from price_engine.data_loader import load_listings
from type_system import model_tokens
from type_system.prior import entropy
from type_system.text_layer import extract

log = logging.getLogger("prior")
OUT = Path("model_type_prior.json")

#: Endast kategoriska attribut — se modulens docstring.
PRIOR_ATTRIBUTES = ("base", "sub", "storage_kind", "seats")

#: Texten måste vara uttrycklig. 0,95 är L0:s konfidens för ett faktiskt ordfynd;
#: 0,85 (slutsats ur soffattribut) och 0,70 (matgrupp utan antal) räknas inte.
MIN_TEXT_CONFIDENCE = 0.90


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="build_model_prior.py")
    parser.add_argument("--min-listings", type=int, default=12)
    parser.add_argument("--min-token", type=int, default=12)
    parser.add_argument("--max-token", type=int, default=40_000)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    log.info("Annonser: %d", len(listings))

    known = model_tokens.distinctive(listings["name_norm"], args.min_token,
                                     args.max_token)
    log.info("Distinktiva modellord: %d", len(known))

    #: token -> "base" -> värde -> antal   (obetingat, bara för base)
    base_counts: dict = collections.defaultdict(collections.Counter)
    #: token -> bastyp -> attribut -> värde -> antal   (betingat)
    cond_counts: dict = collections.defaultdict(
        lambda: collections.defaultdict(lambda: collections.defaultdict(collections.Counter)))
    seen: collections.Counter = collections.Counter()

    for name, blob in zip(listings["name_norm"], listings["search_blob"]):
        tokens = model_tokens.of(name, known)
        if not tokens:
            continue
        attrs = extract(blob, prenormalized=True)
        if not (attrs.known("base")
                and attrs.confidence("base") >= MIN_TEXT_CONFIDENCE):
            continue
        base = str(attrs.get("base"))
        picked = {
            attribute: attrs.get(attribute)
            for attribute in PRIOR_ATTRIBUTES
            if attribute != "base" and attrs.known(attribute)
            and attrs.confidence(attribute) >= MIN_TEXT_CONFIDENCE
        }
        for token in set(tokens):
            seen[token] += 1
            base_counts[token][base] += 1
            for attribute, value in picked.items():
                cond_counts[token][base][attribute][str(value)] += 1

    table = {}
    for token, distribution in base_counts.items():
        n = seen[token]
        if n < args.min_listings:
            continue
        total = sum(distribution.values())
        if total < args.min_listings:
            continue
        value, top = distribution.most_common(1)[0]
        entry = {
            "n": int(n),
            "attributes": {"base": {
                "value": value,
                "share": round(top / total, 3),
                "entropy": round(entropy(dict(distribution)), 3),
                "n": int(total),
                "counts": dict(distribution),
            }},
            "by_base": {},
        }
        for base, per_attribute in cond_counts[token].items():
            block = {}
            for attribute, values in per_attribute.items():
                sub_total = sum(values.values())
                if sub_total < args.min_listings:
                    continue
                top_value, top_count = values.most_common(1)[0]
                block[attribute] = {
                    "value": _cast(attribute, top_value),
                    "share": round(top_count / sub_total, 3),
                    "entropy": round(entropy(dict(values)), 3),
                    "n": int(sub_total),
                    "counts": dict(values),
                }
            if block:
                entry["by_base"][base] = block
        table[token] = entry

    args.out.write_text(json.dumps(table, ensure_ascii=False, indent=1))
    log.info("Skrev %d modellord till %s", len(table), args.out)

    strong = [t for t, e in table.items()
              if e["attributes"].get("base", {}).get("entropy", 1) <= 0.5
              and e["attributes"].get("base", {}).get("share", 0) >= 0.7]
    print(f"\nmodellord totalt:            {len(table):,}")
    print(f"med stark base-prior:        {len(strong):,}")
    print(f"median annonser per ord:     "
          f"{sorted(e['n'] for e in table.values())[len(table) // 2]:,}")
    print("\nexempel på starka priors:")
    for token in sorted(strong, key=lambda t: -table[t]["n"])[:14]:
        base = table[token]["attributes"]["base"]
        print(f"   {token:<16}{base['value']:<12}{base['share']:>6.0%}  "
              f"n={base['n']:<6} entropi={base['entropy']:.2f}")
    print("\nexempel på tystade (hög entropi):")
    weak = sorted((t for t, e in table.items()
                   if e["attributes"].get("base", {}).get("entropy", 0) > 0.8),
                  key=lambda t: -table[t]["n"])[:8]
    for token in weak:
        base = table[token]["attributes"]["base"]
        print(f"   {token:<16}{'(tyst)':<12}{base['share']:>6.0%}  "
              f"n={base['n']:<6} entropi={base['entropy']:.2f}  "
              f"{dict(list(base['counts'].items())[:4])}")
    return 0


def _cast(attribute: str, value: str):
    if attribute == "seats":
        try:
            return int(value)
        except ValueError:
            return value
    return value


if __name__ == "__main__":
    raise SystemExit(main())
