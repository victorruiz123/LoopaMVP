#!/usr/bin/env python
"""Fas 3–4 — embedda annonsbilder till vektorer.

    python embed_images.py --recent-only              # hela jobbet
    python embed_images.py --recent-only --limit 2000 # tidsmätning först
    python embed_images.py --samples 40               # spara beskurna exempel
    python embed_images.py --merge                    # bygg .npy + FAISS

Jobbet är **återupptagningsbart**: resultatet skrivs i skärvor om
SHARD_SIZE bilder, och en omstart hoppar över allt som redan är gjort.
Avbryt när som helst med Ctrl-C.

Lagringen (fas 4) är medvetet enkel — ingen vektordatabas behövs i den här
storleken:

    embeddings.npy   (N, 384) float16   ~70 MB för 94k
    colors.npy       (N, 96)  float16
    cropped.npy      (N,)     bool      spårar vilka som YOLO faktiskt hittade
    ids.json         radindex -> URL-hash
    index.faiss      för analys och "hitta liknande i hela beståndet"

FAISS byggs för helbeståndssökning, men API-flödet använder numpy: vid
re-ranking av ~200 kandidater är en vanlig skalärprodukt snabbare än ett
indexuppslag.

Vektorerna nycklas på **URL-hash, inte annons-ID**, så att flera annonser med
samma bild delar rad (tradera har 65 % dubbletter).
"""

from __future__ import annotations

import argparse
import json
import logging
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
from PIL import Image

from price_engine import config, images as image_store, vision
from price_engine.data_loader import load_listings

log = logging.getLogger("embed")

SHARD_SIZE = 2000


def shard_dir() -> Path:
    path = Path(config.VECTOR_DIR) / "shards"
    path.mkdir(parents=True, exist_ok=True)
    return path


def done_ids() -> set:
    """URL-hashar som redan är embeddade. Grunden för återupptagningen."""
    done = set()
    for shard in shard_dir().glob("*.npz"):
        try:
            with np.load(shard, allow_pickle=True) as data:
                done.update(data["ids"].tolist())
        except Exception:
            log.warning("Skadad skärva ignoreras: %s", shard.name)
    return done


def pending(recent_only: bool) -> list:
    """(url-hash, cachefil) för bilder som är hämtade men inte embeddade."""
    listings = load_listings()
    if recent_only:
        from price_engine.pricing import _apply_recency

        listings, _, _ = _apply_recency(listings)

    urls = image_store.usable(listings)["image_url"].map(
        image_store.normalize_url
    ).dropna().drop_duplicates()

    already = done_ids()
    out, skipped = [], []
    for url in urls:
        path = image_store.cache_path(url)
        if not path.is_file():
            continue  # inte nedladdad än
        key = path.stem
        if key in already:
            continue
        # Skärmdumpar blockeras redan här: de är inte möbelbilder och ska
        # aldrig hamna i lagret. Se image_pair_facit.is_screenshot.
        if _is_screenshot(path):
            skipped.append(key)
            continue
        out.append((key, path))
    if skipped:
        log.info("Hoppade över %d skärmdumpar", len(skipped))
        _record_blocked(skipped)
    return out


def _is_screenshot(path) -> bool:
    """Mobilproportion OCH övervägande vitt gränssnitt. Se image_pair_facit."""
    try:
        from image_pair_facit import is_screenshot

        return is_screenshot(path)
    except Exception:
        return False


def _record_blocked(keys: list) -> None:
    """Lägger nyfunna skärmdumpar i blocklistan som vektorlagret läser."""
    path = Path(config.VECTOR_DIR) / "blocked.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = set(json.loads(path.read_text())) if path.is_file() else set()
    path.write_text(json.dumps(sorted(existing | set(keys)), indent=1))


def save_samples(items: list, n: int) -> Path:
    """Fas 2 — spara beskurna exempel så beskärningen går att ögna."""
    out = Path(config.VECTOR_DIR) / "crops"
    out.mkdir(parents=True, exist_ok=True)
    saved = 0
    for key, path in items:
        if saved >= n:
            break
        try:
            original = Image.open(path).convert("RGB")
        except Exception:
            continue
        cropped, flags = vision.crop_batch([original])
        tag = "beskuren" if flags[0] else "hel"
        # Original och beskuren sida vid sida, så skillnaden syns direkt.
        a, b = original, cropped[0]
        h = 320
        a = a.resize((int(a.width * h / a.height), h))
        b = b.resize((int(b.width * h / b.height), h))
        canvas = Image.new("RGB", (a.width + b.width + 8, h), "white")
        canvas.paste(a, (0, 0))
        canvas.paste(b, (a.width + 8, 0))
        canvas.save(out / f"{saved:03d}_{tag}_{key[:8]}.jpg", quality=88)
        saved += 1
    return out


def run(items: list, batch: int) -> None:
    """Embeddar och skriver skärvor. Avbrottssäkert."""
    total = len(items)
    started = time.perf_counter()
    buffer: list = []
    shard_no = len(list(shard_dir().glob("*.npz")))

    def flush():
        nonlocal buffer, shard_no
        if not buffer:
            return
        keys = [k for k, _, _, _ in buffer]
        np.savez_compressed(
            shard_dir() / f"{shard_no:05d}.npz",
            ids=np.array(keys, dtype=object),
            emb=np.stack([e for _, e, _, _ in buffer]).astype(np.float16),
            color=np.stack([c for _, _, c, _ in buffer]).astype(np.float16),
            cropped=np.array([f for _, _, _, f in buffer], dtype=bool),
        )
        shard_no += 1
        buffer = []

    processed = 0
    for start in range(0, total, batch):
        chunk = items[start : start + batch]
        loaded, keys = [], []
        for key, path in chunk:
            try:
                loaded.append(Image.open(path).convert("RGB"))
                keys.append(key)
            except Exception:
                log.debug("Kunde inte öppna %s", path)
        if not loaded:
            continue

        vectors, colors, flags = vision.prepare_batch(loaded)
        buffer.extend(zip(keys, vectors, colors, flags))
        processed += len(loaded)

        if len(buffer) >= SHARD_SIZE:
            flush()

        elapsed = time.perf_counter() - started
        per = elapsed / max(processed, 1)
        log.info(
            "%d/%d (%.1f %%) — %.0f ms/bild, %.0f min kvar",
            processed, total, 100 * processed / total,
            per * 1000, (total - processed) * per / 60,
        )
    flush()


def merge() -> None:
    """Fas 4 — slå ihop skärvorna till .npy + FAISS-index."""
    shards = sorted(shard_dir().glob("*.npz"))
    if not shards:
        log.error("Inga skärvor att slå ihop")
        return

    ids, emb, color, cropped = [], [], [], []
    for shard in shards:
        with np.load(shard, allow_pickle=True) as data:
            ids.extend(data["ids"].tolist())
            emb.append(data["emb"])
            color.append(data["color"])
            cropped.append(data["cropped"])

    # Dubbletter kan uppstå om ett jobb avbrutits mitt i en skärva.
    seen, keep = set(), []
    for i, key in enumerate(ids):
        if key not in seen:
            seen.add(key)
            keep.append(i)

    emb = np.concatenate(emb)[keep]
    color = np.concatenate(color)[keep]
    cropped = np.concatenate(cropped)[keep]
    ids = [ids[i] for i in keep]

    out = Path(config.VECTOR_DIR)
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / "embeddings.npy", emb)
    np.save(out / "colors.npy", color)
    np.save(out / "cropped.npy", cropped)
    (out / "ids.json").write_text(json.dumps(ids))

    # FAISS för helbeståndssökning. Vektorerna är L2-normaliserade, så
    # inre produkt = cosinuslikhet.
    try:
        import faiss

        index = faiss.IndexFlatIP(emb.shape[1])
        index.add(emb.astype(np.float32))
        faiss.write_index(index, str(out / "index.faiss"))
        faiss_note = f", FAISS-index med {index.ntotal:,} vektorer"
    except Exception as exc:
        faiss_note = f" (FAISS hoppades över: {exc})"

    mb = (emb.nbytes + color.nbytes) / 1_048_576
    log.info(
        "Sammanslaget: %s vektorer, %.0f %% beskurna, %.0f MB%s",
        f"{len(ids):,}", 100 * cropped.mean(), mb, faiss_note,
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="embed_images.py")
    parser.add_argument("--recent-only", action="store_true",
                        help="Bara annonser inom färskhetsfönstret")
    parser.add_argument("--limit", type=int, default=None,
                        help="Embedda bara så här många (för tidsmätning)")
    parser.add_argument("--batch", type=int, default=config.EMBED_BATCH)
    parser.add_argument("--samples", type=int, default=0,
                        help="Spara N beskurna exempelbilder och avsluta")
    parser.add_argument("--merge", action="store_true",
                        help="Slå ihop skärvor till .npy + FAISS och avsluta")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if args.merge:
        merge()
        return 0

    items = pending(args.recent_only)
    if args.status:
        print(f"  klara:    {len(done_ids()):,}")
        print(f"  kvar:     {len(items):,}")
        return 0

    if args.samples:
        path = save_samples(items, args.samples)
        print(f"Sparade {args.samples} exempel i {path}")
        return 0

    if args.limit:
        items = items[: args.limit]
    if not items:
        log.info("Inget att göra — allt hämtat är redan embeddat")
        return 0

    log.info("Embeddar %s bilder …", f"{len(items):,}")
    run(items, args.batch)
    merge()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
