#!/usr/bin/env python
"""Mäter L3 — kan vision-modellen sätta rätt attribut, och vad kostar det?

    python measure_vision_layer.py --pilot          # 20 anrop, kontrollerar kedjan
    python measure_vision_layer.py --per-group 100  # skarp körning

Mätningen ställer **en** fråga per annons, om det attribut som är prisviktigt för
just den möbeln. Skälet är både kostnad och tolkbarhet: ställs fem frågor på en
gång går det inte att säga vilken av dem modellen klarade.

**Facit är textens attribut, och texten måste därför blindas i prompten.** Utan
blindning läser modellen svaret ur annonstexten i stället för ur bilden, och
mätningen blir värdelös. `hint` skickas blindad.

**Två av de fyra prisviktiga förväxlingarna kan inte mätas här:**

* `convertible` (bäddsoffa -> soffa, 87 %) frågas aldrig ur en bild. En ihopfälld
  bäddsoffa ser ut som en soffa; frågan går till L4.
* `stol <-> fåtölj` finns inte som attribut i den nya modellen — båda är
  `base=stol` utan undertyp, eftersom prisrelevansmätningen aldrig prövade dem.

Kvar att mäta: `corner`, `set_items`, `storage_kind`, `seats`.

Bilderna hämtas via den befintliga cachen i `price_engine.images` och sparas
aldrig på nytt ställe.
"""

from __future__ import annotations

import argparse
import base64
import collections
import json
import logging
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

from measure_type_system import MIN_CELL, blind, price_cells
from price_engine import config
from price_engine import images as image_store
from price_engine.data_loader import load_listings
from type_system import model_tokens, vision_layer
from type_system.attributes import SET_ITEMS_UNKNOWN, Attributes, derive_type
from type_system.text_layer import extract

log = logging.getLogger("l3")
OUT = Path("type_system/vision_measurement.json")
SEED = 20260808

#: Grupperna som mäts, med hur facit läses ur texten.
GROUPS = {
    "corner": {
        "base": "soffa",
        "values": (True, False),
        "filter": r"hornsoffa|vinkelsoffa|l-soffa|soffa",
    },
    "set_items": {
        "base": "bord",
        "values": ("ingar", "inga"),
        "filter": r"matbord|matgrupp|matsalsgrupp",
    },
    "storage_kind": {
        "base": "forvaring",
        "values": ("byra", "hylla", "skank", "vitrin"),
        "filter": r"byra|hylla|bokhylla|skank|sideboard|vitrin",
    },
    "seats": {
        "base": "soffa",
        "values": (2, 3, 4),
        "filter": r"\d-sits|sitssoffa",
    },
}


def truth_of(attribute: str, attrs: Attributes):
    """Textens facit för attributet, normaliserat till gruppens värdemängd."""
    if attribute == "corner":
        # Texten säger bara True. Frånvaro av hörnord i en soffannons som ANGER
        # sin form (rak/N-sits) räknas som False; annars okänt.
        if attrs.get("corner") is True:
            return True
        if attrs.get("seats") is not None and attrs.get("chaise") is None:
            return False
        return None
    if attribute == "set_items":
        value = attrs.get("set_items")
        if value is None:
            return None
        return "inga" if value == 0 else "ingar"
    if attribute == "seats":
        return attrs.get("seats")
    return attrs.get(attribute)


def predicted_of(attribute: str, raw):
    if raw is None:
        return None
    if attribute == "set_items":
        return "inga" if raw == 0 else "ingar"
    return raw


def build(listings: pd.DataFrame, per_group: int) -> pd.DataFrame:
    usable = image_store.usable(listings)
    usable = usable[usable["image_url"].notna() & usable["image_url"].ne("")]
    log.info("Annonser med hämtbar bild: %d", len(usable))

    rows = []
    for attribute, spec in GROUPS.items():
        pool = usable[usable["search_blob"].str.contains(spec["filter"], na=False)]
        picked = []
        for blob, name, url, price, kind in zip(
                pool["search_blob"], pool["name_norm"], pool["image_url"],
                pool["price"], pool["price_kind"]):
            attrs = extract(blob, prenormalized=True)
            if attrs.get("base") != spec["base"]:
                continue
            truth = truth_of(attribute, attrs)
            if truth is None or truth not in spec["values"]:
                continue
            picked.append({"attribute": attribute, "truth": truth,
                           "search_blob": blob, "name_norm": name,
                           "image_url": url, "price": float(price),
                           "price_kind": kind})
        frame = pd.DataFrame(picked)
        if frame.empty:
            log.warning("%s: inga kandidater", attribute)
            continue
        # Balansera över facitvärdena, annars mäter man klassfördelningen.
        per_value = max(1, per_group // frame["truth"].nunique())
        balanced = (frame.groupby("truth", group_keys=False)
                    .apply(lambda g: g.sample(min(len(g), per_value),
                                              random_state=SEED)))
        rows.append(balanced)
        log.info("%s: %d annonser, fördelning %s", attribute, len(balanced),
                 balanced["truth"].value_counts().to_dict())
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()


def ask_one(row, client, retries: int = 3) -> dict:
    """Hämtar bilden och ställer EN fråga. Returnerar svaret plus diagnostik."""
    path, status, _ = image_store.fetch_one(row.image_url)
    if path is None:
        return {"method": "ingen_bild", "fetch": status}
    try:
        blob = Path(path).read_bytes()
    except OSError as exc:
        return {"method": "lasfel", "error": str(exc)[:120]}

    attrs = Attributes()
    attrs.set("base", GROUPS[row.attribute]["base"], "text", 0.95, "givet i mätningen")
    started = time.time()
    # Kvotfel är övergående på gratisnivån och ska inte räknas som att modellen
    # inte kunde svara. Andra fel återförsöks inte — de är verkliga.
    for attempt in range(max(1, retries)):
        fresh = Attributes()
        fresh.set("base", GROUPS[row.attribute]["base"], "text", 0.95,
                  "givet i mätningen")
        info = vision_layer.ask(
            [blob], fresh,
            hint=blind(row.search_blob)[:160],   # BLINDAD — annars läcker facit
            client=client,
            min_impact=0,                        # mätningen styr urvalet
        )
        error = str(info.get("error") or "")
        if info.get("method") != "fel" or not any(
                sign in error for sign in ("429", "quota", "rate", "RESOURCE_EXHAUSTED")):
            attrs = fresh
            break
        wait = 5 * (attempt + 1)
        log.info("kvotfel, väntar %d s (försök %d/%d)", wait, attempt + 1, retries)
        time.sleep(wait)
    info["seconds"] = round(time.time() - started, 2)
    info["attempts"] = attempt + 1
    info["fetch"] = status
    info["value"] = attrs.get(row.attribute)
    return info


def krona_impact(cells, token, kind, truth_type, predicted_type, own_price):
    if predicted_type == truth_type:
        return 0.0
    left = cells.get((token, predicted_type, kind))
    right = cells.get((token, truth_type, kind))
    if left is None or right is None:
        return None
    return abs(float(np.median(left)) - float(np.median(right)))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_vision_layer.py")
    parser.add_argument("--per-group", type=int, default=100)
    parser.add_argument("--groups", default=None,
                        help="Kommaseparerade attribut att mäta. Utelämnas = alla.")
    parser.add_argument("--pilot", action="store_true",
                        help="20 anrop för att kontrollera kedjan och kostnaden")
    parser.add_argument("--model", default=None)
    parser.add_argument("--rpm", type=int, default=0,
                        help="Max anrop per minut. Googles gratisnivå har hård "
                             "RPM-gräns; 0 = ingen strypning.")
    parser.add_argument("--retries", type=int, default=3)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if args.groups:
        wanted = {g.strip() for g in args.groups.split(",")}
        for name in list(GROUPS):
            if name not in wanted:
                GROUPS.pop(name)
        log.info("Mäter bara: %s", ", ".join(GROUPS))

    listings = load_listings()
    test = build(listings, 5 if args.pilot else args.per_group)
    if test.empty:
        log.error("Tom testmängd")
        return 1
    log.info("Testmängd: %d annonser", len(test))

    # Klienten MÅSTE komma från vision_layer, inte konstrueras här. En naken
    # `OpenAI()` ignorerar AI_BASE_URL och går till api.openai.com — mätningen
    # såg då ut att köra mot Gemini men talade med OpenAI, och varje anrop
    # svarade 404 på ett modellnamn OpenAI aldrig hört talas om.
    # Går anropen via edge-funktionen ska INGEN klient skickas med — en explicit
    # klient vinner över edge-vägen, och skulle här tyst styra om mätningen till
    # fel leverantör. Exakt det felet kostade en halv körning en gång.
    if config.VISION_EDGE_URL:
        client, provider = None, config.VISION_EDGE_URL
        model_name = args.model or config.VISION_EDGE_MODEL
    else:
        client, provider = vision_layer._client(), config.AI_BASE_URL or "openai"
        model_name = args.model or config.VARIANT_MODEL
    log.info("Leverantör: %s   modell: %s", provider, model_name)

    interval = 60.0 / args.rpm if args.rpm else 0.0
    records, tokens_used, last = [], 0, 0.0
    for done, row in enumerate(test.itertuples(), start=1):
        if interval:
            wait = interval - (time.time() - last)
            if wait > 0:
                time.sleep(wait)
            last = time.time()
        info = ask_one(row, client, args.retries)
        tokens_used += int(info.get("tokens") or 0)
        predicted = predicted_of(row.attribute, info.get("value"))
        answers = info.get("answers") or {}
        raw = (answers.get(row.attribute) or {}).get("value")
        records.append({
            "attribute": row.attribute,
            "truth": row.truth,
            "predicted": predicted,
            "raw": raw,
            "abstained": raw == "gar_inte_se",
            "confidence": (answers.get(row.attribute) or {}).get("confidence"),
            "evidence": (answers.get(row.attribute) or {}).get("evidence"),
            "method": info.get("method"),
            "mode": info.get("mode"),
            "model": info.get("model"),
            "attempts": info.get("attempts"),
            "error": (info.get("error") or "")[:120],
            "tokens": info.get("tokens"),
            "seconds": info.get("seconds"),
            "name_norm": row.name_norm,
            "price": row.price,
            "price_kind": row.price_kind,
            "search_blob": row.search_blob,
        })
        if done % 25 == 0:
            log.info("%d / %d  (%d tokens hittills)", done, len(test), tokens_used)

    data = pd.DataFrame(records)
    data.to_csv("type_system/vision_measurement.csv", index=False)

    report = {"n": int(len(data)), "tokens": int(tokens_used),
              "model": model_name,
              "endpoint": provider,
              "modes": data["mode"].value_counts().to_dict() if "mode" in data else {},
              "failures": int((data["method"] == "fel").sum()),
              "per_attribute": {}}
    print(f"\nmodell: {report['model']}   endpoint: {report['endpoint']}")
    print(f"lägen: {report['modes']}   misslyckade anrop: {report['failures']}")
    print(f"n = {len(data):,}   tokens = {tokens_used:,}")
    print(f"\n{'attribut':<15}{'n':>5}{'avstår':>9}{'svarar':>9}"
          f"{'rätt|svar':>11}{'rätt|alla':>11}{'fel':>6}")
    for attribute, group in data.groupby("attribute", observed=True):
        answered = group[~group["abstained"] & group["predicted"].notna()]
        correct = answered["predicted"] == answered["truth"]
        block = {
            "n": int(len(group)),
            "abstain_rate": round(float(group["abstained"].mean()), 3),
            "answer_rate": round(float(len(answered) / len(group)), 3),
            "accuracy_when_answering": (round(float(correct.mean()), 3)
                                        if len(answered) else None),
            "accuracy_overall": round(float(
                ((group["predicted"] == group["truth"]) & ~group["abstained"]).mean()), 3),
            "confusion": {
                f"{t} -> {p}": int(c) for (t, p), c in
                answered.groupby(["truth", "predicted"]).size().items()
            },
        }
        report["per_attribute"][str(attribute)] = block
        acc = f"{block['accuracy_when_answering']*100:.1f}%" if block["accuracy_when_answering"] is not None else "—"
        print(f"{attribute:<15}{block['n']:>5}{block['abstain_rate']*100:>8.0f}%"
              f"{block['answer_rate']*100:>8.0f}%{acc:>11}"
              f"{block['accuracy_overall']*100:>10.1f}%"
              f"{int(len(answered) - correct.sum()):>6}")

    print("\n=== förväxlingar ===")
    for attribute, block in report["per_attribute"].items():
        wrong = {k: v for k, v in block["confusion"].items()
                 if k.split(" -> ")[0] != k.split(" -> ")[1]}
        if wrong:
            print(f"  {attribute}: " + ", ".join(
                f"{k} ({v})" for k, v in sorted(wrong.items(), key=lambda kv: -kv[1])))

    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nskrivet till {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
