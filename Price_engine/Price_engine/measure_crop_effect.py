#!/usr/bin/env python
"""Korsar YOLO-beskärningen med bildlikhetens separation.

    python measure_crop_effect.py

Bildtröskelmätningen visade att separationen kollapsar för hylla (AUC 0,58),
säng (0,52) och hörnsoffa (0,51) men håller för stol (0,96) och fåtölj (0,89).
En förklaring som ligger nära: YOLO:s COCO-klasser innehåller `chair` och
`couch` men ingenting för byrå eller hylla, så beskärningen faller tillbaka på
hela bilden — och då mäter DINOv2 rummet i stället för möbeln.

Frågan avgör vilken åtgärd som är rätt. Är problemet DETEKTORN kan en
möbelspecifik detektor rädda de svaga typerna. Är problemet DINOv2 hjälper
ingen beskärning, och bildfiltret ska skrotas för dem.

Paren delas därför i tre grupper efter hur bilderna behandlades:

    båda beskurna      YOLO hittade möbeln i båda ändarna
    båda obeskurna     hela bilden användes i båda
    blandade           en av varje

**Urvalseffekten är inte kontrollerad** och kan inte vara det med denna data.
Se kommentaren i `caveat()`.
"""

from __future__ import annotations

import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

from price_engine import config
from price_engine.vectors import load_vectors

log = logging.getLogger("beskärning")

PAIRS = Path("image_pairs/facit_par.csv")
OUT = Path("image_pairs/beskarning_analys.json")


def auc(positive: np.ndarray, negative: np.ndarray) -> float:
    """Mann-Whitney-AUC: andelen (positiv, negativ)-par där positiv ligger högre."""
    if not len(positive) or not len(negative):
        return float("nan")
    greater = (positive[:, None] > negative[None, :]).mean()
    equal = (positive[:, None] == negative[None, :]).mean()
    return float(greater + 0.5 * equal)


def summarise(group: pd.DataFrame, min_per_class: int = 25) -> dict:
    positive = group[group["label"] == "samma_modell"]["similarity"].to_numpy()
    negative = group[group["label"] == "olika_modell"]["similarity"].to_numpy()
    if len(positive) < min_per_class or len(negative) < min_per_class:
        return {"status": "för litet underlag",
                "n_pos": int(len(positive)), "n_neg": int(len(negative))}
    return {
        "status": "ok",
        "n_pos": int(len(positive)), "n_neg": int(len(negative)),
        "auc": round(auc(positive, negative), 3),
        "median_pos": round(float(np.median(positive)), 3),
        "median_neg": round(float(np.median(negative)), 3),
    }


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    store = load_vectors()
    flags = np.load(Path(config.VECTOR_DIR) / "cropped.npy")
    pairs = pd.read_csv(PAIRS)

    pairs["a_cropped"] = flags[pairs["a_row"].to_numpy()]
    pairs["b_cropped"] = flags[pairs["b_row"].to_numpy()]
    pairs["crop_group"] = np.select(
        [pairs["a_cropped"] & pairs["b_cropped"],
         ~pairs["a_cropped"] & ~pairs["b_cropped"]],
        ["båda_beskurna", "båda_obeskurna"], default="blandade",
    )

    report = {
        "pairs": int(len(pairs)),
        "crop_share_overall": round(
            float(np.concatenate([pairs["a_cropped"], pairs["b_cropped"]]).mean()), 3),
        "crop_share_per_variant": {},
        "overall_by_crop_group": {},
        "per_variant": {},
        "caveat": caveat(),
    }

    for variant, group in pairs.groupby("variant", observed=True):
        sides = np.concatenate([group["a_cropped"], group["b_cropped"]])
        report["crop_share_per_variant"][str(variant)] = round(float(sides.mean()), 3)

    for name, group in pairs.groupby("crop_group", observed=True):
        report["overall_by_crop_group"][str(name)] = summarise(group)

    for variant, group in pairs.groupby("variant", observed=True):
        entry = {"alla": summarise(group), "per_crop_group": {}}
        for name, subset in group.groupby("crop_group", observed=True):
            entry["per_crop_group"][str(name)] = summarise(subset)
        report["per_variant"][str(variant)] = entry

    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def caveat() -> str:
    return (
        "URVALSEFFEKT, INTE KONTROLLERAD: grupperna är inte slumpmässigt "
        "tilldelade. YOLO lyckas oftare på bilder där möbeln är stor, "
        "välbelyst och fristående mot enkel bakgrund — alltså bilder som är "
        "lättare för DINOv2 oavsett beskärning. Högre AUC i gruppen "
        "'båda_beskurna' kan därför bero på bildernas kvalitet snarare än på "
        "beskärningen. Skillnaden går inte att separera med denna data; det "
        "skulle kräva att samma bilder embeddades både med och utan "
        "beskärning och jämfördes parvis."
    )


if __name__ == "__main__":
    raise SystemExit(main())
