#!/usr/bin/env python
"""Kanariefågeln: åldras korpusen ur färskhetsfönstret?

    python corpus_health.py
    python corpus_health.py --benchmark        # kör även de 35 benchmarkfrågorna

Färskhetsfiltret behåller annonser inom `RECENCY_MONTHS` månader bakåt från
IDAG. Fönstret rör sig; korpusen gör det inte. När den dominerande källan
passerar bakom gränsen slutar filtret filtrera och varje sökning faller till
`extended`-läget, som tar de N senaste oavsett ålder.

Då dör funktionen **tyst**. Motorn svarar precis som förut, men på gamla priser
i en fallande marknad — alltså systematisk ÖVERprisning. Ingenting i svaret
skriker; `recencyMethod` byter bara värde.

Den här mätaren gör bytet synligt. Kör den regelbundet, och efter varje ny
datainläsning.

Nivåer, på andelen svar som föll till `extended`:

    < 30 %   GRÖNT   filtret arbetar
    30-60 %  GULT    fönstret börjar tömmas — planera datainsamling
    > 60 %   RÖTT    filtret är i praktiken ur funktion
"""

from __future__ import annotations

import argparse
import json
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import pandas as pd

from price_engine import config
from price_engine.data_loader import load_listings

log = logging.getLogger("halsa")
OUT = Path("type_system/corpus_health.json")

GREEN, YELLOW = 0.30, 0.60


def level(share: float) -> str:
    if share > YELLOW:
        return "ROTT"
    if share > GREEN:
        return "GULT"
    return "GRONT"


def window(listings: pd.DataFrame) -> tuple:
    now = pd.Timestamp.now(tz="UTC")
    return now, now - pd.DateOffset(months=config.RECENCY_MONTHS)


def per_source(listings: pd.DataFrame, cutoff) -> pd.DataFrame:
    rows = []
    for source, group in listings.groupby("source"):
        fresh = int((group["listed_at"] >= cutoff).sum())
        latest = group["listed_at"].max()
        rows.append({
            "kalla": source,
            "rader": len(group),
            "senaste": latest.date().isoformat() if pd.notna(latest) else None,
            "inom_fonster": fresh,
            "andel_fardk": round(fresh / len(group), 4) if len(group) else 0.0,
            # Dagen då den här källans FÄRSKASTE rad faller ur fönstret. Efter
            # den dagen kan källan aldrig mer bidra med en färsk annons.
            "utgangsdatum": ((latest + pd.DateOffset(months=config.RECENCY_MONTHS))
                             .date().isoformat() if pd.notna(latest) else None),
        })
    return pd.DataFrame(rows).sort_values("rader", ascending=False)


def per_type(listings: pd.DataFrame, cutoff) -> pd.DataFrame:
    """Färska rader per möbeltyp. En totalsiffra döljer att en typ kan vara död
    medan en annan är frisk — och det är per typ motorn söker."""
    column = "derived_type" if "derived_type" in listings.columns else "variant"
    rows = []
    fresh_all = listings[listings["listed_at"] >= cutoff]
    for kind, group in listings.groupby(column):
        fresh = int((group["listed_at"] >= cutoff).sum())
        rows.append({"typ": str(kind), "rader": len(group), "farska": fresh,
                     "andel": round(fresh / len(group), 4) if len(group) else 0.0,
                     "under_golvet": fresh < config.RECENCY_MIN_LISTINGS})
    del fresh_all
    return pd.DataFrame(rows).sort_values("rader", ascending=False)


def benchmark_recency(listings: pd.DataFrame) -> dict:
    """Hur många av de 35 benchmarkfrågorna faller till `extended`?

    Det är det enda måttet som säger vad som händer i praktiken — andelen färska
    RADER kan vara låg medan de råkar ligga just där frågorna söker, eller
    omvänt.
    """
    from evaluate_examples import core_name
    from price_engine.condition import build_bands
    from price_engine.pricing import price_query

    bands = build_bands(listings)
    counts: dict = {}
    rows = []
    for tag in ("11", "b1", "b2"):
        path = Path(f"benchmark/items_{tag}.json")
        if not path.is_file():
            continue
        for item in json.loads(path.read_text()):
            model = item.get("model")
            kind = str(item.get("variant") or item.get("category") or "").strip()
            if not model:
                name = kind
            elif not item.get("brand"):
                name = model
            else:
                name = core_name(model)
            full = " ".join(p for p in (model or "", kind) if p).strip() or name
            answer = price_query(listings, name=name, brand=item.get("brand"),
                                 attribute_text=full, multipliers=bands,
                                 image_rerank=False)
            method = answer.get("recencyMethod") or "none"
            counts[method] = counts.get(method, 0) + 1
            rows.append({"id": f"{tag}#{item['nr']}",
                         "mobel": item.get("label") or f"{item.get('brand')} {model}",
                         "recency": method, "n": answer.get("matchCount"),
                         "confidence": answer.get("confidence")})
    total = sum(counts.values()) or 1
    extended = counts.get("extended", 0)
    return {"per_metod": counts, "andel_extended": round(extended / total, 4),
            "niva": level(extended / total), "per_mobel": rows}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="corpus_health.py")
    parser.add_argument("--benchmark", action="store_true",
                        help="kör de 35 benchmarkfrågorna och mät recencyMethod")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")

    listings = load_listings()
    now, cutoff = window(listings)
    sources = per_source(listings, cutoff)
    types = per_type(listings, cutoff)
    fresh_total = int((listings["listed_at"] >= cutoff).sum())
    fresh_share = fresh_total / len(listings)

    print(f"idag {now.date()}   färskhetsfönster {config.RECENCY_MONTHS} mån "
          f"-> gräns {cutoff.date()}")
    print(f"korpus {len(listings):,} rader, varav {fresh_total:,} färska "
          f"({fresh_share*100:.1f} %)\n")

    print(f"{'källa':<12}{'rader':>10}{'senaste':>13}{'färska':>10}"
          f"{'andel':>8}   utgår ur fönstret")
    for row in sources.itertuples():
        flag = "  <-- UTE" if row.inom_fonster == 0 else ""
        print(f"{row.kalla:<12}{row.rader:>10,}{str(row.senaste):>13}"
              f"{row.inom_fonster:>10,}{row.andel_fardk*100:>7.1f}%"
              f"   {row.utgangsdatum}{flag}")

    dead = types[types["under_golvet"] & types["rader"].gt(1000)]
    print(f"\nmöbeltyper med >1 000 rader men färre än "
          f"{config.RECENCY_MIN_LISTINGS} färska: {len(dead)}")
    for row in dead.head(12).itertuples():
        print(f"   {row.typ:<20}{row.rader:>8,} rader{row.farska:>6} färska")

    payload = {
        "kord": now.isoformat(),
        "recency_months": config.RECENCY_MONTHS,
        "cutoff": cutoff.date().isoformat(),
        "rader": len(listings),
        "farska_rader": fresh_total,
        "andel_farska": round(fresh_share, 4),
        "per_kalla": sources.to_dict("records"),
        "typer_under_golvet": int(len(dead)),
    }

    if args.benchmark:
        print("\nkör de 35 benchmarkfrågorna ...")
        bench = benchmark_recency(listings)
        payload["benchmark"] = bench
        print(f"\nrecencyMethod över benchmarken: {bench['per_metod']}")
        print(f"andel extended: {bench['andel_extended']*100:.1f} %"
              f"   NIVÅ: {bench['niva']}")
    else:
        # Utan benchmarken går nivån inte att sätta på det som faktiskt händer.
        # Andelen färska RADER är en proxy, och den ska märkas som en proxy.
        payload["niva_proxy"] = level(1.0 - fresh_share)
        print(f"\nNIVÅ (proxy på radandel, kör --benchmark för det riktiga måttet): "
              f"{payload['niva_proxy']}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=1))
    print(f"\nskrivet till {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
