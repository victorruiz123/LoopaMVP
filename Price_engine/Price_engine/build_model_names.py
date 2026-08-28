#!/usr/bin/env python
"""Bygger den VALIDERADE modellnamnslistan — vitlistan för modellnyckeln.

    python build_model_names.py

Modellnyckeln fick tidigare innehålla varje distinktivt ord i rubriken. Följden
var att Mio Madison-soffor splittrades på **58 celler**: `3-sits madison`,
`lux madison`, `fri leverans madison`, `madison transport`. Konfigord,
logistikord och adjektiv blev delar av modellnamnet.

En svartlista över dåliga ord blir aldrig komplett. Den här listan är i stället
en **vitlista byggd på evidens**: modellnyckeln får bara innehålla ord som klarar
ett mätbart test.

**Testet.** Ett riktigt modellnamn hör till EN produkt och koncentreras därför
till en produkttyp. Ett brusord sprids över alla:

    madison    -> nästan bara soffor      -> modellnamn
    lux        -> soffor, bord, sängar    -> adjektiv
    leverans   -> allt                    -> logistik

Kriteriet är alltså inte "ovanligt ord" utan "ord som förutsäger produkttypen".
Det går att mäta, och det behöver inte underhållas när nya adjektiv dyker upp.
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import pandas as pd

from price_engine.data_loader import load_listings
from type_system import grouping, model_tokens

log = logging.getLogger("modellnamn")
OUT = Path("config/model_names.json")

#: Minsta antal annonser för att ordet ska gå att bedöma alls.
MIN_LISTINGS = 12
#: Andelen av ordets annonser som måste dela produkttyp.
MIN_TYPE_SHARE = 0.60
#: Samma sak på FAMILJENIVÅ. Ett modellnamn hör till en familj men kan finnas i
#: flera varianter inom den — Ektorp är soffa, bäddsoffa, fåtölj och fotpall, och
#: föll på 0,59 i fin typ trots att den är ett självklart modellnamn. Familjen
#: är det rätta måttet på "hör ordet till en produkt"; den fina typen avgör
#: bara vilken cell raden hamnar i.
MIN_FAMILY_SHARE = 0.75
#: Ett ord som förekommer i tiotusentals annonser är ett vanligt ord, inte ett
#: modellnamn — oavsett hur koncentrerat det ser ut.
MAX_LISTINGS = 40_000

#: TREDJE kriteriet: ett modellnamn hör till ETT märke. Ett vanligt ord gör inte
#: det. Mätt: ektorp 1,00 / lamino 1,00 / madison 0,94 mot chair 0,38 / rygg 0,31
#: / stoppad 0,27 / table 0,58.
#:
#: Behövdes eftersom familjekriteriet — som räddade Ektorp — släppte in varje
#: möbelnära vardagsord: `rygg` har typkoncentration 0,29 men familjeandel 0,99,
#: för ryggar hör till stolar. Alla 20 celler med störst prisspridning orsakades
#: av sådana ord.
MIN_BRAND_SHARE = 0.80
#: Under så här många märkta annonser går ordet inte att bedöma på märke.
MIN_BRAND_LISTINGS = 10


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="build_model_names.py")
    parser.add_argument("--min-share", type=float, default=MIN_TYPE_SHARE)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    log.info("Klassificerar %d rubriker ...", len(listings))
    titles = listings["name"].fillna("").astype(str)
    token_lists, types = [], []
    for title in titles:
        g = grouping.classify(title)
        token_lists.append(g.tokens)
        types.append(g.product_type)

    candidates = model_tokens.distinctive(listings["name_norm"], MIN_LISTINGS,
                                          MAX_LISTINGS)
    brands = set(grouping._brand_lookup())
    type_words = {w for words in grouping.vocab()["product_types"].values()
                  for w in words}
    signals = {w for group in grouping._signals().values() for w in group}
    # Manuell stopplista för ord som märkeskoncentrationen inte kan fälla:
    # `lux` är 0,98 Mio och `fri` 0,84 Mio, men det ena är ett adjektiv och det
    # andra halva "fri leverans". Automatiken ser bara att Mio dominerar.
    stoplist = grouping.vocab().get("model_name_stoplist") or {}
    log.info("Kandidater: %d", len(candidates))

    family_of = {t: fam for fam, kinds in grouping.vocab()["families"].items()
                 for t in kinds}
    counts: dict = collections.defaultdict(collections.Counter)
    fams: dict = collections.defaultdict(collections.Counter)
    brand_counts: dict = collections.defaultdict(collections.Counter)
    totals: collections.Counter = collections.Counter()
    for toks, kind in zip(token_lists, types):
        brand = grouping.brand_of(toks)
        for token in set(toks):
            if token not in candidates:
                continue
            totals[token] += 1
            if kind:
                counts[token][kind] += 1
                fams[token][family_of.get(kind, "ovrigt")] += 1
            if brand:
                brand_counts[token][brand] += 1

    accepted, rejected = {}, {}
    pairs: dict = {}
    brandless: list = []
    for token, total in totals.items():
        # Ord som ÄR en produkttyp, ett märke eller en signal är per definition
        # inte modellnamn, hur koncentrerade de än är.
        if token in brands or token in type_words or token in signals:
            rejected[token] = "ordlista"
            continue
        if token.isdigit() or token.endswith("-sits") or "x" in token[1:-1]:
            rejected[token] = "konfig"
            continue
        counter = counts.get(token)
        if not counter:
            rejected[token] = "ingen typ"
            continue
        typed = sum(counter.values())
        kind, count = counter.most_common(1)[0]
        share = count / typed
        fam_counter = fams.get(token) or collections.Counter()
        fam_total = sum(fam_counter.values()) or 1
        family, fam_count = (fam_counter.most_common(1)[0]
                             if fam_counter else ("ovrigt", 0))
        fam_share = fam_count / fam_total

        if typed < MIN_LISTINGS:
            rejected[token] = f"för få typade ({typed})"
            continue

        entry = {"type": kind, "share": round(share, 3), "family": family,
                 "family_share": round(fam_share, 3), "n": int(total)}
        brands_seen = brand_counts.get(token) or collections.Counter()
        brand_total = sum(brands_seen.values())

        if token in stoplist:
            rejected[token] = f"stopplista: {stoplist[token]}"
            continue

        if brand_total >= MIN_BRAND_LISTINGS:
            # Ordet GÅR att bedöma på märke. Då avgör märkeskoncentrationen,
            # och resultatet blir ett (märke, ord)-PAR: "stand" är ett
            # modellnamn när HAY står i annonsen, aldrig annars. Cellen
            # `|okand|stand` kan därmed inte uppstå.
            top_brand, count = brands_seen.most_common(1)[0]
            brand_share = count / brand_total
            if brand_share < MIN_BRAND_SHARE:
                rejected[token] = (f"sprids över märken ({brand_share:.2f}, "
                                   f"{len(brands_seen)} märken)")
                continue
            entry.update(brand=top_brand, brand_share=round(brand_share, 3),
                         brand_n=int(brand_total))
            pairs.setdefault(top_brand, []).append(token)
            accepted[token] = entry
        elif share >= args.min_share and fam_share >= MIN_FAMILY_SHARE:
            # Går INTE att bedöma på märke. Då krävs BÅDA de gamla kriterierna,
            # inte ettdera — annars släpps orden in som familjekriteriet ensamt
            # godkände, och det var precis de som förorenade cellerna.
            entry["brand"] = None
            brandless.append(token)
            accepted[token] = entry
        else:
            rejected[token] = (f"omärkt och klarar inte båda ({share:.2f} / "
                               f"{fam_share:.2f})")

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(
        {"pairs": {b: sorted(w) for b, w in sorted(pairs.items())},
         "brandless": sorted(brandless),
         "detail": accepted},
        ensure_ascii=False, indent=1, sort_keys=True))

    print(f"\nkandidater      {len(totals):,}")
    print(f"godkända        {len(accepted):,}")
    print(f"   som (märke, ord)-par  {sum(len(w) for w in pairs.values()):,} "
          f"över {len(pairs)} märken")
    print(f"   utan märke            {len(brandless):,}")
    print(f"förkastade      {len(rejected):,}")
    reasons = collections.Counter(
        r.split(" (")[0] for r in rejected.values())
    for reason, n in reasons.most_common():
        print(f"   {reason:<24}{n:>7,}")

    print("\nkontroll mot kända ord:")
    for word in ("madison", "ektorp", "kivik", "lamino", "strandmon", "bjursta",
                 "lux", "fri", "leverans", "transport", "amp", "ny", "fint"):
        if word in accepted:
            a = accepted[word]
            brand = a.get("brand")
            tag = (f"märke={brand} {a.get('brand_share', 0):.2f}"
                   if brand else "utan märke")
            print(f"   {word:<12}GODKÄNT   typ={a['type']:<10} "
                  f"andel={a['share']:.2f}  familj={a['family_share']:.2f}  {tag}")
        else:
            print(f"   {word:<12}förkastat ({rejected.get(word, 'ej kandidat')})")
    print(f"\nskrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
