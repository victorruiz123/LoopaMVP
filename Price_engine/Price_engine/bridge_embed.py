#!/usr/bin/env python
"""Del A, steg 3 — embedda auktionsbilderna för den kvalificerade delmängden.

    python bridge_embed.py --limit 200    # takttest först
    python bridge_embed.py                # hela mängden

Samma pipeline som annonsbilderna: hämta, beskär med YOLO, embedda med
DINOv2-small (CLS, L2-normaliserat, float16), skriv skärvor, slå ihop.
Ingen ny kod för själva embeddingen — `embed_images.run` återanvänds rakt av,
så vektorerna hamnar i samma rum och går att jämföra.

Avbrottssäkert: redan embeddade URL-hashar hoppas över, så en avbruten körning
återupptas genom att köra om.

Vi sparar aldrig annonsbilderna permanent — bara vektorerna. Bildcachen är
temporär och rensas med `python -m price_engine.images clear`.
"""

from __future__ import annotations

import argparse
import logging
import time
import warnings

warnings.filterwarnings("ignore")

import pandas as pd

import bridge_matching as B
import study_config as S
from price_engine import images as image_store
from run_percentile_study import load_enriched, prepare_sales

log = logging.getLogger("brygga.embed")


def qualified_with_images() -> pd.DataFrame:
    """Kvalificerade försäljningar som har en bild-URL att hämta."""
    frame = load_enriched()
    sales, _ = prepare_sales(frame)
    qualified = B.qualify(sales)
    qualified = qualified[qualified["model"].notna()]

    pool = B.build_pool(frame)
    matcher = B.ModelMatcher(pool)
    months = qualified["listed_at"].dt.to_period("M")
    counts = [
        len(matcher.candidates(sale["brand"], sale["model"], month))
        for (_, sale), month in zip(qualified.iterrows(), months)
    ]
    qualified = qualified.assign(n_asking=counts)
    qualified = qualified[qualified["n_asking"] >= S.BRIDGE_MIN_ASKING]
    return qualified[qualified["image_url"].notna()]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="bridge_embed.py")
    parser.add_argument("--limit", type=int, default=None,
                        help="Kör bara så här många — för takttest")
    parser.add_argument("--workers", type=int, default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    import embed_images

    sales = qualified_with_images()
    if args.limit:
        sales = sales.head(args.limit)
    log.info("Kvalificerade med bild: %d", len(sales))

    started = time.perf_counter()
    report = image_store.prefetch(sales, workers=args.workers)
    log.info("Hämtning: %s  (%.0f s)", report.report(), time.perf_counter() - started)

    # embed_images.pending() läser hela annonstabellen; här vill vi bara ha
    # den kvalificerade delmängden, så urvalet görs på samma sätt men lokalt.
    urls = (image_store.usable(sales)["image_url"]
            .map(image_store.normalize_url).dropna().drop_duplicates())
    already = embed_images.done_ids()
    items = []
    for url in urls:
        path = image_store.cache_path(url)
        if path.is_file() and path.stem not in already:
            items.append((path.stem, path))

    log.info("Att embedda: %d (av %d hämtade URL:er)", len(items), len(urls))
    if not items:
        log.info("Inget nytt att göra")
        return 0

    started = time.perf_counter()
    embed_images.run(items, batch=embed_images.config.EMBED_BATCH)
    elapsed = time.perf_counter() - started
    log.info("Embedding: %d bilder på %.0f s (%.0f ms/bild)",
             len(items), elapsed, elapsed / max(len(items), 1) * 1000)

    embed_images.merge()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
