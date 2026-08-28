#!/usr/bin/env python
"""Bygger priscellerna: märke x produkttyp x modell x konfiguration.

    python build_price_cells.py

Kör grupperingen över hela korpusen och skriver `type_system/price_cells.parquet`
med en rad per annons och dess cellnyckel, plus alla flaggor.

**Ingen rad raderas någonsin.** Rader flyttas till rätt cell eller flaggas.
Tillbehör och jämförelser hålls utanför produktens priscell men finns kvar med
`excluded=True`, så de går att granska.
"""

from __future__ import annotations

import argparse
import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import pandas as pd

from price_engine.data_loader import load_listings
from type_system import grouping, model_tokens

log = logging.getLogger("celler")
OUT = Path("type_system/price_cells.parquet")

#: Krympningshierarkin när cellen blir tunn. Nivå 0 är den finaste.
LEVELS = ("full", "utan_konfiguration", "marke_x_typ", "typ_x_kategori")
MIN_CELL = 30


def build(listings: pd.DataFrame) -> pd.DataFrame:
    log.info("Klassificerar %d rubriker ...", len(listings))
    records = []
    for name in listings["name"].fillna("").astype(str):
        g = grouping.classify(name)
        records.append((g.product_type, g.product_type_source,
                        g.product_type_confidence, g.is_bundle,
                        g.has_bundle_connector, g.is_accessory_only,
                        g.is_comparison, g.is_section, g.is_giveaway,
                        g.is_damaged, g.mentions_retail_price, g.seats, g.size,
                        len(g.types)))
    frame = pd.DataFrame(records, columns=[
        "product_type", "product_type_source", "product_type_confidence",
        "is_bundle", "has_bundle_connector", "is_accessory_only",
        "is_comparison", "is_section", "is_giveaway", "is_damaged",
        "mentions_retail_price", "seats", "size", "n_types"])
    for column in ("name", "name_norm", "search_blob", "price", "price_kind",
                   "brand_norm", "source", "derived_type"):
        if column in listings.columns:
            frame[column] = listings[column].to_numpy()

    # Märket ur RUBRIKEN, inte ur brand_norm: den kolumnen är tom i 97,7 % av
    # korpusen. 603 Madison-rader nämner "mio" men bara 74 har brand_norm satt.
    #
    # Modellnyckeln är den SORTERADE MÄNGDEN distinktiva ord, med märkesorden
    # borttagna. Att ta första ordet gjorde nyckeln ordningsberoende — "Mio
    # Madison" fick `mio` och "Madison Mio" fick `madison`, så samma produkt
    # hamnade i olika celler.
    pairs, brandless = grouping.model_names()
    if not pairs and not brandless:
        raise SystemExit("config/model_names.json saknas — kör build_model_names.py")
    log.info("Vitlista: %d par över %d märken, %d märkeslösa",
             sum(len(w) for w in pairs.values()), len(pairs), len(brandless))
    token_lists = [grouping.tokens(n) for n in frame["name"].fillna("").astype(str)]
    frame["brand_key"] = [grouping.brand_of(t) or "" for t in token_lists]
    frame["model_key"] = [grouping.model_key(t, None, b or None)
                          for t, b in zip(token_lists, frame["brand_key"])]

    log.info("Majoritetstilldelning ...")
    kinds, sources, confidences, bundles, majorities = grouping.resolve(frame)
    frame["product_type"] = kinds
    frame["product_type_source"] = sources
    frame["product_type_confidence"] = confidences
    frame["is_bundle"] = bundles
    log.info("Majoriteter: %d märke+modell-par", len(majorities))

    # `is_section` MÅSTE ingå. Den skrevs tidigare varken till filen eller till
    # `excluded`, så lösa sektioner låg kvar i basproduktens cell trots att
    # klassificeringen flaggade dem — flaggan fanns bara i minnet.
    frame["excluded"] = (frame["is_accessory_only"] | frame["is_comparison"]
                         | frame["is_section"])
    frame["config_key"] = [
        "-".join(str(p) for p in (s, z) if p and not pd.isna(p)) or ""
        for s, z in zip(frame["seats"], frame["size"])]

    # Buntar får egen celltyp och blandas aldrig med basprodukten. En bunt utan
    # känd bastyp får `bunt:okand_bastyp` — inte `bunt:None`, som både ser ut
    # som en bugg och slår ihop olika sorters buntar.
    frame["cell_type"] = [
        (f"bunt:{t}" if t else "bunt:okand_bastyp") if b else (t or "okand")
        for t, b in zip(frame["product_type"], frame["is_bundle"])]
    frame["cell_full"] = (frame["brand_key"] + "|" + frame["cell_type"]
                          + "|" + frame["model_key"] + "|" + frame["config_key"])
    frame["cell_no_config"] = (frame["brand_key"] + "|" + frame["cell_type"]
                               + "|" + frame["model_key"])

    # Buntar krymper ALDRIG förbi modellnivån. "Madison med fotpall" och
    # "Kivik med schäslong" är olika produkter, och att slå ihop dem på
    # märke+typ hade gett en cell som inte betyder någonting.
    frame["cell_brand_type"] = [
        no_config if bundle else f"{brand}|{kind}"
        for no_config, bundle, brand, kind in zip(
            frame["cell_no_config"], frame["is_bundle"],
            frame["brand_key"], frame["cell_type"])]
    frame["cell_type_only"] = [
        no_config if bundle else kind
        for no_config, bundle, kind in zip(
            frame["cell_no_config"], frame["is_bundle"], frame["cell_type"])]
    return frame, majorities


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="build_price_cells.py")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    frame, majorities = build(listings)
    args.out.parent.mkdir(exist_ok=True)
    frame.to_parquet(args.out, index=False)

    usable = frame[~frame["excluded"] & frame["price"].gt(0)]
    print(f"\nrader totalt              {len(frame):,}")
    print(f"typ utskriven (explicit)  {(frame['product_type_source']=='explicit').sum():,}")
    print(f"typ ur majoritet          {(frame['product_type_source']=='majoritet').sum():,}")
    print(f"typ okänd                 {frame['product_type'].isna().sum():,}")
    print(f"\nbuntar                    {frame['is_bundle'].sum():,}")
    print(f"tillbehör (utesluts)      {frame['is_accessory_only'].sum():,}")
    print(f"jämförelser (utesluts)    {frame['is_comparison'].sum():,}")
    print(f"lösa sektioner (utesluts) {frame['is_section'].sum():,}")
    print(f"bortskänkes               {frame['is_giveaway'].sum():,}")
    print(f"skadad/sliten             {frame['is_damaged'].sum():,}")
    print(f"nämner nypris             {frame['mentions_retail_price'].sum():,}")
    print(f"\nanvändbara för priscell   {len(usable):,}")

    for level, column in zip(LEVELS, ("cell_full", "cell_no_config",
                                      "cell_brand_type", "cell_type_only")):
        sizes = usable.groupby(column).size()
        big = sizes[sizes >= MIN_CELL]
        print(f"  {level:<20} celler {len(sizes):>7,}   "
              f"med n>={MIN_CELL}: {len(big):>6,}   "
              f"andel data {big.sum()/len(usable)*100:>5.1f} %")

    Path("type_system/majorities.json").write_text(json.dumps(
        {"|".join(k): v for k, v in majorities.items()},
        ensure_ascii=False, indent=1))
    print(f"\nskrivet till {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
