#!/usr/bin/env python
"""Fas 5 — validera att bildlikheten faktiskt fungerar på din data.

Två lägen, båda avsedda att köras INNAN bildsök kopplas in i API:et.

**Ögna-läge** — vad tycker modellen är likt?

    python validate_images.py peek min_soffa.jpg
    python validate_images.py peek min_soffa.jpg --name Madison --brand Mio

Skriver ut de 20 mest lika annonserna med likhetspoäng, pris, namn och märke.
Utan --name jämförs mot hela beståndet; med --name mot samma kandidatmängd
som prismotorn skulle använda, vilket är det som faktiskt betyder något.

**Trösklingsläge** — var går gränsen?

    python validate_images.py pairs mina_par.csv

CSV med tre kolumner utan rubrik: `bild_a,bild_b,etikett` där etikett är
`samma` eller `olika`. Märk upp tio par av varje för hand — tio par som är
samma variant, tio som är samma modell men olika utförande.

Verktyget rapporterar poängfördelningen per grupp, föreslår den tröskel som
bäst separerar dem, och visar hur stort överlappet är. Det är enda sättet att
sätta tröskeln på riktigt i stället för att gissa; hårdkoda ingenting innan
detta körts.
"""

from __future__ import annotations

import argparse
import csv
import logging
import warnings
import json
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
from PIL import Image

from price_engine import config, vision
from price_engine.data_loader import load_listings
from price_engine.vectors import load_vectors

log = logging.getLogger("validate")


def _query(path: str) -> tuple:
    image = Image.open(path).convert("RGB")
    return vision.prepare_one(image)


def peek(args) -> int:
    store = load_vectors()
    if not store.ready:
        print("Inget vektorlager. Kör embed_images.py först.")
        return 1

    listings = load_listings()
    if args.name:
        from price_engine.pricing import find_listings

        listings = find_listings(listings, args.name, args.brand, None, args.price_kind)
        print(f"Kandidater efter namn/märke: {len(listings):,}")

    rows = store.rows_for(listings)
    have = rows >= 0
    listings, rows = listings[have], rows[have]
    if not len(listings):
        print("Ingen av kandidaterna har en embeddad bild.")
        return 1

    qv, qc, cropped = _query(args.image)
    print(f"Frågebilden: {'beskuren till möbeln' if cropped else 'ingen möbel hittad, hel bild'}")

    scores = vision.similarity(
        qv, qc, store.embeddings[rows], store.colors[rows], args.color_weight
    )
    order = np.argsort(-scores)[: args.top]

    print(f"\nDe {len(order)} mest lika av {len(listings):,} med bild:\n")
    print(f"  {'poäng':>6}  {'pris':>9}  {'märke':<12} namn")
    print("  " + "-" * 74)
    for i in order:
        row = listings.iloc[i]
        print(f"  {scores[i]:>6.3f}  {row['price']:>8,.0f} kr  "
              f"{str(row.get('brand') or '-')[:11]:<12} {str(row['name'])[:44]}")
    print(f"\n  poängspann i hela kandidatmängden: "
          f"{scores.min():.3f} – {scores.max():.3f}, median {np.median(scores):.3f}")
    return 0


def pairs(args) -> int:
    """Mäter bildtröskeln mot TEXTBASERAT facit ur databasen.

    Handmärkningen underkändes i stickprov — att bedöma "samma möbel?" ur två
    foton är subjektivt. Databasen vet redan svaret: två annonser vars titlar
    bär samma märke OCH samma modellnamn visar samma modell. Se
    image_pair_facit.py.
    """
    import numpy as np
    import pandas as pd

    from price_engine import images as image_store
    from price_engine.data_loader import load_listings
    import image_pair_facit as facit

    store = load_vectors()
    if not store.ready:
        log.error("Inga vektorer — kör embed_images.py först")
        return 1

    listings = load_listings()
    annotated = facit.annotate(listings, store)
    frame = facit.build_pairs(annotated, store, per_class=args.per_class)
    if frame.empty:
        log.error("Inga par kunde byggas")
        return 1

    # Skärmdumpar bort. De ligger i bilddatan som annonsbilder och embeddas
    # som möbler; fyra av 128 handmärkta par hade en sådan i ena änden.
    urls = pd.concat([frame["a_url"], frame["b_url"]]).dropna().drop_duplicates()
    image_store.prefetch(pd.DataFrame({"image_url": urls}))
    shots = set()
    for url in urls:
        path = image_store.cache_path(image_store.normalize_url(url))
        if path.is_file() and facit.is_screenshot(path):
            shots.add(url)
    before = len(frame)
    frame = frame[~frame["a_url"].isin(shots) & ~frame["b_url"].isin(shots)]
    log.info("Skärmdumpar: %d bilder, %d par bortsorterade",
             len(shots), before - len(frame))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(out, index=False)

    report = {"pairs": int(len(frame)), "screenshots_found": len(shots),
              "screenshot_pairs_removed": int(before - len(frame)),
              "per_variant": {}}
    positives = ("samma_modell",)

    def measure(group: pd.DataFrame) -> dict:
        pos = group[group["label"] == "samma_modell"]["similarity"].to_numpy()
        neg = group[group["label"] == "olika_modell"]["similarity"].to_numpy()
        if len(pos) < 20 or len(neg) < 20:
            return {"status": "för litet underlag",
                    "n_pos": int(len(pos)), "n_neg": int(len(neg))}

        # AUC via Mann-Whitney: andelen (positiv, negativ)-par där den positiva
        # har högre likhet. 0,5 = ingen separation alls.
        auc = float((pos[:, None] > neg[None, :]).mean()
                    + 0.5 * (pos[:, None] == neg[None, :]).mean())
        best = None
        for threshold in np.unique(np.round(group["similarity"], 2)):
            tp = int((pos >= threshold).sum()); fp = int((neg >= threshold).sum())
            sens = tp / len(pos); spec = 1 - fp / len(neg)
            j = sens + spec - 1
            if best is None or j > best["j"]:
                best = {"threshold": round(float(threshold), 2), "j": round(j, 3),
                        "sensitivity": round(sens, 3), "specificity": round(spec, 3),
                        "false_positives": fp, "false_negatives": len(pos) - tp}
        return {
            "status": "ok", "n_pos": int(len(pos)), "n_neg": int(len(neg)),
            "auc": round(auc, 3),
            "median_pos": round(float(np.median(pos)), 3),
            "median_neg": round(float(np.median(neg)), 3),
            "p10_p90_pos": [round(float(np.percentile(pos, 10)), 3),
                            round(float(np.percentile(pos, 90)), 3)],
            "p10_p90_neg": [round(float(np.percentile(neg, 10)), 3),
                            round(float(np.percentile(neg, 90)), 3)],
            **best,
            "false_positives_at_045": int((neg >= 0.45).sum()),
            "positives_below_045": int((pos < 0.45).sum()),
        }

    report["overall"] = measure(frame)
    for variant, group in frame.groupby("variant", observed=True):
        entry = measure(group)
        for detail in ("samma_modell_samma_variant", "samma_modell_annan_variant"):
            subset = group[group["label_detail"] == detail]["similarity"]
            if len(subset) >= 10:
                entry[detail] = {"n": int(len(subset)),
                                 "median": round(float(subset.median()), 3)}
        report["per_variant"][str(variant)] = entry

    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="validate_images.py")
    sub = parser.add_subparsers(dest="läge", required=True)

    p = sub.add_parser("peek", help="Visa de mest lika annonserna för en bild")
    p.add_argument("image")
    p.add_argument("--name", default=None, help="Begränsa till modellnamn")
    p.add_argument("--brand", default=None)
    p.add_argument("--price-kind", default="asking")
    p.add_argument("--top", type=int, default=20)
    p.add_argument("--color-weight", type=float, default=None)
    p.set_defaults(func=peek)

    p = sub.add_parser("pairs", help="Mät bildtröskeln mot textbaserat facit")
    p.add_argument("--per-class", type=int, default=500,
                   help="Mål för antal par per klass och möbeltyp")
    p.add_argument("--out", default="image_pairs/facit_par.csv")
    p.add_argument("--report", default="image_pairs/facit_analys.json")
    p.add_argument("--color-weight", type=float, default=None)
    p.set_defaults(func=pairs)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
