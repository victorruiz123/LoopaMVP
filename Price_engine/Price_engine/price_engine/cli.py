"""CLI-läge: testa en förfrågan mot riktig data utan att starta servern.

    python -m price_engine.cli "Landskrona" --brand IKEA --condition "gott skick"
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

from . import config
from .condition import build_bands
from .data_loader import load_listings
from .pricing import find_listings, price_query


_MEDIA_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp",
}


def _media_type(path: str) -> str:
    return _MEDIA_TYPES.get(Path(path).suffix.lower(), "image/jpeg")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="price_engine.cli", description="Prisförslag för en begagnad möbel."
    )
    parser.add_argument("name", help="Modellnamn, t.ex. Landskrona")
    parser.add_argument("--brand", default=None, help="Varumärke, t.ex. IKEA")
    parser.add_argument("--condition", default=None, help="Skick, t.ex. 'gott skick'")
    parser.add_argument(
        "--price-kind",
        default=config.DEFAULT_PRICE_KIND,
        choices=["realized", "asking", "auto", "all"],
        help=(
            "realized = faktiskt betalt (auktion), asking = utropspris, "
            f"auto = realized med fallback till asking, all = båda "
            f"(default: {config.DEFAULT_PRICE_KIND})"
        ),
    )
    parser.add_argument("--data", default=None, help="Sökväg till datamappen")
    parser.add_argument(
        "--show", type=int, default=0, metavar="N", help="Visa N exempelannonser"
    )
    parser.add_argument(
        "--variant", action="append", default=None, metavar="TYP",
        help="Möbeltyp, t.ex. hörnsoffa. Upprepa för flera (se --variants)",
    )
    parser.add_argument(
        "--image", default=None, metavar="FIL",
        help="Foto av möbeln — möbeltypen läses ur bilden (kräver API-nyckel)",
    )
    parser.add_argument(
        "--variants", action="store_true",
        help="Skriv ut möbeltyperna och antal annonser per typ",
    )
    parser.add_argument(
        "--bands", action="store_true",
        help="Skriv ut skickbanden som härletts ur datan",
    )
    parser.add_argument("--verbose", action="store_true", help="Logga inläsningen")
    args = parser.parse_args(argv)

    if args.verbose:
        logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    started = time.perf_counter()
    listings = load_listings(args.data)
    multipliers = build_bands(listings)
    load_seconds = time.perf_counter() - started
    price_kind = None if args.price_kind == "all" else args.price_kind

    if args.bands:
        table = multipliers.as_table()
        print(
            table.to_string(index=False) if len(table) else "(inga band)",
            file=sys.stderr,
        )
        print(file=sys.stderr)

    if args.variants:
        counts = listings["variant"].value_counts()
        for label, n in counts.items():
            print(f"  {n:>9,}  {label}", file=sys.stderr)
        print(file=sys.stderr)

    # Explicit --variant vinner över bilden; bilden kostar ett modellanrop.
    image = None
    if args.image and not args.variant:
        image = Path(args.image).read_bytes()

    result = price_query(
        listings,
        name=args.name,
        brand=args.brand,
        condition=args.condition,
        price_kind=price_kind,
        multipliers=multipliers,
        variant=args.variant,
        image=image,
        image_media_type=_media_type(args.image) if args.image else "image/jpeg",
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if args.show:
        # Använd basen som price_query faktiskt landade i, inte flaggan —
        # "auto" är inget värde som finns i datan.
        basis = result["priceBasis"]
        matches = find_listings(
            listings, args.name, args.brand,
            args.condition if config.CONDITION_PRICING else None,
            None if basis == "all" else basis,
        ).nsmallest(args.show, "price")
        print(f"\n{args.show} billigaste träffarna:", file=sys.stderr)
        for row in matches.itertuples():
            print(
                f"  {row.price:>9,.0f} kr  {row.condition or '-':<18} {row.name[:70]}",
                file=sys.stderr,
            )

    print(
        f"\n({len(listings):,} annonser lästa in på {load_seconds:.1f} s)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
