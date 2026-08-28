"""Fas 1 — bildkällor: hitta, normalisera och cacha annonsbilder.

Bilder kan vara kopplade till annonser på tre sätt, och alla tre hanteras:

  1. En kolumn med URL:er            (detta dataset)
  2. En kolumn med lokala sökvägar   (om `image_url` pekar på filsystemet)
  3. En mapp med en fil per annons-ID (sätt IMAGE_DIR i config)

URL:er laddas ner **en gång** till en lokal cache. Cachen är återupptagningsbar
— redan hämtade filer hoppas över — och kan rensas med ett kommando.

Två saker som mätningen i fas 1 avslöjade och som koden måste hantera:

**Archive-bilderna är borta.** Alla 973 009 annonser från `archive` pekar på
`i.blocketcdn.se/pictures/recommerce/...`, och 30 av 30 testade URL:er svarar
404 — Blocket rensar bilder när annonser går ut. De är därför uteslutna från
bildjobbet. (Samma vägg mötte den som byggde `clip_manifest.jsonl`: den
innehåller exakt blocket + auctionet + tradera, utan archive.)

**Auctionets lagrade URL är en 100x100-miniatyr.** `thumbs/mini_item_...` är
för liten för DINOv2, som vill ha minst 224 px. `medium_item` ger 460x460 och
används i stället.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import logging
import re
import shutil
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from . import config

log = logging.getLogger(__name__)

#: Källor vars bilder inte längre går att hämta. Se modulens docstring.
DEAD_SOURCES = ("archive",)

#: Auctionet lagrar miniatyren; byt upp till en storlek DINOv2 kan använda.
_AUCTIONET_THUMB = re.compile(r"/thumbs/(mini|small)_item_")

_UA = {"User-Agent": "Mozilla/5.0 (price-engine image prefetch)"}


def normalize_url(url: str) -> str:
    """Rättar kända URL-varianter som ger oanvändbara bilder."""
    if not isinstance(url, str):
        return url
    return _AUCTIONET_THUMB.sub("/thumbs/medium_item_", url)


def cache_dir() -> Path:
    path = Path(config.IMAGE_CACHE_DIR)
    path.mkdir(parents=True, exist_ok=True)
    return path


def cache_path(url: str) -> Path:
    """Cachefil för en URL. Namnges på innehållshash av URL:en, inte annons-ID,
    så att flera annonser med samma bild delar fil (tradera har 65 % dubbletter).
    """
    digest = hashlib.sha256(normalize_url(url).encode()).hexdigest()
    # Två nivåer av underkataloger — 100k filer i en katalog är trögt på macOS.
    sub = cache_dir() / digest[:2] / digest[2:4]
    sub.mkdir(parents=True, exist_ok=True)
    return sub / f"{digest}.img"


# --------------------------------------------------------------------------
# Var ligger bilden?
# --------------------------------------------------------------------------
def local_candidate(listing_id: object) -> Path | None:
    """Fil per annons-ID, om IMAGE_DIR är satt."""
    if not config.IMAGE_DIR or listing_id is None:
        return None
    base = Path(config.IMAGE_DIR)
    for suffix in (".jpg", ".jpeg", ".png", ".webp", ".img"):
        candidate = base / f"{listing_id}{suffix}"
        if candidate.is_file():
            return candidate
    return None


def resolve(row) -> tuple:
    """Ger (sökväg-eller-URL, sort) för en annons.

    sort är "local", "url" eller None. Lokala filer vinner alltid — de kräver
    ingen nedladdning.
    """
    listing_id = getattr(row, "dedup_key", None)
    local = local_candidate(listing_id)
    if local is not None:
        return local, "local"

    ref = getattr(row, "image_url", None)
    if not isinstance(ref, str) or not ref.strip():
        return None, None

    # En "URL" som råkar vara en filsökväg hanteras som lokal fil.
    if not ref.lower().startswith(("http://", "https://")):
        path = Path(ref)
        return (path, "local") if path.is_file() else (None, None)

    return normalize_url(ref), "url"


def usable(listings: pd.DataFrame) -> pd.DataFrame:
    """Annonser med en bild som faktiskt går att hämta.

    Döda källor filtreras bort här, en gång, i stället för att slösa
    nedladdningsförsök på 404:or.
    """
    if "image_url" not in listings.columns:
        return listings.iloc[0:0]
    frame = listings[listings["image_url"].notna()]
    if "source" in frame.columns:
        frame = frame[~frame["source"].isin(DEAD_SOURCES)]
    return frame


# --------------------------------------------------------------------------
# Nedladdning
# --------------------------------------------------------------------------
@dataclass
class FetchStats:
    cached: int = 0
    downloaded: int = 0
    failed: int = 0
    bytes_downloaded: int = 0
    seconds: float = 0.0

    def report(self) -> str:
        mb = self.bytes_downloaded / 1_048_576
        total = self.cached + self.downloaded + self.failed
        rate = self.downloaded / self.seconds if self.seconds else 0
        return (
            f"{total:,} bilder: {self.cached:,} redan i cache, "
            f"{self.downloaded:,} hämtade ({mb:.0f} MB), {self.failed:,} misslyckades "
            f"— {self.seconds:.0f} s, {rate:.1f} bilder/s"
        )


def fetch_one(url: str, timeout: int | None = None) -> tuple:
    """Hämtar en bild till cachen. Returnerar (sökväg, status).

    status är "cached", "downloaded" eller "failed". Redan hämtade filer rörs
    inte — det är detta som gör jobbet återupptagningsbart.
    """
    path = cache_path(url)
    if path.is_file() and path.stat().st_size > 0:
        return path, "cached", 0

    request = urllib.request.Request(normalize_url(url), headers=_UA)
    try:
        with urllib.request.urlopen(
            request, timeout=timeout or config.IMAGE_FETCH_TIMEOUT
        ) as response:
            data = response.read()
    except Exception as exc:  # nätfel, 404, timeout — alla hanteras lika
        log.debug("Kunde inte hämta %s: %s", url, exc)
        return None, "failed", 0

    if not data:
        return None, "failed", 0
    # Skriv till temporär fil först, så ett avbrott aldrig lämnar en halv bild
    # i cachen som nästa körning skulle tro var komplett.
    tmp = path.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(path)
    return path, "downloaded", len(data)


def prefetch(listings: pd.DataFrame, workers: int | None = None,
             limit: int | None = None, progress_every: int = 500) -> FetchStats:
    """Laddar ner alla bilder som saknas i cachen, parallellt.

    Avbryt när som helst — nästa körning fortsätter där denna slutade.
    """
    frame = usable(listings)
    urls = (
        frame["image_url"].map(normalize_url).dropna().drop_duplicates().tolist()
    )
    if limit:
        urls = urls[:limit]

    stats = FetchStats()
    started = time.perf_counter()
    workers = workers or config.IMAGE_FETCH_WORKERS

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for i, (_, status, size) in enumerate(pool.map(fetch_one, urls), 1):
            setattr(stats, status, getattr(stats, status) + 1)
            stats.bytes_downloaded += size
            if progress_every and i % progress_every == 0:
                elapsed = time.perf_counter() - started
                kvar = (len(urls) - i) * elapsed / i
                log.info(
                    "%d/%d bilder (%.0f%%) — %.0f s kvar",
                    i, len(urls), 100 * i / len(urls), kvar,
                )

    stats.seconds = time.perf_counter() - started
    return stats


def clear_cache() -> int:
    """Rensar bildcachen. Returnerar antal borttagna filer."""
    path = Path(config.IMAGE_CACHE_DIR)
    if not path.exists():
        return 0
    n = sum(1 for _ in path.rglob("*.img"))
    shutil.rmtree(path)
    return n


# --------------------------------------------------------------------------
# Fas 1-rapport
# --------------------------------------------------------------------------
def inventory(listings: pd.DataFrame) -> pd.DataFrame:
    """Hur bilder är kopplade till annonser, per källa."""
    rows = []
    for source, group in listings.groupby(listings.get("source", "?"), dropna=False):
        har_url = (
            group["image_url"].notna().sum() if "image_url" in group else 0
        )
        rows.append({
            "källa": str(source),
            "annonser": len(group),
            "med bild-URL": int(har_url),
            "täckning": f"{100 * har_url / len(group):.1f} %" if len(group) else "-",
            "hämtbar": "nej (404)" if str(source) in DEAD_SOURCES else "ja",
        })
    return pd.DataFrame(rows).sort_values("annonser", ascending=False)


def _main(argv=None) -> int:
    """CLI: python -m price_engine.images {inventory,prefetch,clear}"""
    import argparse

    from .data_loader import load_listings

    parser = argparse.ArgumentParser(prog="price_engine.images")
    parser.add_argument("kommando", choices=["inventory", "prefetch", "clear"])
    parser.add_argument("--limit", type=int, default=None,
                        help="Hämta bara så här många bilder (för tidsmätning)")
    parser.add_argument("--workers", type=int, default=None)
    parser.add_argument("--recent-only", action="store_true",
                        help="Bara annonser inom färskhetsfönstret")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if args.kommando == "clear":
        print(f"Rensade {clear_cache():,} cachade bilder")
        return 0

    listings = load_listings()
    if args.recent_only:
        from .pricing import _apply_recency

        listings, _, _ = _apply_recency(listings)

    if args.kommando == "inventory":
        print(inventory(listings).to_string(index=False))
        anv = usable(listings)
        print(f"\nHämtbara bilder: {len(anv):,} annonser, "
              f"{anv['image_url'].nunique():,} unika URL:er")
        cached = sum(1 for _ in Path(config.IMAGE_CACHE_DIR).rglob("*.img")) \
            if Path(config.IMAGE_CACHE_DIR).exists() else 0
        print(f"Redan i cache:   {cached:,}")
        return 0

    print(prefetch(listings, workers=args.workers, limit=args.limit).report())
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
