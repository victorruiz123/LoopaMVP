#!/usr/bin/env python
"""Mäter matgrupp-förväxlingen i BÅDA riktningarna — den dyraste vi har.

    python measure_set_items_direction.py --per-side 10 --model gemini-2.0-flash

Den första L3-mätningen hade bara positiva fall: bord där stolar ingår. Då mäts
om modellen SER stolar, aldrig om den hittar på dem. Halva förväxlingen blev
omätt, och det är den halvan som kostar mest: ser modellen stolar som inte ingår
härleds `matgrupp`, och matgruppen prissätts till **0,52x** ett ensamt matbord.

Designen är matchad: lika många bord med som utan stolar, samma modell, samma
fråga, samma körning. Utan matchning går falskt positivt inte att skilja från
att urvalet råkade vara lätt.

**Facit för negativen kan inte komma ur `set_items`.** L0 sätter aldrig värdet 0
— negationsspärren blockerar "stolar" i "matbord utan stolar", så attributet blir
`None`. Facit läses därför ur uttryckliga fraser där säljaren själv säger att
stolarna inte ingår.

**Semantisk glidning som måste stå i resultatet:** frågan till modellen är vad
som SYNS på bilden, medan attributet handlar om vad som INGÅR. Ett matbord
fotograferat i en matsal har ofta stolar runt sig utan att de säljs med. Det är
inte modellens fel — det är gränsen för vad en bild kan svara på.
"""

from __future__ import annotations

import argparse
import json
import logging
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import pandas as pd

from measure_type_system import blind
from price_engine import config
from price_engine import images as image_store
from price_engine.data_loader import load_listings
from type_system import vision_layer
from type_system.attributes import Attributes
from type_system.text_layer import extract

log = logging.getLogger("riktning")
OUT = Path("type_system/set_items_direction.json")
SEED = 20260809

#: Fraser där säljaren uttryckligen säger att stolarna INTE ingår.
#: `exkl stolar` är utelämnat med flit: enda förekomsten i korpusen är
#: "lyxigt matbord + 5 exkl stolar", där "exkl" betyder *exklusiva* och
#: stolarna alltså ingår. En falsk vän som hade förgiftat facit.
NEGATIVE = (r"utan\s+stolar"
            r"|(?:endast|bara|enbart)\s+(?:mat)?bordet?\b"
            r"|stolar(?:na)?\s+(?:ingar|medfoljer)\s+(?:ej|inte)"
            r"|inga\s+stolar")

#: Positiva: stolarna ingår, enligt text.
POSITIVE = r"\d+\s+stolar|med\s+stolar|matgrupp|matsalsgrupp"


def build(listings: pd.DataFrame, per_side: int) -> pd.DataFrame:
    frame = image_store.usable(listings)
    frame = frame[frame["image_url"].notna() & frame["image_url"].ne("")]
    frame = frame[frame["search_blob"].str.contains(
        r"matbord|matsalsbord|koksbord|matgrupp", na=False)]

    negatives = frame[frame["search_blob"].str.contains(NEGATIVE, na=False, regex=True)]
    positives = frame[frame["search_blob"].str.contains(POSITIVE, na=False, regex=True)
                      & ~frame["search_blob"].str.contains(NEGATIVE, na=False, regex=True)]
    log.info("negativa kandidater: %d, positiva: %d", len(negatives), len(positives))

    rows = []
    for label, pool in (("inga", negatives), ("ingar", positives)):
        take = min(per_side, len(pool))
        for _, r in pool.sample(take, random_state=SEED).iterrows():
            rows.append({"truth": label, "search_blob": r["search_blob"],
                         "name": r["name"], "image_url": r["image_url"],
                         "price": float(r["price"])})
    return pd.DataFrame(rows)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_set_items_direction.py")
    parser.add_argument("--per-side", type=int, default=10)
    parser.add_argument("--model", default=None)
    parser.add_argument("--rpm", type=int, default=12)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    test = build(listings, args.per_side)
    if test.empty:
        log.error("tom testmängd")
        return 1
    log.info("Testmängd: %d (%s)", len(test), test["truth"].value_counts().to_dict())

    if config.VISION_EDGE_URL:
        client, provider = None, config.VISION_EDGE_URL
        model = args.model or config.VISION_EDGE_MODEL
    else:
        client, provider = vision_layer._client(), config.AI_BASE_URL or "openai"
        model = args.model or config.VARIANT_MODEL
    log.info("Leverantör: %s   modell: %s", provider, model)

    interval = 60.0 / args.rpm if args.rpm else 0.0
    records, last = [], 0.0
    for done, row in enumerate(test.itertuples(), start=1):
        if interval:
            wait = interval - (time.time() - last)
            if wait > 0:
                time.sleep(wait)
            last = time.time()

        path, status, _ = image_store.fetch_one(row.image_url)
        if path is None:
            records.append({"truth": row.truth, "predicted": None,
                            "method": "ingen_bild"})
            continue
        attrs = Attributes()
        attrs.set("base", "bord", "text", 0.95, "givet i mätningen")
        info = vision_layer.ask(
            [Path(path).read_bytes()], attrs,
            hint=blind(row.search_blob)[:160],   # BLINDAD
            client=client, model=model, min_impact=0)
        answer = (info.get("answers") or {}).get("set_items") or {}
        raw = answer.get("value")
        count = None if raw in (None, "gar_inte_se") else int(raw)
        records.append({
            "truth": row.truth,
            "raw": raw,
            "count": count,
            "predicted": None if count is None else ("inga" if count == 0 else "ingar"),
            "confidence": answer.get("confidence"),
            "evidence": answer.get("evidence"),
            "method": info.get("method"),
            "error": (info.get("error") or "")[:120],
            "name": str(row.name)[:80],
            "price": row.price,
        })
        log.info("%d/%d  facit=%-6s svar=%-4s", done, len(test), row.truth, raw)

    data = pd.DataFrame(records)
    data.to_csv("type_system/set_items_direction.csv", index=False)
    answered = data[data["predicted"].notna()]

    report = {"model": model, "n": int(len(data)),
              "answered": int(len(answered)),
              "failures": int((data["method"] == "fel").sum())}
    print(f"\nmodell: {model}   n = {len(data)}   svar: {len(answered)}   "
          f"misslyckade: {report['failures']}")
    if len(answered):
        matrix = pd.crosstab(answered["truth"], answered["predicted"])
        print("\nförväxlingsmatris (rad = facit, kolumn = modellens svar):")
        print(matrix.to_string())
        for side in ("inga", "ingar"):
            part = answered[answered["truth"] == side]
            if len(part):
                acc = float((part["predicted"] == side).mean())
                report[f"accuracy_{side}"] = round(acc, 3)
                print(f"\n  facit '{side}': {len(part)} fall, rätt {acc*100:.0f} %")
        false_pos = answered[(answered["truth"] == "inga")
                             & (answered["predicted"] == "ingar")]
        report["false_positive_rate"] = (
            round(float(len(false_pos) / max(1, (answered["truth"] == "inga").sum())), 3))
        print(f"\nFALSKT POSITIVA (ser stolar som inte ingår): "
              f"{len(false_pos)} — dessa skulle prissättas som matgrupp, 0,52x")
        for _, r in false_pos.head(6).iterrows():
            print(f"   {r['name'][:56]:<56} svar={r['raw']}  {str(r['evidence'])[:44]}")
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nskrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
