#!/usr/bin/env python
"""Mäter bildtröskeln ur de handmärkta paren.

    python analyse_image_pairs.py --labels image_pairs/image_pairs_labeled.csv

`IMAGE_SIMILARITY_MIN = 0.45` är en gissning. Detta räknar ut vad datan säger:
per möbeltyp, den poäng som bäst skiljer "samma möbel" från "olika möbler", och
hur många par som ändå hamnar fel vid den poängen.

Ingen motorändring — måttet är underlaget för beslutet, inte beslutet.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

#: Två definitioner av "träff", eftersom valet påverkar tröskeln:
#:   strikt  bara samma modell i samma utförande
#:   brett   även samma modell i annat tyg/annan storlek
POSITIVE_STRICT = ("samma_variant",)
POSITIVE_BROAD = ("samma_variant", "samma_modell_annan_variant")


def best_threshold(frame: pd.DataFrame, positives: tuple) -> dict:
    """Tröskeln som maximerar Youdens J = sensitivitet + specificitet − 1.

    J valdes framför träffsäkerhet eftersom klasserna är mycket obalanserade:
    med 8 % positiva ger "säg alltid olika" 92 % träffsäkerhet och är värdelöst.
    """
    is_positive = frame["label"].isin(positives)
    positive, negative = frame[is_positive], frame[~is_positive]
    if not len(positive) or not len(negative):
        return {"threshold": None, "reason": "en klass saknas"}

    candidates = np.unique(np.round(frame["similarity"], 2))
    best = None
    for threshold in candidates:
        true_positive = int((positive["similarity"] >= threshold).sum())
        false_positive = int((negative["similarity"] >= threshold).sum())
        sensitivity = true_positive / len(positive)
        specificity = 1 - false_positive / len(negative)
        j = sensitivity + specificity - 1
        if best is None or j > best["j"]:
            best = {
                "threshold": round(float(threshold), 2),
                "j": round(float(j), 3),
                "sensitivity": round(float(sensitivity), 3),
                "specificity": round(float(specificity), 3),
                "false_positives": false_positive,
                "false_negatives": len(positive) - true_positive,
            }
    best["n_positive"] = len(positive)
    best["n_negative"] = len(negative)
    # Separationen: hur långt ifrån varandra ligger klassernas medianer,
    # mätt i den negativa klassens spridning. Under ~0,5 betyder tröskeln lite.
    spread = negative["similarity"].std() or 1e-9
    best["separation"] = round(
        float((positive["similarity"].median() - negative["similarity"].median())
              / spread), 2)
    return best


def distribution(frame: pd.DataFrame) -> dict:
    out = {}
    for label, group in frame.groupby("label"):
        out[str(label)] = {
            "n": int(len(group)),
            "median": round(float(group["similarity"].median()), 3),
            "p25": round(float(group["similarity"].quantile(0.25)), 3),
            "p75": round(float(group["similarity"].quantile(0.75)), 3),
        }
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="analyse_image_pairs.py")
    parser.add_argument("--labels", required=True)
    parser.add_argument("--out", default="image_pairs/analys.json")
    args = parser.parse_args(argv)

    frame = pd.read_csv(args.labels)
    labelled = frame[frame["label"] != "osäker"]
    result = {
        "pairs_selected": int(len(frame)),
        "pairs_labelled": int(len(labelled)),
        "uncertain": int((frame["label"] == "osäker").sum()),
        "current_threshold": 0.45,
        "overall": {
            "distribution": distribution(labelled),
            "strict": best_threshold(labelled, POSITIVE_STRICT),
            "broad": best_threshold(labelled, POSITIVE_BROAD),
        },
        "per_variant": {},
    }
    for variant, group in labelled.groupby("variant"):
        result["per_variant"][str(variant)] = {
            "n": int(len(group)),
            "distribution": distribution(group),
            "broad": best_threshold(group, POSITIVE_BROAD),
            "false_positives_at_045": int(
                (~group["label"].isin(POSITIVE_BROAD)
                 & (group["similarity"] >= 0.45)).sum()),
            "positives_below_045": int(
                (group["label"].isin(POSITIVE_BROAD)
                 & (group["similarity"] < 0.45)).sum()),
        }

    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
