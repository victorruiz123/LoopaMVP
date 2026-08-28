#!/usr/bin/env python
"""Mäter typsystemet lager för lager — med kronofelet som huvudmått.

    python measure_type_system.py --per-base 400

**Ren träffsäkerhet är fel mått.** `matbord -> matgrupp` flyttar priset med 48 %,
`hylla -> bokhylla` med noll. Ett system som har 80 % rätt kan vara sämre än ett
med 70 % om de 20 procenten ligger på de dyra förväxlingarna. Huvudmåttet här är
därför **prisfelet i kronor** som typfelet orsakar: skillnaden mellan medianen i
den jämförelsemängd motorn skulle valt och medianen i den rätta.

**Blindläget är hela poängen.** Facit kommer ur annonstexten, så att mäta L0 mot
texten är cirkulärt — L0 får per definition 100 %. Frågetexten blindas därför:
alla typord stryks, modellorden behålls. Det simulerar en användare som skriver
"Kivik" utan att säga vad det är, vilket är precis det fall bilden och priorn
finns för.

**Läckagespärren** maskerar annonsens egen vektor och hela dubblettgruppen (samma
titel + pris). Tradera har 65 % dubblettbilder, och en kopia av samma foto läcker
svaret precis lika bra som originalet. Priorn räknas av leave-one-out ur de
sparade råa räknarna.
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import re
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

from price_engine import config
from price_engine.data_loader import load_listings
from price_engine.vectors import load_vectors
from type_system import image_layer, lexicon as lex, model_tokens
from type_system.attributes import Attributes, derive_type
from type_system.prior import MAX_ENTROPY, MIN_LISTINGS, MIN_SHARE, Prior, entropy
from type_system.text_layer import extract

log = logging.getLogger("typsystem")
OUT = Path("type_system/system_measurement.json")
SEED = 20260807

#: Minsta antal annonser i en (modellord, typ)-cell för att kronofelet ska räknas.
MIN_CELL = 5

#: Alla ord L0 kan läsa en bastyp eller ett attribut ur. Blindningen stryker dem.
_TYPE_WORDS = tuple(sorted(
    {w for words in lex.BASE_WORDS.values() for w in words}
    | set(lex.CHAISE_WORDS) | set(lex.CORNER_WORDS) | set(lex.CONVERTIBLE_WORDS)
    | set(lex.CORNER_AMBIGUOUS)
    | {w for words in lex.STORAGE_KINDS.values() for w in words}
    | {w for words in lex.TABLE_SUBS.values() for w in words},
    key=len, reverse=True))
_BLIND = re.compile("|".join(re.escape(w) for w in _TYPE_WORDS))
#: Sits- och stolsantal är också typsignaler och måste bort i blindläget.
_BLIND_NUM = re.compile(r"\d+\s*-?\s*sit(?:s|t)\w*|\d+\s+(?:st\s+)?stolar"
                        r"|(?:med|och|inkl|inklusive|\+)\s+stolar")


def blind(text: str) -> str:
    """Stryker typorden, behåller modellorden. "kivik hornsoffa 3-sits" -> "kivik"."""
    out = _BLIND_NUM.sub(" ", text or "")
    out = _BLIND.sub(" ", out)
    return re.sub(r"\s+", " ", out).strip()


# --------------------------------------------------------------------------
# Prisunderlag för kronofelet
# --------------------------------------------------------------------------
def price_cells(listings: pd.DataFrame, known: set) -> dict:
    """(modellord, typ) -> np.array av priser.

    Det här är approximationen av "jämförelsemängdens median". Den är inte
    identisk med vad `pricing.py` faktiskt väljer — den saknar färskhetsfilter
    och viktning — men den fångar det som typfelet ändrar, vilket är vad som ska
    mätas.
    """
    cells: dict = collections.defaultdict(list)
    for name, blob, price, kind in zip(
            listings["name_norm"], listings["search_blob"],
            listings["price"], listings["price_kind"]):
        if not price or price <= 0:
            continue
        kind_of = derive_type(extract(blob, prenormalized=True))
        if kind_of is None:
            continue
        for token in set(model_tokens.of(name, known)):
            cells[(token, kind_of, kind)].append(float(price))
    return {key: np.array(values) for key, values in cells.items()
            if len(values) >= MIN_CELL}


def krona_error(cells: dict, token: str, kind: str, truth: str, predicted: str,
                own_price: float) -> tuple:
    """Prisfelet i kronor och som kvot. (kronor, kvot) eller (None, None).

    Annonsens eget pris räknas av ur båda cellerna — annars mäter man delvis att
    annonsen känner igen sig själv.
    """
    if predicted == truth:
        return 0.0, 1.0
    left = cells.get((token, predicted, kind))
    right = cells.get((token, truth, kind))
    if left is None or right is None:
        return None, None
    right = _drop_one(right, own_price)
    if right is None or not len(right):
        return None, None
    med_true = float(np.median(right))
    med_pred = float(np.median(_drop_one(left, own_price)
                               if _drop_one(left, own_price) is not None else left))
    if med_true <= 0:
        return None, None
    return abs(med_pred - med_true), med_pred / med_true


def _drop_one(values: np.ndarray, price: float):
    hit = np.flatnonzero(np.isclose(values, price))
    if not len(hit):
        return values
    return np.delete(values, hit[0])


# --------------------------------------------------------------------------
# Priorn, leave-one-out
# --------------------------------------------------------------------------
def prior_loo(prior: Prior, text: str, truth_base: str) -> tuple:
    """Priorns bas-gissning med annonsens eget bidrag avräknat.

    Utan avräkning mäter man att priorn känner igen den annons den byggdes av.
    Effekten är liten för stora modellord och avgörande för små — och det är just
    de små som avgör om `MIN_LISTINGS` är rätt satt.
    """
    token, entry = prior.lookup(text)
    if not token:
        return None, 0.0, None
    block = (entry.get("attributes") or {}).get("base")
    if not block or "counts" not in block:
        return None, 0.0, token
    counts = dict(block["counts"])
    if truth_base in counts:
        counts[truth_base] -= 1
        if counts[truth_base] <= 0:
            counts.pop(truth_base)
    total = sum(counts.values())
    if total < MIN_LISTINGS or not counts:
        return None, 0.0, token
    value, top = max(counts.items(), key=lambda kv: kv[1])
    share = top / total
    if share < MIN_SHARE or entropy(counts) > MAX_ENTROPY:
        return None, share, token
    return value, share, token


# --------------------------------------------------------------------------
# Konfigurationerna som jämförs
# --------------------------------------------------------------------------
CONFIGS = ("blind text", "text+prior", "bild (familj)", "text+prior+bild",
           "gammal platt klassificerare")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="measure_type_system.py")
    parser.add_argument("--per-base", type=int, default=400)
    parser.add_argument("--abstain", type=float, default=image_layer.ABSTAIN_BELOW)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    store = load_vectors()
    if not store.ready:
        log.error("Inget vektorlager")
        return 1
    prior = Prior.load()
    if not prior.ready:
        log.error("Ingen prior — kör build_model_prior.py först")
        return 1

    known_tokens = model_tokens.distinctive(listings["name_norm"], 12, 40_000)
    log.info("Modellord: %d", len(known_tokens))
    log.info("Bygger prisceller ...")
    cells = price_cells(listings, known_tokens)
    log.info("Prisceller med >=%d annonser: %d", MIN_CELL, len(cells))

    rows = store.rows_for(listings)
    frame = listings.assign(vecrow=rows)
    frame = frame[frame["vecrow"] >= 0].copy()
    frame["truth_base"] = [extract(b, prenormalized=True).get("base")
                           for b in frame["search_blob"]]
    frame["truth_type"] = [derive_type(extract(b, prenormalized=True))
                           for b in frame["search_blob"]]
    frame = frame[frame["truth_base"].notna() & frame["truth_type"].notna()]
    frame["tokens"] = [model_tokens.of(n, known_tokens) for n in frame["name_norm"]]
    frame = frame[frame["tokens"].map(len) > 0]
    log.info("Kandidater: %d", len(frame))

    picked = []
    for base, group in frame.groupby("truth_base", observed=True):
        take = min(len(group), args.per_base)
        if take < 30:
            continue
        picked.append(group.sample(take, random_state=SEED))
    test = pd.concat(picked, ignore_index=True)
    log.info("Testmängd: %d annonser över %d bastyper",
             len(test), test["truth_base"].nunique())

    # Läckagespärr: rad -> alla rader med samma (titel, pris)
    dup = pd.DataFrame({
        "key": list(zip(listings["name_norm"], listings["price"])),
        "row": rows,
    })
    dup = dup[dup["row"] >= 0]
    duplicates = dup.groupby("key")["row"].apply(lambda s: set(s.tolist())).to_dict()

    bases = image_layer.row_bases(store, listings)
    from price_engine import visual_variant
    old_variants = visual_variant.row_variants(store, listings)

    records = []
    for done, row in enumerate(test.itertuples(), start=1):
        if done % 500 == 0:
            log.info("%d / %d", done, len(test))
        blocked = {int(row.vecrow)} | duplicates.get(
            (row.name_norm, float(row.price)), set())
        blind_text = blind(row.search_blob)
        token = row.tokens[0]

        # --- L2: familjeröst med läckagespärr ---------------------------
        scores = store.embeddings @ store.embeddings[int(row.vecrow)]
        for masked in blocked:
            if 0 <= masked < len(scores):
                scores[masked] = -1.0
        image_base, image_share = _family_vote(scores, bases, args.abstain)
        old_type = _old_vote(scores, old_variants)

        # --- konfigurationerna ------------------------------------------
        results = {}

        blind_attrs = extract(blind_text)
        results["blind text"] = blind_attrs

        prior_attrs = extract(blind_text)
        loo_base, loo_share, _ = prior_loo(prior, blind_text, str(row.truth_base))
        if loo_base and not prior_attrs.known("base"):
            prior_attrs.set("base", loo_base, "prior", loo_share)
        results["text+prior"] = prior_attrs

        only_image = Attributes()
        if image_base:
            only_image.set("base", image_base, "image", image_share)
        results["bild (familj)"] = only_image

        full = extract(blind_text)
        if loo_base and not full.known("base"):
            full.set("base", loo_base, "prior", loo_share)
        if image_base and not full.known("base"):
            if not prior.contradicts(blind_text, "base", image_base):
                full.set("base", image_base, "image", image_share)
        results["text+prior+bild"] = full

        record = {
            "truth_base": str(row.truth_base),
            "truth_type": str(row.truth_type),
            "token": token,
            "price_kind": str(row.price_kind),
            "blocked": len(blocked),
            "image_share": image_share,
        }
        for name, attrs in results.items():
            predicted = derive_type(attrs)
            record[f"{name}|type"] = predicted
            record[f"{name}|base"] = attrs.get("base")
            record[f"{name}|source"] = attrs.source("base")
            kronor, ratio = (None, None)
            if predicted is not None:
                kronor, ratio = krona_error(cells, token, str(row.price_kind),
                                            str(row.truth_type), predicted,
                                            float(row.price))
            record[f"{name}|kronor"] = kronor
            record[f"{name}|ratio"] = ratio
        record["gammal platt klassificerare|type"] = old_type
        kronor, ratio = (None, None)
        if old_type is not None:
            kronor, ratio = krona_error(cells, token, str(row.price_kind),
                                        str(row.truth_type), old_type,
                                        float(row.price))
        record["gammal platt klassificerare|kronor"] = kronor
        record["gammal platt klassificerare|ratio"] = ratio
        records.append(record)

    data = pd.DataFrame(records)
    report = _summarise(data, args)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    data.to_csv("type_system/system_measurement.csv", index=False)
    _print(report)
    return 0


def _family_vote(scores: np.ndarray, bases: np.ndarray, abstain: float) -> tuple:
    k = config.VISUAL_VARIANT_K
    top = np.argpartition(scores, -k)[-k:]
    top = top[np.argsort(scores[top])[::-1]]
    top = top[scores[top] >= config.VISUAL_VARIANT_MIN_SIM]
    if len(top) < image_layer.MIN_VOTES:
        return None, 0.0
    votes: dict = {}
    for row, score in zip(top, scores[top]):
        base = bases[row]
        if base is not None:
            votes[base] = votes.get(base, 0.0) + float(score)
    if not votes:
        return None, 0.0
    grand = sum(votes.values())
    winner, weight = max(votes.items(), key=lambda kv: kv[1])
    share = weight / grand
    return (str(winner) if share >= abstain else None), round(share, 3)


def _old_vote(scores: np.ndarray, variants: np.ndarray):
    """Baslinje (b): dagens platta klassificerare, 14 typer."""
    k = config.VISUAL_VARIANT_K
    top = np.argpartition(scores, -k)[-k:]
    top = top[np.argsort(scores[top])[::-1]]
    top = top[scores[top] >= config.VISUAL_VARIANT_MIN_SIM]
    if len(top) < config.VISUAL_VARIANT_MIN_VOTES:
        return None
    votes: dict = {}
    for row, score in zip(top, scores[top]):
        label = variants[row]
        if label is not None:
            votes[label] = votes.get(label, 0.0) + float(score)
    if not votes:
        return None
    return str(max(votes.items(), key=lambda kv: kv[1])[0])


#: Den gamla platta klassificeraren svarar med fin typ. För att kunna jämföra
#: bastypsträffsäkerhet måste dess svar kollapsas till familj.
TYPE2BASE = {
    "soffa": "soffa", "hornsoffa": "soffa", "baddsoffa": "soffa",
    "stol": "stol", "fatolj": "stol",
    "bord": "bord", "matbord": "bord", "matgrupp": "bord", "soffbord": "bord",
    "sidobord": "bord", "skrivbord": "bord",
    "byra": "forvaring", "hylla": "forvaring", "skank": "forvaring",
    "vitrin": "forvaring", "forvaring": "forvaring",
    "sang": "sang", "sanggavel": "sanggavel", "spegel": "spegel",
    "fotpall": "fotpall",
}


def _summarise(data: pd.DataFrame, args) -> dict:
    """Sammanfattar mätningen.

    Måttet är omkonstruerat efter en första körning som var oläsbar. Två fel:

    * **Medianen togs över alla fall.** Eftersom majoriteten är rätt blev
      kronofelets median 0 för samtliga konfigurationer. Det intressanta talet är
      felet *villkorat på att det blev fel*, plus väntevärdet över alla fall.
    * **Konfigurationerna mättes på olika delmängder.** Den gamla platta
      klassificeraren såg bäst ut på kronofel enbart för att dess mätbara
      delmängd var mindre och lättare. Jämförelsen görs därför också på snittet
      av det som är mätbart i ALLA konfigurationer.

    Dessutom mäts nu `base` separat från hela typen. L2 påstår bara `base`, och
    att döma lagret på undertypen är att mäta något det aldrig gjorde anspråk på.
    """
    if "gammal platt klassificerare|base" not in data:
        data = data.copy()
        data["gammal platt klassificerare|base"] = (
            data["gammal platt klassificerare|type"].map(TYPE2BASE))

    report = {"n": int(len(data)), "abstain_threshold": args.abstain,
              "configs": {}, "per_base": {}, "abstain_curve": [],
              "common_subset": {}, "prior_vs_image": {}}

    measurable = {name: pd.to_numeric(data[f"{name}|kronor"],
                                      errors="coerce").notna()
                  for name in CONFIGS}
    common = np.logical_and.reduce(
        [measurable[n].to_numpy() for n in CONFIGS if n != "blind text"])

    for name in CONFIGS:
        types = data[f"{name}|type"]
        answered = types.notna()
        correct = types == data["truth_type"]
        base_col = data.get(f"{name}|base")
        base_ok = None
        if base_col is not None:
            has_base = base_col.notna()
            base_ok = (round(float((base_col == data["truth_base"])[has_base].mean()), 3)
                       if has_base.any() else None)
        kronor = pd.to_numeric(data[f"{name}|kronor"], errors="coerce")
        mask = measurable[name]
        wrong = mask & ~correct
        report["configs"][name] = {
            "coverage": round(float(answered.mean()), 3),
            "accuracy_base": base_ok,
            "accuracy_type": round(float(correct[answered].mean()), 3) if answered.any() else None,
            "krona_median_when_wrong": round(float(kronor[wrong].median()), 1) if wrong.any() else None,
            "krona_p90_when_wrong": round(float(kronor[wrong].quantile(0.90)), 1) if wrong.any() else None,
            "krona_expected": round(float(kronor[mask].mean()), 1) if mask.any() else None,
            "n_measurable": int(mask.sum()),
            "n_wrong": int(wrong.sum()),
        }
        if common.any():
            sub = data[common]
            sub_kr = pd.to_numeric(sub[f"{name}|kronor"], errors="coerce")
            sub_ok = sub[f"{name}|type"] == sub["truth_type"]
            sub_base = sub.get(f"{name}|base")
            report["common_subset"][name] = {
                "n": int(common.sum()),
                "accuracy_base": (round(float((sub_base == sub["truth_base"]).mean()), 3)
                                  if sub_base is not None else None),
                "accuracy_type": round(float(sub_ok.mean()), 3),
                "krona_expected": round(float(sub_kr.mean()), 1),
                "krona_median_when_wrong": (round(float(sub_kr[~sub_ok].median()), 1)
                                            if (~sub_ok).any() else None),
            }

    # --- priorn mot bilden, huvud mot huvud -------------------------------
    prior_base = data["text+prior|base"]
    image_base = data["bild (familj)|base"]
    both = prior_base.notna() & image_base.notna()
    if both.any():
        pair = data[both]
        disagree = pair["text+prior|base"] != pair["bild (familj)|base"]
        report["prior_vs_image"] = {
            "n_both_answer": int(both.sum()),
            "prior_base_accuracy": round(float((pair["text+prior|base"] == pair["truth_base"]).mean()), 3),
            "image_base_accuracy": round(float((pair["bild (familj)|base"] == pair["truth_base"]).mean()), 3),
            "n_disagree": int(disagree.sum()),
            "when_disagree": {
                "prior_right": round(float((pair[disagree]["text+prior|base"] == pair[disagree]["truth_base"]).mean()), 3),
                "image_right": round(float((pair[disagree]["bild (familj)|base"] == pair[disagree]["truth_base"]).mean()), 3),
            } if disagree.any() else {},
        }
    for base, group in data.groupby("truth_base", observed=True):
        block = {"n": int(len(group))}
        for name in CONFIGS:
            kronor = pd.to_numeric(group[f"{name}|kronor"], errors="coerce")
            base_col = group.get(f"{name}|base")
            block[name] = {
                "accuracy": round(float((group[f"{name}|type"] == group["truth_type"]).mean()), 3),
                "accuracy_base": (round(float((base_col == group["truth_base"]).mean()), 3)
                                  if base_col is not None else None),
                "krona_expected": round(float(kronor.mean()), 1) if kronor.notna().any() else None,
            }
        report["per_base"][str(base)] = block

    shares = pd.to_numeric(data["image_share"], errors="coerce")
    for cut in np.round(np.arange(0.30, 0.96, 0.05), 2):
        answering = shares >= cut
        if not answering.any():
            continue
        base_hit = (data["bild (familj)|base"] == data["truth_base"])
        report["abstain_curve"].append({
            "min_share": float(cut),
            "coverage": round(float(answering.mean()), 3),
            "base_accuracy": round(float(base_hit[answering].mean()), 3),
            "n": int(answering.sum()),
        })
    return report


def _print(report: dict) -> None:
    def num(value, width, decimals=0):
        if value is None:
            return "—".rjust(width)
        return format(value, f",.{decimals}f").rjust(width)

    def pct(value, width):
        return "—".rjust(width) if value is None else f"{value*100:.1f}%".rjust(width)

    print(f"\nn = {report['n']:,}   avstå-tröskel = {report['abstain_threshold']}")
    print("\n=== HUVUDMÅTT: prisfel orsakat av typfel ===")
    print("kronofelet villkorat på ATT det blev fel, plus väntevärdet över alla fall\n")
    print(f"{'konfiguration':<30}{'täckn':>7}{'bas':>8}{'typ':>8}"
          f"{'kr|fel':>9}{'kr p90|fel':>12}{'väntevärde':>12}{'mätbara':>9}")
    for name, r in report["configs"].items():
        print(f"{name:<30}{pct(r['coverage'], 7)}{pct(r['accuracy_base'], 8)}"
              f"{pct(r['accuracy_type'], 8)}{num(r['krona_median_when_wrong'], 9)}"
              f"{num(r['krona_p90_when_wrong'], 12)}{num(r['krona_expected'], 12)}"
              f"{r['n_measurable']:>9,}")

    if report.get("common_subset"):
        first = next(iter(report["common_subset"].values()))
        print(f"\n=== samma sak på GEMENSAM mätbar delmängd (n = {first['n']:,}) ===")
        print("den enda jämförelsen mellan konfigurationer som är rättvis\n")
        print(f"{'konfiguration':<30}{'bas':>8}{'typ':>8}{'kr|fel':>9}{'väntevärde':>12}")
        for name, r in report["common_subset"].items():
            print(f"{name:<30}{pct(r['accuracy_base'], 8)}{pct(r['accuracy_type'], 8)}"
                  f"{num(r['krona_median_when_wrong'], 9)}{num(r['krona_expected'], 12)}")

    pvi = report.get("prior_vs_image") or {}
    if pvi:
        print(f"\n=== priorn mot bilden på `base`, huvud mot huvud ===")
        print(f"  båda svarar i {pvi['n_both_answer']:,} fall")
        print(f"     priorn rätt: {pvi['prior_base_accuracy']*100:.1f} %")
        print(f"     bilden rätt: {pvi['image_base_accuracy']*100:.1f} %")
        if pvi.get("when_disagree"):
            print(f"  oense i {pvi['n_disagree']:,} fall — där:")
            print(f"     priorn rätt: {pvi['when_disagree']['prior_right']*100:.1f} %")
            print(f"     bilden rätt: {pvi['when_disagree']['image_right']*100:.1f} %")
    print("\n=== per bastyp: bas rätt % / väntevärde kronofel ===")
    heads = "".join(f"{n[:14]:>17}" for n in CONFIGS)
    print(f"{'bastyp':<13}{'n':>6}{heads}")
    for base, block in sorted(report["per_base"].items()):
        parts = []
        for name in CONFIGS:
            accuracy = block[name].get("accuracy_base")
            shown_acc = "—" if accuracy is None else f"{round(accuracy * 100)}%"
            kronor = block[name]["krona_expected"]
            shown = "—" if kronor is None else format(kronor, ",.0f")
            parts.append("{:>17}".format("{} / {}".format(shown_acc, shown)))
        print(f"{base:<13}{block['n']:>6}" + "".join(parts))
    print("\n=== avstå-kurva, bildens familjeröst ===")
    print(f"  {'krav':>6}{'täckning':>11}{'bas rätt':>11}{'n':>8}")
    for r in report["abstain_curve"]:
        print(f"  {r['min_share']:>6.2f}{r['coverage']*100:>10.1f}%"
              f"{r['base_accuracy']*100:>10.1f}%{r['n']:>8,}")
    print(f"\nskrivet till {OUT}")


if __name__ == "__main__":
    raise SystemExit(main())
