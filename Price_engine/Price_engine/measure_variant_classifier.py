#!/usr/bin/env python
"""Del 2 — mäter typklassificeraren (grannröstningen) mot facit ur databasen.

    python measure_variant_classifier.py --per-variant 300

Bilden har fått en enda uppgift: avgöra möbeltyp. Då måste den uppgiften mätas
med samma stränghet som allt annat.

**Facit** är textklassificeringens variant. Den är regelbaserad och därmed inte
felfri, men den är oberoende av bilden — och det är den egenskapen som behövs.

**Läckagespärren är kritisk.** Annonsens egen embedding ligger i indexet, och
den är sin egen närmaste granne med likhet 1,0. Utan spärr mäter man att en
bild är lik sig själv. Hela dubblettgruppen måste också bort: tradera har 65 %
dubblettbilder, och en kopia av samma foto läcker svaret precis lika bra.

Mätningen ger tre saker:
  * träffsäkerhet per typ
  * förväxlingsmatris — vilka typer blandas ihop, och åt vilket håll
  * avstå-kurva — täckning mot träffsäkerhet vid olika krav på röstenighet
"""

from __future__ import annotations

import argparse
import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

from price_engine import config
from price_engine.data_loader import load_listings
from price_engine.variant import PART, UNKNOWN
from price_engine.vectors import load_vectors

log = logging.getLogger("typmätning")

SEED = 20260806
OUT = Path("image_pairs/typ_analys.json")

#: Förväxlingar som kostar mest i pris. Rapporteras separat med riktning.
PRICE_CRITICAL = (
    ("hörnsoffa", "soffa", "bäddsoffa"),
    ("matgrupp", "matbord"),
    ("stol", "fåtölj"),
    ("byrå", "hylla"),
)


def build_test_set(listings: pd.DataFrame, store, per_variant: int) -> pd.DataFrame:
    """Annonser med vektor och säker möbeltyp, balanserat per typ."""
    rows = store.rows_for(listings)
    frame = listings.assign(vecrow=rows)
    frame = frame[frame["vecrow"] >= 0]
    frame = frame[~frame["variant"].isin([UNKNOWN, PART])]

    rng = np.random.default_rng(SEED)
    picked = []
    for variant, group in frame.groupby("variant", observed=True):
        take = min(len(group), per_variant)
        if take < 30:
            log.warning("%s: bara %d annonser, hoppar", variant, len(group))
            continue
        picked.append(group.sample(take, random_state=SEED))
    test = pd.concat(picked, ignore_index=True)
    log.info("Testmängd: %d annonser över %d typer",
             len(test), test["variant"].nunique())
    return test


def duplicate_index(listings: pd.DataFrame, store) -> dict:
    """(titel, pris) -> vektorrader. Läckagespärren, förberäknad.

    Per-annons-uppslag över 1,5 miljoner rader tar 50 ms styck; med 4 000
    testannonser blir det tre minuter av ren filtrering.
    """
    rows = store.rows_for(listings)
    frame = pd.DataFrame({
        "key": list(zip(listings["name_norm"], listings["price"])),
        "row": rows,
    })
    frame = frame[frame["row"] >= 0]
    return frame.groupby("key")["row"].apply(lambda s: set(s.tolist())).to_dict()


def classify_excluding(query_row: int, blocked: set, store, row_variant,
                       k: int) -> tuple:
    """Grannröstningen med utvalda rader maskerade. Se visual_variant.classify."""
    scores = store.embeddings @ store.embeddings[query_row]
    for row in blocked:
        if 0 <= row < len(scores):
            scores[row] = -1.0

    top = np.argpartition(scores, -k)[-k:]
    top = top[np.argsort(scores[top])[::-1]]
    top = top[scores[top] >= config.VISUAL_VARIANT_MIN_SIM]
    if len(top) < config.VISUAL_VARIANT_MIN_VOTES:
        return None, 0.0, int(len(top))

    labels = row_variant[top]
    weights = scores[top]
    ok = np.array([label is not None for label in labels])
    if ok.sum() < config.VISUAL_VARIANT_MIN_VOTES:
        return None, 0.0, int(ok.sum())

    votes: dict = {}
    for label, weight in zip(labels[ok], weights[ok]):
        votes[label] = votes.get(label, 0.0) + float(weight)
    total = sum(votes.values())
    winner = max(votes, key=votes.get)
    return winner, votes[winner] / total, int(ok.sum())


def abstain_curve(frame: pd.DataFrame) -> list:
    """Täckning mot träffsäkerhet vid olika krav på röstandel.

    Kurvan, inte en gissad tröskel: valet mellan att svara fel och att inte
    svara är en avvägning, och den avvägningen är din — inte min.
    """
    out = []
    for cut in np.round(np.arange(0.30, 0.96, 0.05), 2):
        answered = frame[frame["share"] >= cut]
        if not len(answered):
            continue
        out.append({
            "min_share": float(cut),
            "coverage": round(float(len(answered) / len(frame)), 3),
            "accuracy": round(float((answered["predicted"] == answered["truth"]).mean()), 3),
            "n": int(len(answered)),
        })
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_variant_classifier.py")
    parser.add_argument("--per-variant", type=int, default=300)
    parser.add_argument("--k", type=int, default=config.VISUAL_VARIANT_K)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    store = load_vectors()
    if not store.ready:
        log.error("Inget vektorlager")
        return 1

    from price_engine import visual_variant

    row_variant = visual_variant.row_variants(store, listings)
    duplicates = duplicate_index(listings, store)
    test = build_test_set(listings, store, args.per_variant)

    records = []
    for done, row in enumerate(test.itertuples(), start=1):
        if done % 250 == 0:
            log.info("%d / %d", done, len(test))
        blocked = {int(row.vecrow)} | duplicates.get(
            (row.name_norm, float(row.price)), set())
        predicted, share, votes = classify_excluding(
            int(row.vecrow), blocked, store, row_variant, args.k)
        records.append({
            "truth": row.variant, "predicted": predicted or "avstår",
            "share": share, "votes": votes, "blocked": len(blocked),
        })
    frame = pd.DataFrame(records)

    answered = frame[frame["predicted"] != "avstår"]
    report = {
        "n": int(len(frame)),
        "k": args.k,
        "leakage_guard": {
            "own_embedding_excluded": True,
            "duplicate_group_excluded": True,
            "median_rows_blocked": int(frame["blocked"].median()),
            "max_rows_blocked": int(frame["blocked"].max()),
        },
        "abstain_rate": round(float((frame["predicted"] == "avstår").mean()), 3),
        "accuracy_when_answering": round(
            float((answered["predicted"] == answered["truth"]).mean()), 3),
        "per_variant": {},
        "confusion": {},
        "price_critical": {},
        "abstain_curve": abstain_curve(frame),
    }

    for variant, group in frame.groupby("truth", observed=True):
        said = group[group["predicted"] != "avstår"]
        report["per_variant"][str(variant)] = {
            "n": int(len(group)),
            "abstain_rate": round(float((group["predicted"] == "avstår").mean()), 3),
            "accuracy": (round(float((said["predicted"] == said["truth"]).mean()), 3)
                         if len(said) else None),
            "median_share": round(float(said["share"].median()), 3) if len(said) else None,
        }

    matrix = pd.crosstab(frame["truth"], frame["predicted"], normalize="index")
    report["confusion"] = {
        str(truth): {str(pred): round(float(value), 3)
                     for pred, value in row.items() if value >= 0.02}
        for truth, row in matrix.iterrows()
    }

    for pairing in PRICE_CRITICAL:
        key = " ↔ ".join(pairing)
        entry = {}
        for truth in pairing:
            if truth not in matrix.index:
                continue
            for pred in pairing:
                if pred == truth or pred not in matrix.columns:
                    continue
                rate = float(matrix.loc[truth, pred])
                if rate > 0:
                    entry[f"{truth} -> {pred}"] = round(rate, 3)
        report["price_critical"][key] = entry

    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
