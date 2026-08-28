#!/usr/bin/env python
"""Del A — bryggmätningen: säljpercentilen på exakt den fråga motorn ställer.

    python run_bridge_study.py

Percentilstudien mätte rangen mot en bred jämförelsemängd. Den här mätningen
gör om det på motorns egen nivå: samma märke OCH modellnamn, samma
tidsfönster, samma bildomsortering. Ingen fallback-breddning — ger
modellsökningen för få annonser exkluderas försäljningen.

Återanvänder percentilstudiens konfig, budspärr, bootstrap och kanalgap.
Slumpfröet är fixerat.
"""

from __future__ import annotations

import json
import logging
import warnings
from datetime import datetime, timezone

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

import bridge_matching as B
import percentile_estimate as E
import percentile_matching as M
import study_config as S
from price_engine.vectors import load_vectors
from run_percentile_study import load_enriched, prepare_sales

log = logging.getLogger("brygga")


def _query_vector(row, store):
    """Bildvektorn för en auktionsannons, om den finns i lagret."""
    rows = store.rows_for(pd.DataFrame([row]))
    if rows[0] < 0:
        return None, None
    colour = store.colors[rows[0]] if store.colors is not None else None
    return store.embeddings[rows[0]], colour


def measure(frame: pd.DataFrame) -> tuple:
    sales, base_funnel = prepare_sales(frame)
    funnel = list(base_funnel)

    def step(name, f):
        funnel.append({
            "steg": name,
            "tradera": int((f["source"] == "tradera").sum()),
            "auctionet": int((f["source"] == "auctionet").sum()),
            "totalt": len(f),
        })

    qualified = B.qualify(sales)
    step("med igenkänt märke", qualified[qualified["brand"] != ""])
    qualified = qualified[qualified["model"].notna()].copy()
    step("med igenkänt märke OCH modellnamn", qualified)

    pool = B.build_pool(frame)
    matcher = B.ModelMatcher(pool)
    store = load_vectors()
    log.info("Vektorlager: %d vektorer", len(store))

    months = qualified["listed_at"].dt.to_period("M")
    records = []
    for (_, sale), month in zip(qualified.iterrows(), months):
        candidates = matcher.candidates(sale["brand"], sale["model"], month)
        if len(candidates) < S.BRIDGE_MIN_ASKING:
            continue

        prices_text = np.sort(candidates["price"].to_numpy(float))
        rank_text = M.percentile_rank(prices_text, sale["price"])

        # Bildomsortering ovanpå, precis som i produktion.
        vector, colour = (None, None)
        if pd.notna(sale.get("image_url")):
            vector, colour = _query_vector(sale, store)
        reranked, image_method = B.image_rerank(candidates, vector, colour, store)

        prices = np.sort(reranked["price"].to_numpy(float))
        if len(prices) < S.BRIDGE_MIN_ASKING:
            # Bildfiltret får inte skära bort så mycket att jämförelsemängden
            # blir för tunn — då används textnivån, och det loggas.
            prices, image_method = prices_text, "reverted"

        # Överlapp: hur mycket ändrade bilden faktiskt jämförelsemängden?
        overlap = (len(set(reranked.index) & set(candidates.index))
                   / max(len(candidates), 1))

        records.append({
            "source": sale["source"], "price": sale["price"],
            "variant": sale["variant"], "brand": sale["brand"],
            "model": sale["model"], "brand_tier": sale["brand_tier"],
            "aux_bid_count": sale["aux_bid_count"],
            "aux_estimate": sale["aux_estimate"], "listed_at": sale["listed_at"],
            "rank": M.percentile_rank(prices, sale["price"]),
            "rank_text": rank_text,
            "n_asking": len(prices), "n_asking_text": len(candidates),
            "image_method": image_method,
            "image_overlap": round(float(overlap), 4),
            "no_image": vector is None,
            "matched_median": float(np.median(prices)),
        })

    measured = pd.DataFrame(records)
    step(f"modellsökning gav >= {S.BRIDGE_MIN_ASKING} annonser", measured)
    log.info("Mätta: %d försäljningar (cache %d/%d)",
             len(measured), matcher.hits, matcher.misses)

    measured["price_tier"] = M.assign_price_tier(measured)
    return measured, funnel


def aggregate(measured: pd.DataFrame) -> dict:
    rng = np.random.default_rng(S.RANDOM_SEED)

    # Kanalgapet OMSKATTAS på motornivåns ranger — det ärvs aldrig från den
    # breda nivån, eftersom hela poängen är att nivån ändrar rangen.
    tier_table = E.tier_gap_table(measured, rng)
    low_gap, low_status = E.extrapolate_low_gap(tier_table)
    gaps = {
        "high": (tier_table.get("high", {}).get("gap"), "gap_measured"),
        "mid": (tier_table.get("mid", {}).get("gap"), "gap_measured"),
        "low": (low_gap, low_status),
    }
    for tier in ("high", "mid"):
        if gaps[tier][0] is None:
            gaps[tier] = (None, "insufficient_market")

    gap_by_tier = {t: (gaps[t][0] or 0.0) for t in S.TIER_ORDER}
    correction = measured["brand_tier"].map(gap_by_tier).fillna(0.0)
    correction = correction.where(measured["source"] == "auctionet", 0.0)
    measured = measured.assign(
        rank_adjusted=(measured["rank"] + correction).clip(0, 1)
    )

    results = {"channel_gaps": tier_table, "low_end_gap_status": low_status,
               "groups": {}, "segments": {}}

    for keys, label in ((["brand_tier"], "märkesklass"),
                        (["brand_tier", "price_tier"], "märkesklass × prisnivå"),
                        (["variant", "brand_tier"], "möbeltyp × märkesklass")):
        for key, group in measured.dropna(subset=keys).groupby(keys, observed=True):
            name = " · ".join(map(str, key if isinstance(key, tuple) else (key,)))
            threshold, _ = E.choose_bid_threshold(group["aux_bid_count"])
            qualified = group[group["aux_bid_count"] >= threshold]
            if len(qualified) < S.MIN_SALES_PER_GROUP:
                continue
            entry = {
                **E.summarise(qualified["rank_adjusted"].to_numpy(), rng),
                "sell_percentile_raw": round(float(qualified["rank"].median()), 4),
                "bid_threshold": threshold,
                "dimension": label,
                "n_tradera": int((qualified["source"] == "tradera").sum()),
                "median_n_asking": int(qualified["n_asking"].median()),
                "no_image_share": round(float(qualified["no_image"].mean()), 4),
                "bid_terciles": E.bid_terciles(qualified, rng),
                "matching_level": "engine",
            }
            (results["segments"] if len(keys) <= 2 else results["groups"])[name] = entry

    qualified = measured[measured["aux_bid_count"] >= S.BID_THRESHOLDS[-1]]
    results["overall"] = {
        "sell_percentile": round(float(qualified["rank_adjusted"].median()), 4),
        "sell_percentile_raw": round(float(qualified["rank"].median()), 4),
        "n": int(len(qualified)),
        "median_n_asking": int(qualified["n_asking"].median()),
    }

    # Bildomsorteringens faktiska effekt.
    with_image = measured[~measured["no_image"]]
    results["image_effect"] = {
        "n_with_image": int(len(with_image)),
        "share_with_image": round(float((~measured["no_image"]).mean()), 4),
        "methods": {k: int(v) for k, v in measured["image_method"].value_counts().items()},
        "median_overlap": (round(float(with_image["image_overlap"].median()), 4)
                           if len(with_image) else None),
        "median_rank_shift": (
            round(float((with_image["rank"] - with_image["rank_text"]).abs().median()), 4)
            if len(with_image) else None),
        "changed_materially": (
            round(float((with_image["image_overlap"] < 0.9).mean()), 4)
            if len(with_image) else None),
    }
    return results, measured


def figures(measured: pd.DataFrame, results: dict) -> list:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    directory = S.BRIDGE_DIR / "figurer"
    directory.mkdir(parents=True, exist_ok=True)
    written = []

    fig, ax = plt.subplots(figsize=(9, 5))
    ax.hist(measured["rank"], bins=40, alpha=0.7, density=True, label="motornivå")
    ax.axvline(measured["rank"].median(), color="crimson", ls="--",
               label=f"median p{measured['rank'].median()*100:.0f}")
    ax.set_xlabel("percentilrang i den modellmatchade utropsfördelningen")
    ax.set_ylabel("täthet")
    ax.set_title("Var i fördelningen sker affärerna — motorns egen nivå")
    ax.legend(); fig.tight_layout()
    path = directory / "1_rang_motorniva.png"
    fig.savefig(path, dpi=130); plt.close(fig); written.append(path)

    # Trappan: bred -> smal -> motornivå.
    segments = {k: v for k, v in results["segments"].items()
                if v["dimension"] == "märkesklass"}
    if segments:
        try:
            broad = json.loads((S.OUTPUT_JSON).read_text())
            prev = broad.get("recommended_percentiles", {}).get("per_segment", {})
        except Exception:
            prev = {}
        names = sorted(segments)
        fig, ax = plt.subplots(figsize=(8, 5))
        width = 0.35
        xs = np.arange(len(names))
        ax.bar(xs - width / 2, [prev.get(n, {}).get("sell_percentile", np.nan) for n in names],
               width, label="percentilstudien (smal)")
        ax.bar(xs + width / 2, [segments[n]["sell_percentile"] for n in names],
               width, label="bryggan (motornivå)")
        ax.set_xticks(xs); ax.set_xticklabels(names)
        ax.set_ylabel("säljpercentil"); ax.legend()
        ax.set_title("Trappan: konvergerar percentilen när matchningen smalnar?")
        fig.tight_layout()
        path = directory / "2_trappan.png"
        fig.savefig(path, dpi=130); plt.close(fig); written.append(path)

    # Budterciler.
    rows = []
    for name, seg in results["segments"].items():
        for tercile, stats in (seg.get("bid_terciles") or {}).items():
            rows.append({"segment": name, "tercile": tercile,
                         "percentile": stats["sell_percentile"]})
    if rows:
        df = pd.DataFrame(rows)
        order = [t for t in ("låg", "mellan", "hög") if t in set(df["tercile"])]
        fig, ax = plt.subplots(figsize=(7, 4.5))
        ax.boxplot([df[df.tercile == t]["percentile"] for t in order], labels=order)
        ax.set_xlabel("budtercil"); ax.set_ylabel("säljpercentil")
        ax.set_title("Glidknappens kanter: budaktivitet mot percentil")
        fig.tight_layout()
        path = directory / "3_budtercil_kanter.png"
        fig.savefig(path, dpi=130); plt.close(fig); written.append(path)

    return written


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    np.random.seed(S.RANDOM_SEED)
    S.BRIDGE_DIR.mkdir(parents=True, exist_ok=True)

    measured, funnel = measure(load_enriched())
    results, measured = aggregate(measured)
    written = figures(measured, results)

    measured.to_parquet(S.BRIDGE_DIR / "ranks.parquet", index=False)
    payload = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "matching_level": "engine",
        "random_seed": S.RANDOM_SEED,
        "thresholds": {
            "min_asking": S.BRIDGE_MIN_ASKING,
            "bid": list(S.BID_THRESHOLDS),
            "min_sales_per_group": S.MIN_SALES_PER_GROUP,
            "time_window_months": S.TIME_WINDOW_MONTHS,
        },
        "funnel": funnel,
        **results,
    }
    (S.BRIDGE_DIR / "bridge_percentiles.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2))

    from bridge_report import write_report
    write_report(measured, results, funnel, written)

    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (S.BRIDGE_DIR / "PROGRESS.md").write_text(
        f"# Framsteg — Del A\n\n- **Bryggmätningen** klar {stamp} — "
        f"{len(measured):,} försäljningar på motornivå, "
        f"{len(written)} figurer\n")
    log.info("Klart: %s", S.BRIDGE_DIR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
