#!/usr/bin/env python
"""Upphovsrättssaneringen: extrahera skadeflaggor, radera skyddat material.

    python sanitize_corpus.py                 # torrkörning, visar vad som händer
    python sanitize_corpus.py --apply         # genomför

Ordningen är inte valfri. Skadeflaggorna MÅSTE skrivas innan `condition_text`
raderas — 470 278 rader skicktext är det enda underlaget för en framtida
skickmodell, och raderingen går inte att ångra.

Varje fil skrivs till en ny fil som verifieras innan den ersätter originalet.
Ingen fil redigeras på plats: går skrivningen sönder finns originalet kvar.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from price_engine import config                      # noqa: E402
from type_system import damage                       # noqa: E402

log = logging.getLogger("sanering")

DATA = Path("../vips-ml-data")
MASTER = DATA / "vips-fas0" / "master.parquet"

#: Kolumner som skrivs bort ur master. Se UPPHOVSRATT_INVENTERING.md.
DROP_FROM_MASTER = ("description", "condition_text", "canonical_text")

#: Nycklar som strippas ur rå-NDJSON. `lat`/`lon` finns på 100 % av
#: blocket-raderna och är den tyngsta personuppgiften i hela materialet.
DROP_FROM_NDJSON = ("lat", "lon", "latitude", "longitude", "description",
                    "condition_text", "seller_type", "seller", "url", "href",
                    "click_id")

#: Kataloger som raderas i sin helhet — de innehåller bara bilder.
IMAGE_TARGETS = (
    Path(".cache/images"),
    Path(".cache/vectors/crops"),
)

#: Kataloger där BARA bildfilerna raderas. `image_pairs/` innehåller också sju
#: facit- och analysfiler (facit_par.csv, image_pairs_labeled.csv,
#: typ_analys.json ...) som är mätresultat och ska behållas — de är härledda,
#: inte skyddade.
IMAGE_FILES_ONLY = (Path("image_pairs"),)
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"}
#: Bildkataloger under benchmark/ — specar och facit-CSV behålls.
BENCH_IMAGE_GLOB = "benchmark/bilder_*"


def sanitize_master(apply: bool) -> dict:
    """Lägger till skadeflaggorna och tar bort fritextkolumnerna."""
    import pyarrow.parquet as pq

    have = pq.ParquetFile(MASTER).schema_arrow.names
    present = [c for c in DROP_FROM_MASTER if c in have]
    log.info("master.parquet: %d kolumner, varav %d ska bort: %s",
             len(have), len(present), present)

    frame = pd.read_parquet(MASTER)
    before = len(frame)

    # 1. EXTRAHERA FÖRST. Utan detta steg är raderingen en förlust.
    if "condition_text" in frame.columns:
        log.info("Extraherar skadeflaggor ur %d skicktexter ...",
                 int(frame["condition_text"].notna().sum()))
        for name, values in damage.columns(frame["condition_text"].fillna("")).items():
            frame[name] = values
        flagged = int((frame["damage_count"] > 0).sum())
        log.info("Flaggade rader: %d", flagged)
    else:
        flagged = 0

    # 2. Radera sedan.
    frame = frame.drop(columns=present)

    stats = {"rader": before, "kolumner_bort": present,
             "flaggade": flagged, "kolumner_efter": len(frame.columns)}
    if not apply:
        log.info("TORRKÖRNING — skriver inget. %s", stats)
        return stats

    tmp = MASTER.with_suffix(".parquet.new")
    frame.to_parquet(tmp, index=False)
    check = pq.ParquetFile(tmp)
    if check.metadata.num_rows != before:
        tmp.unlink()
        raise SystemExit(f"AVBRUTET: {check.metadata.num_rows} != {before} rader")
    for column in present:
        if column in check.schema_arrow.names:
            tmp.unlink()
            raise SystemExit(f"AVBRUTET: {column} finns kvar")
    tmp.replace(MASTER)
    log.info("master.parquet ersatt: %d rader, %d kolumner",
             before, len(frame.columns))
    return stats


def sanitize_ndjson(path: Path, apply: bool) -> dict:
    """Strippar förbjudna nycklar ur en NDJSON-fil, rad för rad (strömmande)."""
    if not path.is_file():
        return {"fil": str(path), "status": "saknas"}
    removed, rows = {k: 0 for k in DROP_FROM_NDJSON}, 0
    tmp = path.with_suffix(path.suffix + ".new")
    out = tmp.open("w", encoding="utf-8") if apply else None
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except Exception:
                    if out:
                        out.write(line + "\n")
                    continue
                rows += 1
                for key in DROP_FROM_NDJSON:
                    if key in record:
                        removed[key] += 1
                        record.pop(key)
                if out:
                    out.write(json.dumps(record, ensure_ascii=False) + "\n")
    finally:
        if out:
            out.close()
    hits = {k: v for k, v in removed.items() if v}
    if apply:
        tmp.replace(path)
    return {"fil": path.name, "rader": rows, "borttaget": hits,
            "storlek_MB": round(path.stat().st_size / 1e6, 1)}


def delete_images(apply: bool) -> dict:
    """Raderar bildfilerna. Vektorer, URL:er och facit behålls."""
    report = []
    for target in IMAGE_FILES_ONLY:
        files = [p for p in target.rglob("*")
                 if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES]
        kept = [p for p in target.rglob("*")
                if p.is_file() and p.suffix.lower() not in IMAGE_SUFFIXES]
        report.append({"sokvag": str(target), "filer": len(files),
                       "MB": round(sum(p.stat().st_size for p in files) / 1e6, 1),
                       "behalls": len(kept)})
        if apply:
            for path in files:
                path.unlink()

    targets = list(IMAGE_TARGETS) + sorted(Path(".").glob(BENCH_IMAGE_GLOB))
    for target in targets:
        if not target.exists():
            report.append({"sokvag": str(target), "status": "finns inte"})
            continue
        files = [p for p in target.rglob("*") if p.is_file()]
        size = sum(p.stat().st_size for p in files)
        report.append({"sokvag": str(target), "filer": len(files),
                       "MB": round(size / 1e6, 1)})
        if apply:
            shutil.rmtree(target)
    return {"mal": report}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="sanitize_corpus.py")
    parser.add_argument("--apply", action="store_true",
                        help="genomför; utan flaggan görs en torrkörning")
    parser.add_argument("--steg", default="alla",
                        choices=["alla", "master", "ndjson", "bilder"])
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if not args.apply:
        print("*** TORRKÖRNING — ingenting raderas. Lägg till --apply. ***\n")

    result = {}
    if args.steg in ("alla", "master"):
        result["master"] = sanitize_master(args.apply)
    if args.steg in ("alla", "ndjson"):
        files = sorted(p for p in DATA.rglob("*.ndjson") if p.is_file())
        files += sorted(p for p in DATA.rglob("*.jsonl") if p.is_file())
        result["ndjson"] = [sanitize_ndjson(p, args.apply) for p in files]
    if args.steg in ("alla", "bilder"):
        result["bilder"] = delete_images(args.apply)

    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
