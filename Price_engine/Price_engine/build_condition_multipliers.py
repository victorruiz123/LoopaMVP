#!/usr/bin/env python
"""Nattjobb — härled skickmultiplikatorer ur egen data.

    python build_condition_multipliers.py            # kör och skriv tabellen
    python build_condition_multipliers.py --dry-run  # visa utan att skriva
    python build_condition_multipliers.py --show     # visa befintlig tabell

Ingen procentsats ur litteraturen hårdkodas som sanning. Publicerade siffror
motsäger varandra grovt — samma ord "gott skick" motsvarar 20–100 % av nypris
beroende på källa. Det som är stabilt är den RELATIVA trappan mellan nivåer,
och den räknas här ur vår egen data.

Metod, steg för steg:

  1. Normalisera skick till den fasta skalan i config.CONDITION_SCALE.
     Värden som inte går att mappa rapporteras — de tigs aldrig ihjäl.
  2. Hitta grupper (undergrupp x märkesklass) med minst
     MULTIPLIER_MIN_PER_LEVEL annonser i minst två nivåer, över en längre
     horisont än prisberäkningen (MULTIPLIER_HORIZON_MONTHS) — kvoter åldras
     långsammare än priser.
  3. Per grupp: kvot = median(pris | nivå X) / median(pris | gruppens
     vanligaste nivå).
  4. Snitta kvoterna över grupper, VIKTAT på antal annonser, separat per
     märkesklass. Skickets priseffekt är större för premiummöbler än för
     budgetmöbler; en gemensam tabell skulle systematiskt fela åt båda håll.
  5. Kedja ihop till multiplikatorer relativt "gott" så att tabellerna går
     att jämföra mellan klasser.
  6. Global fallback-tabell för okänd märkesklass.
  7. Diagnostik: bidragande grupper, spridning mellan grupper, och skillnaden
     mot förra körningen.

Räcker inte datan används config.DEFAULT_CONDITION_LADDER och tabellen märks
source="default", så att API:et kan visa att siffran är en gissning.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import warnings
from datetime import datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

from price_engine import config, variant
from price_engine.data_loader import load_listings, normalize_text

log = logging.getLogger("multipliers")

#: Nivån alla tabeller uttrycks relativt, så att klasserna går att jämföra.
PIVOT = "gott"

#: Längsta nyckeln först, så att "mycket bra skick" vinner över "bra skick".
_CONDITION_KEYS = sorted(config.CONDITION_VALUE_MAP, key=len, reverse=True)


# --------------------------------------------------------------------------
# Steg 1 — normalisera skicket till den fasta skalan
# --------------------------------------------------------------------------
def to_scale(value: object) -> str | None:
    """Datavärde -> skalnivå, eller None om det inte går att mappa."""
    text = normalize_text(value)
    if not text:
        return None
    if text in config.CONDITION_VALUE_MAP:
        return config.CONDITION_VALUE_MAP[text]
    for key in _CONDITION_KEYS:
        if key in text:
            return config.CONDITION_VALUE_MAP[key]
    return None


def brand_class(brand: object) -> str | None:
    """Märke -> budget / mellan / premium, eller None för okänt."""
    text = normalize_text(brand)
    if not text:
        return None
    for klass, brands in config.BRAND_CLASSES.items():
        if any(b in text for b in brands):
            return klass
    return None


def prepare(listings: pd.DataFrame) -> tuple:
    """Normaliserar och filtrerar. Returnerar (frame, omappade värden)."""
    frame = listings[listings["price_kind"] == config.MULTIPLIER_PRICE_KIND].copy()

    # Delar och tillbehör snedvrider kvoterna kraftigt: de är överrepresenterade
    # i nyskick (11,3 % mot 6,5 % i slitet) eftersom en reservdel oftast säljs
    # oanvänd, och de kostar ungefär hälften. Se variant.PART.
    if "variant" in frame.columns:
        frame = frame[frame["variant"] != variant.PART]

    # Längre horisont än prisberäkningen — kvoter åldras långsammare.
    if "listed_at" in frame.columns:
        cutoff = pd.Timestamp.now(tz="UTC") - pd.DateOffset(
            months=config.MULTIPLIER_HORIZON_MONTHS
        )
        dated = frame[frame["listed_at"].notna()]
        if len(dated):
            frame = dated[dated["listed_at"] >= cutoff]

    # Mappa över UNIKA värden, inte rad för rad: skickkolumnen har en handfull
    # värden och märkeskolumnen några tusen, mot 1,5 miljoner rader.
    raw = frame["condition"].dropna()
    frame["level"] = frame["condition"].map(
        {value: to_scale(value) for value in frame["condition"].dropna().unique()}
    )
    frame["brand_class"] = frame["brand"].map(
        {value: brand_class(value) for value in frame["brand"].dropna().unique()}
    )

    # Steg 1: rapportera värden som inte gick att mappa.
    unmapped = (
        raw[frame.loc[raw.index, "level"].isna()].value_counts()
        if len(raw) else pd.Series(dtype=int)
    )
    return frame[frame["level"].notna()], unmapped


# --------------------------------------------------------------------------
# Steg 2–3 — kvoter per grupp
# --------------------------------------------------------------------------
def group_ratios(frame: pd.DataFrame) -> pd.DataFrame:
    """Kvot mot gruppens vanligaste nivå, per (undergrupp, märkesklass)."""
    keys = ["subgroup", "brand_class"]
    counted = (
        frame.groupby(keys + ["level"], observed=True)["price"]
        .agg(median_price="median", listings="size")
        .reset_index()
    )
    counted = counted[counted["listings"] >= config.MULTIPLIER_MIN_PER_LEVEL]

    rows = []
    for key, group in counted.groupby(keys, observed=True):
        # Steg 2: minst två nivåer, annars går ingen kvot att bilda.
        if len(group) < 2:
            continue
        # Steg 3: referensen är gruppens VANLIGASTE nivå.
        reference = group.loc[group["listings"].idxmax()]
        if reference["median_price"] <= 0:
            continue
        for row in group.itertuples():
            rows.append({
                "subgroup": key[0],
                "brand_class": key[1],
                "level": row.level,
                "ratio": row.median_price / reference["median_price"],
                "listings": row.listings,
                "reference_level": reference["level"],
            })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# Steg 4 — kedja varje grupp mot PIVOT
# --------------------------------------------------------------------------
def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    """Viktad median — robustare än viktat medelvärde mot enstaka avvikare."""
    order = np.argsort(values)
    values, weights = values[order], weights[order]
    cumulative = np.cumsum(weights)
    return float(values[np.searchsorted(cumulative, cumulative[-1] / 2.0)])


def chain_to_pivot(ratios: pd.DataFrame) -> pd.DataFrame:
    """Uttrycker varje grupps kvoter relativt PIVOT i stället för sin egen
    referensnivå, så att grupper går att jämföra med varandra.

    Två fall:

      Gruppen HAR pivotnivån   skala = kvot(X) / kvot(pivot). Referensnivån
                               förkortas bort — exakt, ingen brygga behövs.
      Gruppen SAKNAR den       kvoterna hänger i luften relativt sin egen
                               referensnivå R. De hakas på via en brygga:
                               den globala skalan för R, mätt på grupperna i
                               första fallet. Approximativt, och märks så.

    Grupperna hålls isär hela vägen — det är antalet BIDRAGANDE GRUPPER som
    säger om en siffra är mätt eller gissad, och det talet får inte kollapsa
    i ett mellansteg.
    """
    rows, orphans = [], []
    for key, group in ratios.groupby(["subgroup", "brand_class"], observed=True):
        pivot = group[group["level"] == PIVOT]
        base = float(pivot["ratio"].iloc[0]) if len(pivot) else None
        for row in group.itertuples():
            record = {"subgroup": key[0], "brand_class": key[1], "level": row.level,
                      "listings": row.listings, "reference_level": row.reference_level}
            if base and base > 0:
                rows.append({**record, "scale": row.ratio / base, "bridged": False})
            else:
                orphans.append(record | {"ratio": row.ratio})

    direct = pd.DataFrame(rows)
    if direct.empty or not orphans:
        return direct

    # Bryggan: var referensnivåerna ligger, mätt på grupperna med pivot.
    bridge = {
        level: _weighted_median(
            rows_["scale"].to_numpy(), rows_["listings"].to_numpy(float)
        )
        for level, rows_ in direct.groupby("level", observed=True)
        if len(rows_) >= config.MULTIPLIER_MIN_GROUPS
    }
    for record in orphans:
        factor = bridge.get(record["reference_level"])
        if factor:
            ratio = record.pop("ratio")
            rows.append({**record, "scale": ratio * factor, "bridged": True})
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# Steg 5 — viktat snitt över grupper, monotont
# --------------------------------------------------------------------------
def _isotonic(levels: list, values: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """Tvingar skalan att falla monotont från bästa till sämsta skick.

    Ett bättre skick kan inte vara värt mindre än ett sämre. När mätningen
    ändå säger det är det brus, och det syns bara i de tunna cellerna
    (premium mycket_gott 1,50 mot nyskick 1,43 på 60 annonser). PAVA slår
    ihop de nivåer som krockar och ger dem ett gemensamt värde, viktat på
    underlaget — i logaritmen, eftersom kvoter är multiplikativa.
    """
    logs = np.log(values)
    blocks = [([i], logs[i], weights[i]) for i in range(len(logs))]
    merged = True
    while merged:
        merged = False
        for i in range(len(blocks) - 1):
            # Skalan är sorterad bäst -> sämst, så värdet ska falla.
            if blocks[i][1] < blocks[i + 1][1] - 1e-12:
                (ai, av, aw), (bi, bv, bw) = blocks[i], blocks[i + 1]
                blocks[i : i + 2] = [
                    (ai + bi, (av * aw + bv * bw) / (aw + bw), aw + bw)
                ]
                merged = True
                break
    out = np.empty_like(logs)
    for indices, value, _ in blocks:
        out[indices] = value
    return np.exp(out)


def build_table(scales: pd.DataFrame, scope: str, reference: dict = None) -> dict | None:
    """En multiplikatortabell ur färdigkedjade gruppskalor.

    `reference` är den globala tabellen. Nivåer som inte håller måttet i det
    här urvalet ärver därifrån hellre än från defaulttrappan — "vi saknar
    premiumdata för nyskick" ska ge marknadens siffra, inte en gissning.
    """
    if scales.empty:
        return None

    measured, spread, support = {}, {}, {}
    thin = []
    for level in config.CONDITION_SCALE:
        rows = scales[scales["level"] == level]
        groups = int(rows["subgroup"].nunique())
        if not groups:
            thin.append(level)
            continue

        values = rows["scale"].to_numpy(float)
        p25 = float(np.percentile(values, 25))
        p75 = float(np.percentile(values, 75))
        listings = int(rows["listings"].sum())
        # Osäkerheten i skattningen, inte spridningen i populationen — se
        # config.MULTIPLIER_MAX_UNCERTAINTY.
        uncertainty = (
            math.log(p75 / p25) / math.sqrt(groups) if p25 > 0 and p75 > p25 else 0.0
        )
        spread[level] = {
            "p25": round(p25, 3), "p75": round(p75, 3), "groups": groups,
            "uncertainty": round(uncertainty, 3),
            "bridged": int(rows["bridged"].sum()), "listings": listings,
        }

        if groups < config.MULTIPLIER_MIN_GROUPS:
            spread[level]["rejected"] = f"{groups} grupper"
            thin.append(level)
        elif uncertainty > config.MULTIPLIER_MAX_UNCERTAINTY:
            spread[level]["rejected"] = f"osäkerhet {uncertainty:.2f}"
            thin.append(level)
        else:
            measured[level] = _weighted_median(
                values, rows["listings"].to_numpy(float)
            )
            support[level] = listings

    if PIVOT not in measured or len(measured) < 2:
        return None

    # Monotonikravet gäller bara de MÄTTA nivåerna. Defaultvärden ska inte
    # kunna dra ett uppmätt tal med sig — de placeras efteråt.
    levels = [level for level in config.CONDITION_SCALE if level in measured]
    fitted = _isotonic(
        levels,
        np.array([measured[level] for level in levels]),
        np.array([float(support[level]) for level in levels]),
    )
    clamped = [
        level for level, after in zip(levels, fitted)
        if abs(after - measured[level]) / measured[level] > 0.005
    ]
    # PAVA kan flytta pivotnivån; normalisera om så att gott alltid är 1,0.
    base = float(fitted[levels.index(PIVOT)])
    table = {level: float(v) / base for level, v in zip(levels, fitted)}

    # Nivåer som inte höll måttet fylls i, i tur och ordning:
    #   1. den globala tabellens värde  (marknadens siffra)
    #   2. defaulttrappans STEG från närmaste mätta nivå — inte dess absoluta
    #      värde. Vet vi att slitet ligger på 0,63 är 0,63 x 0,75 en bättre
    #      gissning för renoveringsobjekt än trappans egna 0,56.
    inherited, fallback = [], []
    for level in thin:
        borrowed = (reference or {}).get(level)
        if borrowed:
            table[level] = borrowed
            inherited.append(level)
            continue
        default = config.DEFAULT_CONDITION_LADDER.get(level)
        if not default:
            continue
        nearest = min(
            measured, key=lambda m: abs(
                config.CONDITION_SCALE.index(m) - config.CONDITION_SCALE.index(level)
            )
        )
        table[level] = table[nearest] * (
            default / config.DEFAULT_CONDITION_LADDER[nearest]
        )
        fallback.append(level)

    # De ifyllda värdena kommer utifrån och kan bryta monotonin. Kläm in dem
    # mellan sina mätta grannar — de mätta talen rör sig inte, de är fittade.
    order = [level for level in config.CONDITION_SCALE if level in table]
    for i, level in enumerate(order):
        if level in measured:
            continue
        above = next((table[o] for o in reversed(order[:i]) if o in measured), None)
        below = next((table[o] for o in order[i + 1:] if o in measured), None)
        if above is not None:
            table[level] = min(table[level], above)
        if below is not None:
            table[level] = max(table[level], below)

    table = {level: round(table[level], 4) for level in order}

    return {
        "scope": scope,
        "source": "data",
        "multipliers": table,
        "measured_levels": list(measured),
        "spread": spread,
        "listings": support,
        "groups": int(scales["subgroup"].nunique()),
        "inherited_levels": inherited,
        "fallback_levels": fallback,
        "clamped_levels": clamped,
    }


def default_table(scope: str) -> dict:
    """Kallstart — försiktig trappa, tydligt märkt som gissning."""
    return {
        "scope": scope,
        "source": "default",
        "multipliers": dict(config.DEFAULT_CONDITION_LADDER),
        "measured_levels": [],
        "spread": {},
        "listings": {},
        "groups": 0,
        "inherited_levels": [],
        "fallback_levels": list(config.DEFAULT_CONDITION_LADDER),
        "clamped_levels": [],
    }


# --------------------------------------------------------------------------
# Steg 7 — diagnostik
# --------------------------------------------------------------------------
def diff_since_last(new: dict, path: Path) -> dict:
    """Hur tabellen förändrats sedan förra körningen."""
    if not path.is_file():
        return {"previous_run": None}
    try:
        old = json.loads(path.read_text())
    except Exception:
        return {"previous_run": "oläsbar"}

    changes = {}
    for scope, table in new["tables"].items():
        before = (old.get("tables", {}).get(scope) or {}).get("multipliers", {})
        for level, value in table["multipliers"].items():
            was = before.get(level)
            if was and abs(value - was) / was > 0.02:
                changes[f"{scope}/{level}"] = f"{was:.3f} -> {value:.3f}"
    return {"previous_run": old.get("built_at"), "changed": changes}


def build(listings: pd.DataFrame) -> dict:
    frame, unmapped = prepare(listings)
    ratios = group_ratios(frame)
    scales = chain_to_pivot(ratios) if len(ratios) else pd.DataFrame()

    # Den globala tabellen byggs FÖRST — klasserna ärver från den när deras
    # eget underlag inte håller.
    global_table = (build_table(scales, "global") if len(scales) else None) \
        or default_table("global")
    reference = {
        level: value for level, value in global_table["multipliers"].items()
        if level in global_table["measured_levels"]
    }

    tables = {}
    for klass in config.BRAND_CLASSES:
        subset = scales[scales.brand_class == klass] if len(scales) else scales
        tables[klass] = (
            build_table(subset, klass, reference) if len(subset) else None
        ) or default_table(klass)
    tables["global"] = global_table

    return {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "horizon_months": config.MULTIPLIER_HORIZON_MONTHS,
        "min_per_level": config.MULTIPLIER_MIN_PER_LEVEL,
        "min_groups": config.MULTIPLIER_MIN_GROUPS,
        "pivot": PIVOT,
        "tables": tables,
        "diagnostics": {
            "listings_used": int(len(frame)),
            "groups_with_ratios": int(ratios["subgroup"].nunique()) if len(ratios) else 0,
            "bridged_rows": int(scales["bridged"].sum()) if len(scales) else 0,
            "unmapped_condition_values": {
                str(k): int(v) for k, v in unmapped.head(20).items()
            },
            "levels_without_data": sorted(
                set(config.CONDITION_SCALE)
                - set(scales["level"].unique() if len(scales) else []),
                key=config.CONDITION_SCALE.index,
            ),
        },
    }


def render(result: dict) -> str:
    width = max(len(level) for level in config.CONDITION_SCALE) + 4
    out = [
        f"Byggd: {result['built_at']}",
        f"Horisont {result['horizon_months']} mån · minst {result['min_per_level']}"
        f" annonser/nivå · minst {result['min_groups']} grupper/nivå ·"
        f" pivot = {result['pivot']}",
        "",
        f"{'klass':<9}{'källa':<7}"
        + "".join(f"{level:>{width}}" for level in config.CONDITION_SCALE),
        "-" * (16 + width * len(config.CONDITION_SCALE)),
    ]
    for scope, table in result["tables"].items():
        row = f"{scope:<9}{table['source']:<7}"
        for level in config.CONDITION_SCALE:
            value = table["multipliers"].get(level)
            if value is None:
                cell = "—"
            else:
                mark = ("g" if level in table["inherited_levels"] else
                        "*" if level in table["fallback_levels"] else
                        "~" if level in table["clamped_levels"] else "")
                cell = f"{value:.3f}{mark}"
            row += f"{cell:>{width}}"
        out.append(row)
    out += [
        "",
        "  g = ärvd från den globala tabellen (eget underlag höll inte måttet)",
        "  * = defaultvärde, ingen data alls på nivån",
        "  ~ = justerad för att skalan ska falla monotont",
    ]

    out += [
        "",
        f"Underlag per nivå — osäkerhet = ln(p75/p25)/sqrt(grupper),"
        f" gräns {config.MULTIPLIER_MAX_UNCERTAINTY}:",
        "",
    ]
    for scope, table in result["tables"].items():
        if not table["spread"]:
            out.append(f"  {scope}: inga mätta nivåer")
            continue
        out.append(f"  {scope}:")
        for level, s in table["spread"].items():
            note = f"  FÖRKASTAD: {s['rejected']}" if s.get("rejected") else (
                f"  ({s['bridged']} via brygga)" if s["bridged"] else "")
            out.append(
                f"    {level:<18}{s['p25']:>6.2f} – {s['p75']:<7.2f}"
                f"{s['groups']:>4} grp{s['listings']:>9,} ann"
                f"   osäkerhet {s['uncertainty']:.2f}{note}"
            )

    d = result["diagnostics"]
    out += [
        "",
        f"Annonser i underlaget:      {d['listings_used']:,}",
        f"Grupper med kvoter:         {d['groups_with_ratios']:,}",
        f"Kvoter via brygga:          {d['bridged_rows']:,}",
        f"Nivåer utan data:           {', '.join(d['levels_without_data']) or 'inga'}",
    ]
    if d["unmapped_condition_values"]:
        out.append("Omappade skickvärden:")
        for value, n in d["unmapped_condition_values"].items():
            out.append(f"    {value:<30}{n:>8,}")
    else:
        out.append("Omappade skickvärden:       inga")
    return "\n".join(out)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="build_condition_multipliers.py")
    parser.add_argument("--dry-run", action="store_true",
                        help="Visa tabellen utan att skriva den")
    parser.add_argument("--show", action="store_true",
                        help="Visa befintlig tabell och avsluta")
    parser.add_argument("--out", default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    path = Path(args.out) if args.out else config.MULTIPLIER_TABLE_PATH

    if args.show:
        if not path.is_file():
            print(f"Ingen tabell i {path}")
            return 1
        print(render(json.loads(path.read_text())))
        return 0

    result = build(load_listings())
    result["diagnostics"].update(diff_since_last(result, path))
    print(render(result))

    changed = result["diagnostics"].get("changed")
    if changed:
        print("\nFörändrat sedan förra körningen:")
        for key, value in changed.items():
            print(f"    {key:<28}{value}")

    if args.dry_run:
        print("\n(--dry-run: inget skrevs)")
        return 0

    path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"\nSkrev {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
