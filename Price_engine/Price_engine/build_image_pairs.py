#!/usr/bin/env python
"""Väljer ut bildpar för handmärkning och bygger kontaktkartor att titta på.

    python build_image_pairs.py --pairs 200

`IMAGE_SIMILARITY_MIN = 0.45` är en gissning mellan två mätpunkter. Den behöver
handmärkta par för att sättas — och matbordsmätningen visade att den sannolikt
måste vara MÖBELTYPSBEROENDE: ett hemmafotat ekbord ligger på 0,27 mot allt i
indexet, medan soffor i studiofoto landar på 0,52-0,75 för samma möbeltyp.
Samma tröskel betyder alltså olika saker för olika möbler.

Urvalet är stratifierat över möbeltyp OCH likhetsspann. Att bara ta par nära
0,45 vore att mäta gränsen på den gräns man vill flytta — båda sidor måste
finnas med, från ~0,2 till ~0,9.

Slumpfröet är fixerat, så paren går att återskapa.
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

from price_engine import config, images as image_store
from price_engine.data_loader import load_listings
from price_engine.vectors import load_vectors

log = logging.getLogger("bildpar")

SEED = 20260806
OUT_DIR = Path(__file__).resolve().parent / "image_pairs"

#: Möbeltyper som ska täckas enligt uppdraget.
VARIANTS = ("soffa", "fåtölj", "bord", "matgrupp", "stol", "hylla", "byrå", "säng")

#: Likhetsspann. Gränsen 0,45 hamnar mitt i det tredje, så båda sidor syns.
BUCKETS = ((0.20, 0.30), (0.30, 0.45), (0.45, 0.60), (0.60, 0.75), (0.75, 0.92))


def candidate_pool(listings: pd.DataFrame, store) -> pd.DataFrame:
    """Annonser med vektor, en per vektorrad, med källa och möbeltyp."""
    rows = store.rows_for(listings)
    pool = listings.assign(_row=rows)
    pool = pool[pool["_row"] >= 0]
    # En rad per vektor: samma bild delas av flera annonser (tradera har 65 %
    # dubblettbilder), och identisk bild mot sig själv lär oss ingenting.
    pool = pool.drop_duplicates("_row")
    pool = pool[pool["variant"].isin(VARIANTS)]
    return pool[["_row", "variant", "source", "name", "price", "image_url",
                 "name_norm"]]


def sample_pairs(pool: pd.DataFrame, store, per_cell: int) -> pd.DataFrame:
    """Par per (möbeltyp x likhetsspann). Fixerat frö."""
    rng = np.random.default_rng(SEED)
    picked = []

    for variant in VARIANTS:
        subset = pool[pool["variant"] == variant]
        if len(subset) < 40:
            log.warning("%s: bara %d bilder, hoppar", variant, len(subset))
            continue
        # Ett hanterligt urval att beräkna parvisa likheter på.
        take = min(len(subset), 900)
        subset = subset.sample(take, random_state=SEED)
        rows = subset["_row"].to_numpy()
        vectors = store.embeddings[rows]
        similarity = vectors @ vectors.T
        np.fill_diagonal(similarity, -1.0)

        for low, high in BUCKETS:
            i, j = np.where((similarity >= low) & (similarity < high))
            keep = i < j
            i, j = i[keep], j[keep]
            if not len(i):
                continue
            order = rng.permutation(len(i))[: per_cell * 4]
            chosen, seen = [], set()
            for k in order:
                a, b = int(i[k]), int(j[k])
                left, right = subset.iloc[a], subset.iloc[b]
                # Samma rubrik OCH samma pris = dubblettgrupp, uteslut.
                if (left["name_norm"] == right["name_norm"]
                        and left["price"] == right["price"]):
                    continue
                key = (min(a, b), max(a, b))
                if key in seen:
                    continue
                seen.add(key)
                chosen.append({
                    "variant": variant,
                    "bucket": f"{low:.2f}-{high:.2f}",
                    "similarity": round(float(similarity[a, b]), 4),
                    "a_row": int(left["_row"]), "b_row": int(right["_row"]),
                    "a_source": left["source"], "b_source": right["source"],
                    "a_name": str(left["name"])[:90],
                    "b_name": str(right["name"])[:90],
                    "a_price": float(left["price"]), "b_price": float(right["price"]),
                    "a_url": left["image_url"], "b_url": right["image_url"],
                })
                if len(chosen) >= per_cell:
                    break
            picked.extend(chosen)

    frame = pd.DataFrame(picked)
    log.info("Valde %d par över %d möbeltyper", len(frame),
             frame["variant"].nunique() if len(frame) else 0)
    return frame


def build_sheets(pairs: pd.DataFrame, per_sheet: int = 6) -> list:
    """Kontaktkartor: `per_sheet` par per bild, A och B sida vid sida.

    Att titta på 400 enskilda bilder är inte görbart. Sammansatta ark gör
    märkningen möjlig utan att offra att varje par faktiskt SES.
    """
    from PIL import Image, ImageDraw

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    panel_h, panel_w, pad, label_h = 300, 300, 8, 26
    cols = 2
    rows = (per_sheet + cols - 1) // cols
    sheet_w = cols * (2 * panel_w + 3 * pad)
    sheet_h = rows * (panel_h + label_h + 2 * pad)

    written = []
    for sheet_no, start in enumerate(range(0, len(pairs), per_sheet), start=1):
        chunk = pairs.iloc[start : start + per_sheet]
        sheet = Image.new("RGB", (sheet_w, sheet_h), "white")
        draw = ImageDraw.Draw(sheet)
        for slot, (_, pair) in enumerate(chunk.iterrows()):
            cx = (slot % cols) * (2 * panel_w + 3 * pad)
            cy = (slot // cols) * (panel_h + label_h + 2 * pad)
            draw.text((cx + pad, cy + 4),
                      f"#{pair['pair_id']}  {pair['variant']}  sim={pair['similarity']:.2f}",
                      fill="black")
            for side, dx in (("a", 0), ("b", panel_w + pad)):
                path = image_store.cache_path(
                    image_store.normalize_url(pair[f"{side}_url"]))
                box = (cx + pad + dx, cy + label_h + pad)
                try:
                    im = Image.open(path).convert("RGB")
                    im.thumbnail((panel_w, panel_h))
                    sheet.paste(im, box)
                except Exception:
                    draw.rectangle([box, (box[0] + panel_w, box[1] + panel_h)],
                                   outline="red")
                    draw.text((box[0] + 10, box[1] + 10), "saknas", fill="red")
        path = OUT_DIR / f"ark_{sheet_no:02d}.jpg"
        sheet.save(path, quality=82)
        written.append(path)
    return written


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="build_image_pairs.py")
    parser.add_argument("--pairs", type=int, default=200)
    parser.add_argument("--per-sheet", type=int, default=6)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    store = load_vectors()
    pool = candidate_pool(listings, store)
    log.info("Kandidatpool: %d bilder med vektor", len(pool))

    per_cell = max(1, args.pairs // (len(VARIANTS) * len(BUCKETS)))
    pairs = sample_pairs(pool, store, per_cell)
    pairs.insert(0, "pair_id", range(1, len(pairs) + 1))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pairs.to_csv(OUT_DIR / "image_pairs.csv", index=False)

    # Hämta bilderna som behövs (temporär cache, rensas med images clear).
    urls = pd.concat([pairs["a_url"], pairs["b_url"]]).dropna().drop_duplicates()
    report = image_store.prefetch(pd.DataFrame({"image_url": urls}))
    log.info("Bildhämtning: %s", report.report())

    sheets = build_sheets(pairs, args.per_sheet)
    log.info("Skrev %d ark till %s", len(sheets), OUT_DIR)
    print(json.dumps({
        "pairs": len(pairs),
        "per_variant": pairs["variant"].value_counts().to_dict(),
        "per_bucket": pairs["bucket"].value_counts().sort_index().to_dict(),
        "sheets": len(sheets),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
