#!/usr/bin/env python
"""Del B — omlistningskedjor: den empiriska "för dyrt"-gradienten.

    python run_relist_study.py

Auktionsspåret innehåller noll osålda objekt, så gränsen för "för dyrt" måste
komma ur Blocket-världens egen data. Varje omlistning med sänkt pris är en
dom över det första priset.

Resultatet är INDIKATIVT och ska inte kopplas in i motorn — precisionen i
kedjeidentifieringen räcker inte, vilket rapporten redovisar öppet.
"""

from __future__ import annotations

import json
import logging
import warnings
from datetime import datetime, timezone

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

import percentile_matching as M
import relist_chains as R
import study_config as S
from price_engine.data_loader import load_listings
from price_engine.vectors import load_vectors

log = logging.getLogger("omlistning")


def apply_strictness(summary: pd.DataFrame, chains: pd.DataFrame,
                     listings: pd.DataFrame) -> tuple:
    """Skärper urvalet tills precisionen håller, och räknar vad det kostade.

    Ordern kräver ~90 % precision för säkra kedjor. Den nås inte — men
    stegen dit, och hur långt de räcker, är i sig resultatet.
    """
    asking = listings[listings["price_kind"] == "asking"]
    frequency = asking["name_norm"].value_counts()
    summary = summary.assign(
        title_freq=summary["title"].map(frequency),
        title_len=summary["title"].str.len(),
        price_ratio=summary["end_price"] / summary["start_price"],
    )

    steps = []

    def note(name: str, frame: pd.DataFrame) -> pd.DataFrame:
        lowered = frame["lowered"].mean() if len(frame) else np.nan
        raised = frame["raised"].mean() if len(frame) else np.nan
        steps.append({
            "steg": name, "kedjor": len(frame),
            "sänkt_%": round(float(lowered * 100), 1) if len(frame) else None,
            "höjt_%": round(float(raised * 100), 1) if len(frame) else None,
            # Symmetriskattning: brus antas ge lika många höjningar som
            # sänkningar, så andelen höjda gånger två är brusets storlek.
            "skattad_precision": (round(float(1 - 2 * raised), 3)
                                  if len(frame) and raised < 0.5 else None),
        })
        return frame

    note("kandidatkedjor (samma titel, olika datum)", summary)
    summary = note(f"titeln förekommer högst {S.RELIST_MAX_TITLE_FREQ} gånger",
                   summary[summary["title_freq"] <= S.RELIST_MAX_TITLE_FREQ])
    summary = note(f"titeln minst {S.RELIST_MIN_TITLE_LEN} tecken",
                   summary[summary["title_len"] >= S.RELIST_MIN_TITLE_LEN])
    low, high = S.RELIST_PRICE_RATIO
    summary = note("prisändringen rimlig",
                   summary[summary["price_ratio"].between(low, high)])
    summary = note("bilden motbevisar inte",
                   summary[summary["image_check"] != "image_rejected"])
    return summary, steps


def measure_ranks(summary: pd.DataFrame, chains: pd.DataFrame,
                  listings: pd.DataFrame) -> pd.DataFrame:
    """Startprisets percentilrang i den samtida matchade utropsfördelningen."""
    pool = M.build_asking_pool(listings)
    cache = M.MatchCache(pool, {})

    first_links = (chains.sort_values("link")
                   .groupby("chain_id").first().reset_index())
    merged = summary.merge(
        first_links[["chain_id", "listed_at", "variant"]],
        on="chain_id", how="left", suffixes=("", "_link"))

    months = merged["listed_at"].dt.to_period("M")
    ranks, counts, medians = [], [], []
    for (_, row), month in zip(merged.iterrows(), months):
        prices = cache.prices("variant", "", row["variant"], month)
        if len(prices) < S.MIN_ASKING_PER_MATCH:
            prices = cache.prices("all", "", row["variant"], month)
        ranks.append(M.percentile_rank(prices, row["start_price"]))
        counts.append(len(prices))
        medians.append(float(np.median(prices)) if len(prices) else np.nan)

    merged["start_rank"] = ranks
    merged["match_count"] = counts
    merged["matched_median"] = medians
    merged = merged[merged["start_rank"].notna()]
    merged["price_tier"] = M.assign_price_tier(merged)
    log.info("Rang beräknad för %d kedjor", len(merged))
    return merged


def gradient(measured: pd.DataFrame, keys: list = None) -> dict:
    """Sänkningssannolikhet per decil av startrangen — "för dyrt"-gradienten."""
    out = {}
    frame = measured.copy()
    frame["decile"] = (frame["start_rank"] * 10).clip(0, 9).astype(int)

    def one(group: pd.DataFrame) -> dict:
        rows = {}
        for decile, part in group.groupby("decile"):
            if len(part) < 20:
                continue
            lowered = part[part["lowered"]]
            rows[f"p{decile * 10}-{decile * 10 + 10}"] = {
                "n": int(len(part)),
                "share_lowered": round(float(part["lowered"].mean()), 4),
                "share_raised": round(float(part["raised"].mean()), 4),
                "median_cut": (round(float(lowered["price_change"].median()), 4)
                               if len(lowered) else None),
            }
        return rows

    out["global"] = one(frame)
    if keys:
        for key, group in frame.dropna(subset=keys).groupby(keys, observed=True):
            name = " · ".join(map(str, key if isinstance(key, tuple) else (key,)))
            rows = one(group)
            if len(rows) >= 3:
                out[name] = rows
    return out


def figures(measured: pd.DataFrame, grad: dict) -> list:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    directory = S.RELIST_DIR / "figurer"
    directory.mkdir(parents=True, exist_ok=True)
    written = []

    fig, ax = plt.subplots(figsize=(9, 5))
    for name, rows in list(grad.items())[:6]:
        xs = [int(k.split("-")[0].lstrip("p")) + 5 for k in rows]
        ys = [v["share_lowered"] * 100 for v in rows.values()]
        ax.plot(xs, ys, "o-", label=f"{name} (n={sum(v['n'] for v in rows.values()):,})",
                lw=2.5 if name == "global" else 1.2)
    ax.set_xlabel("startprisets percentilrang i den matchade utropsfördelningen")
    ax.set_ylabel("andel som sänkte priset vid omlistning (%)")
    ax.set_title("\"För dyrt\"-gradienten — när tvingas priset ned?")
    ax.legend(fontsize=8); ax.grid(alpha=0.3)
    fig.tight_layout()
    path = directory / "1_for_dyrt_gradient.png"
    fig.savefig(path, dpi=130); plt.close(fig); written.append(path)

    rows = grad.get("global", {})
    if rows:
        fig, ax = plt.subplots(figsize=(9, 5))
        xs = [int(k.split("-")[0].lstrip("p")) + 5 for k in rows]
        ys = [-(v["median_cut"] or 0) * 100 for v in rows.values()]
        ax.bar(xs, ys, width=8)
        ax.set_xlabel("startprisets percentilrang")
        ax.set_ylabel("median prissänkning (%)")
        ax.set_title("Hur mycket sänks priset, givet att det sänks?")
        fig.tight_layout()
        path = directory / "2_sankningens_storlek.png"
        fig.savefig(path, dpi=130); plt.close(fig); written.append(path)

    return written


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    np.random.seed(S.RANDOM_SEED)
    S.RELIST_DIR.mkdir(parents=True, exist_ok=True)

    listings = load_listings()
    chains = R.find_chains(listings)
    store = load_vectors()
    chains = R.confirm_with_images(chains, store)
    summary = R.summarise_chains(chains)

    audit_all = R.audit_precision(chains, summary, store)
    strict, steps = apply_strictness(summary, chains, listings)
    audit_strict = R.audit_precision(chains, strict, store)

    measured = measure_ranks(strict, chains, listings)
    grad = gradient(measured, keys=["variant"])
    grad_tier = gradient(measured, keys=["price_tier"])
    written = figures(measured, grad)

    measured.to_parquet(S.RELIST_DIR / "chains.parquet", index=False)
    payload = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "indicative_only": True,
        "random_seed": S.RANDOM_SEED,
        "thresholds": {
            "max_title_freq": S.RELIST_MAX_TITLE_FREQ,
            "min_title_len": S.RELIST_MIN_TITLE_LEN,
            "image_sim": S.RELIST_IMAGE_SIM,
            "min_days": S.RELIST_MIN_DAYS, "max_days": S.RELIST_MAX_DAYS,
        },
        "strictness_steps": steps,
        "precision_all": audit_all,
        "precision_strict": audit_strict,
        "n_chains": int(len(measured)),
        "gradient_by_variant": grad,
        "gradient_by_price_tier": grad_tier,
    }
    (S.RELIST_DIR / "relist_thresholds.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2))

    from relist_report import write_report
    write_report(measured, payload, written)

    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (S.RELIST_DIR / "PROGRESS.md").write_text(
        f"# Framsteg — Del B\n\n- **Omlistningsstudien** klar {stamp} — "
        f"{len(measured):,} kedjor efter skärpning, {len(written)} figurer\n")
    log.info("Klart: %s", S.RELIST_DIR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
