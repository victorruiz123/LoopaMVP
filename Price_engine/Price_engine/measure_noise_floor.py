#!/usr/bin/env python
"""Brusgolvet: hur nära facit kan en prismotor teoretiskt komma?

    python measure_noise_floor.py

En träffsäkerhet på 73 % säger ingenting förrän man vet vad taket är. Två
annonser om SAMMA möbel — samma rubrik, samma modell, samma skick — sätts av två
olika säljare till olika pris. Den spridningen är inte ett motorfel. Den är
marknadens egen brusnivå, och ingen modell kan komma under den.

Golvet mäts på dubblettgrupper: rader vars normaliserade rubrik är identisk.
Inom en sådan grupp är produkten densamma per konstruktion, så all kvarvarande
prisspridning är brus.

Två tal rapporteras:

  spridning     p75/p25 inom gruppen — hur brett marknaden själv sätter priset
  träffandel    hur ofta en ENSKILD annons i gruppen ligger inom gruppens eget
                p30-p60-band. Det är den övre gränsen för "default inom facit"
                när facit är lika brett som motorns intervall.
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

from price_engine.data_loader import load_listings

log = logging.getLogger("brusgolv")
OUT = Path("type_system/noise_floor.json")
MIN_GROUP = 5


def _named_only(groups: pd.DataFrame) -> pd.DataFrame:
    """Rader vars rubrik innehåller ett validerat modellnamn ur vitlistan.

    Vitlistan är (märke, ord)-par plus märkeslösa ord, byggd på mätt
    märkeskoncentration. Ett ord där betyder "hör till en produkt", vilket är
    precis kravet för att en dubblettgrupp ska vara samma produkt.
    """
    from type_system import grouping

    pairs, brandless = grouping.model_names()
    allowed = set(brandless) | {w for words in pairs.values() for w in words}
    if not allowed:
        log.warning("Vitlistan saknas — kör build_model_names.py")
        return groups.iloc[0:0]

    def has_model(title: str) -> bool:
        return any(t in allowed for t in grouping.tokens(title or ""))

    unique = groups["name"].drop_duplicates()
    good = {t for t in unique if has_model(t)}
    return groups[groups["name"].isin(good)]


def _sigma(frame: pd.DataFrame) -> float:
    """Logspridningen INOM grupp: avvikelsen från gruppens egen logmedel."""
    if not len(frame):
        return float("nan")
    logp = np.log(frame["price"].to_numpy(float))
    inner = pd.Series(logp).groupby(frame["name_norm"].to_numpy()).transform(
        lambda s: s - s.mean())
    return float(np.std(inner.to_numpy(), ddof=1))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_noise_floor.py")
    parser.add_argument("--min-group", type=int, default=MIN_GROUP)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    frame = listings[listings["price"].gt(0) & listings["name_norm"].notna()]
    log.info("Rader med pris: %d", len(frame))

    sizes = frame.groupby("name_norm").size()
    keep = sizes[sizes >= args.min_group].index
    groups = frame[frame["name_norm"].isin(keep)]
    log.info("Dubblettgrupper (n>=%d): %d rader i %d grupper",
             args.min_group, len(groups), len(keep))

    # --- den ÄRLIGA delmängden -------------------------------------------
    # "Identisk rubrik" är ett för svagt kriterium för "samma produkt". Rubriken
    # "Matbord" är identisk mellan tusen OLIKA bord, och sådana grupper blåser
    # upp spridningen med produktvariation som INTE är brus. Det ger ett för
    # lågt tak och därmed en för bekväm slutsats om hur nära taket vi ligger.
    #
    # Delmängden där "samma produkt" faktiskt gäller är grupper vars rubrik
    # innehåller ett validerat modellnamn. Båda populationerna rapporteras.
    named = _named_only(groups)
    log.info("Varav med validerat modellnamn: %d rader i %d grupper",
             len(named), named["name_norm"].nunique() if len(named) else 0)

    stats = groups.groupby("name_norm")["price"].agg(
        n="size", median="median",
        p25=lambda s: s.quantile(0.25), p75=lambda s: s.quantile(0.75),
        p30=lambda s: s.quantile(0.30), p60=lambda s: s.quantile(0.60))
    stats = stats[stats["median"].gt(0)]
    stats["spread"] = (stats["p75"] - stats["p25"]) / stats["median"]

    # Träffandelen: hur ofta en enskild annons hamnar inom gruppens eget
    # p30-p60. Det är precis vad motorn försöker göra — peka ut ett band som
    # råkar innehålla just den här möbelns rätta pris.
    joined = groups.join(stats[["p30", "p60", "median"]], on="name_norm",
                         rsuffix="_grupp")
    inside = ((joined["price"] >= joined["p30"])
              & (joined["price"] <= joined["p60"])).mean()

    # Och mot ett facit av benchmarkens bredd: facitintervallen är i median
    # 2,0x från låg till hög kant. Andelen annonser inom medianen +/- den
    # bredden är den övre gränsen för "default inom facit".
    ratio = joined["price"] / joined["median"]
    for width in (1.5, 2.0, 2.5):
        low, high = 1 / np.sqrt(width), np.sqrt(width)
        share = float(((ratio >= low) & (ratio <= high)).mean())
        print(f"   facitbredd {width:.1f}x  ->  tak {share*100:.1f} %")

    sigma_all, sigma_named = _sigma(groups), _sigma(named)
    print(f"\n=== logspridning inom grupp, tva populationer ===")
    print(f"   {'population':<34}{'grupper':>9}{'rader':>10}{'sigma':>8}{'p75/p25':>9}")
    for label, part, sig in (("alla identiska rubriker", groups, sigma_all),
                             ("med validerat modellnamn", named, sigma_named)):
        n_groups = part["name_norm"].nunique() if len(part) else 0
        ratio = np.exp(1.349 * sig) if sig == sig else float("nan")
        print(f"   {label:<34}{n_groups:>9,}{len(part):>10,}"
              f"{sig:>8.3f}{ratio:>8.2f}x")

    payload = {
        "sigma_alla": round(sigma_all, 4),
        "sigma_med_modellnamn": round(sigma_named, 4) if sigma_named == sigma_named else None,
        "grupper_med_modellnamn": int(named["name_norm"].nunique()) if len(named) else 0,
        "rader_med_modellnamn": int(len(named)),
        "grupper": int(len(stats)),
        "rader": int(len(groups)),
        "min_group": args.min_group,
        "spridning_p75_p25_median": round(float(stats["spread"].median()), 4),
        "spridning_p75_p25_medel": round(float(stats["spread"].mean()), 4),
        "andel_inom_egen_p30_p60": round(float(inside), 4),
    }
    print(f"\ndubblettgrupper             {payload['grupper']:,}")
    print(f"rader i dem                 {payload['rader']:,}")
    print(f"spridning p75/p25 (median)  {payload['spridning_p75_p25_median']*100:.1f} % av medianen")
    print(f"andel inom egen p30-p60     {payload['andel_inom_egen_p30_p60']*100:.1f} %")
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"\nskrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
