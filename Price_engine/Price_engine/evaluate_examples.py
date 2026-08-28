#!/usr/bin/env python
"""Utvärdering mot facit: hur väl träffar motorn de godkända prisintervallen?

    python evaluate_examples.py --specs items.json --images images.json

Kör den RIKTIGA prismotorn — price_query, samma kod som API:et — på varje
exempelmöbel och jämför mot det godkända prisintervallet.

Tre konfigurationer körs per möbel, eftersom de svarar på olika frågor:

  text        märke + modellnamn. Den minimala frågan.
  bild        märke + modellnamn + foto. Produktionens fulla kedja:
              möbeltyp klassas ur bilden, kandidaterna omsorteras med DINOv2.
  typ känd    märke + modellnamn + möbeltyp angiven explicit. Övre gräns —
              vad motorn skulle klara om typdetekteringen alltid hade rätt.

Facit-intervallet används ALDRIG i sökningen, bara vid utvärderingen.
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

from price_engine import config
from price_engine.condition import build_bands
from price_engine.data_loader import load_listings
from price_engine.pricing import price_query
from price_engine.vectors import load_vectors

log = logging.getLogger("utvärdering")


def overlaps(low, high, facit_low, facit_high) -> bool:
    """Överlappar motorns intervall facit alls?"""
    if low is None or high is None:
        return False
    return low <= facit_high and high >= facit_low


def deviation(default, facit_low, facit_high) -> float:
    """Relativt avstånd från facit-intervallet. 0 när default ligger inom."""
    if default is None:
        return float("nan")
    if facit_low <= default <= facit_high:
        return 0.0
    if default < facit_low:
        return (default - facit_low) / facit_low
    return (default - facit_high) / facit_high


#: Ord som beskriver möbeltyp eller utförande, inte modellnamn. Specens
#: "Modell"-fält blandar ihop dem ("Söderhamn bäddsoffa", "Valen 224 Rak
#: soffa"), och eftersom matchningen kräver ATT ALLA ord finns i annonsen
#: kollapsar sökningen: "Söderhamn bäddsoffa" ger 2 träffar, "Söderhamn" 2 853.
#: En användare skriver modellnamnet, inte hela produktrubriken.
#: Version av MÄTINSTRUMENTET, inte av motorn. Skrivs till varje resultatfil så
#: att en siffra alltid går att knyta till det instrument som producerade den.
#:
#: Höj vid VARJE ändring av söknyckelregeln, specextraktionen eller lägesnamnen —
#: och rapportera ändringen som MÄTRÄTTELSE med omkörning av alla lägen, aldrig
#: som en förbättring. Harnessen ändrades fem gånger utan versionering, och
#: följden var att inga två körningar var jämförbara.
#:
#:   6  2026-08-17  söknyckeln rättad och fryst: märkeslösa poster skickar hela
#:                  etiketten, typord stryks aldrig när de är allt som finns
HARNESS_VERSION = 6

_TYPE_WORDS = {
    "soffa", "soffor", "baddsoffa", "bäddsoffa", "hornsoffa", "hörnsoffa",
    "fatolj", "fåtölj", "fatoljer", "fåtöljer", "matbord", "bord", "stol",
    "stolar", "kontorsstol", "matgrupp", "sang", "säng", "byra", "byrå",
    "hylla", "fotpall", "rak", "sits", "sittplatser", "classic",
    # Tillagda 2026-08-17. Att `puff` saknades var själva buggen: "soffa med
    # puff" ströps till "med puff", och `puff` är ett fotpallsord — sökningen
    # letade efter fotpallar där facit gällde en soffa (−68 %). Listan täcker nu
    # de möbelord som förekommer i specarnas modellfält.
    "puff", "sittpuff", "pall", "ottoman", "divan", "schaslong", "schäslong",
    "soffbord", "sidobord", "skrivbord", "vitrinskap", "sideboard", "skank",
    "skänk", "spegel", "kommod", "nattduksbord", "garderob", "skap", "skåp",
}


#: Ord som inte identifierar något på egen hand. Ett kärnnamn som bara består av
#: dessa är inget kärnnamn.
_FILLER = {"med", "och", "i", "till", "for", "för", "av", "plus", "samt", "utan"}


def core_name(model: str) -> str:
    """Modellnamnet utan typ- och utförandeord.

    "Söderhamn bäddsoffa" -> "Söderhamn"
    "Valen 224 Rak soffa" -> "Valen 224"
    "Capella X / Capella Classic" -> "Capella X"

    **Strykningen ångras när den skulle förstöra söknyckeln.** Typorden är ibland
    allt modellfältet innehåller, och då blir resten inte ett modellnamn utan
    skräp:

        "soffa med puff"  ->  "med puff"   <- fotpallsord, sökte fel möbel
        "säng 303"        ->  "303"        <- noll träffar

    Båda gav katastrofmissar i benchmarken (−68 % respektive inget svar) som
    tillskrevs motorn men var mätfel. Regeln är därför: resultatet måste
    innehålla minst ett BOKSTAVSORD som inte är utfyllnad, annars returneras
    modellnamnet orört. En användare som bara har typordet skriver typordet.
    """
    first = model.split("/")[0]
    kept = [w for w in first.split()
            if w.lower().strip(",.") not in _TYPE_WORDS]
    core = " ".join(kept).strip()
    meaningful = [w for w in kept
                  if w.lower().strip(",.") not in _FILLER
                  and any(ch.isalpha() for ch in w)]
    if not meaningful:
        return first.strip()
    return core or first.strip()


def search_key(item: dict) -> str:
    """Söknyckeln en användare skulle skriva, ur en specpost.

    Fyra poster i prisbenchmarkerna har varken märke eller modell i
    specstrukturen, bara en kategori. Att då söka på kategorin ensam kastar bort
    just de ord som bär värdet: "Ekbord med stolar" och "Matbord trä" fick
    IDENTISK förfrågan (`matbord`) och identiskt svar trots olika facit, och
    "Matgrupp byCrea" tappade märkesnamnet helt.

    Etiketten är vad användaren faktiskt skrev. Den används i sin helhet, minus
    utfyllnadsord — `find_listings` kräver att ALLA ord träffar, och "med" som
    hårt krav smalnar av utan att identifiera.
    """
    model = item.get("model")
    kind = str(item.get("variant") or item.get("category") or "").strip()
    if model:
        return model if not item.get("brand") else core_name(model)
    label = str(item.get("label") or "").strip()
    if label:
        words = [w for w in label.split() if w.lower().strip(",.") not in _FILLER]
        if words:
            return " ".join(words)
    return kind


def _no_openai(*args, **kwargs):
    """Stäng av bildklassningen men behåll DINOv2-omsorteringen.

    Typklassningen är motorns enda modellanrop och ligger hos OpenAI. Utan
    krediter kastar den 429, och då skulle bild-läget mäta ett API-fel i
    stället för bildmatchningen. DINOv2-delen körs lokalt och fungerar, så den
    mäts för sig.
    """
    return None


#: Sätts av --blind-type. Modulglobal eftersom run_one anropas per möbel och
#: läge, och att tråda flaggan genom varje anrop hade gett fem nya parametrar.
BLIND_TYPE = False


def run_one(listings, item, image_path, bands, store, mode: str) -> dict:
    # Fyra fall, och alla förekommer i verkliga listor:
    #   modell + märke   -> kärnnamnet, typorden kapade
    #   modell utan märke-> beskrivningen som den står (ekbordsklassen)
    #   märke utan modell-> märket plus möbeltypen; det är allt användaren har
    #   varken eller     -> bara möbeltypen
    model = item.get("model")
    kind = str(item.get("variant") or item.get("category") or "").strip()
    if BLIND_TYPE:
        # Typorden stryks ur BÅDE modellnamnet och typfältet. Utan det senare
        # läcker typen in via `kind` när modellnamn saknas, och blindläget mäter
        # ingenting.
        from measure_type_system import blind as _blind
        from price_engine.data_loader import normalize_text
        kind = _blind(normalize_text(kind))
        if model:
            model = _blind(normalize_text(model)) or model
    if mode == "modell som angiven" and model:
        name = model
    else:
        name = search_key({**item, "model": model, "variant": kind})
    # Söknyckeln kan vara kapad, men attributen ska läsas ur HELA texten.
    # `core_name` stryper typorden, och kvar blir ibland ett ord som betyder
    # något annat: "soffa med puff" -> "med puff", och `puff` är ett
    # fotpallsord. Bolia-soffan blev en fotpall av harnessen, inte av motorn.
    full_text = " ".join(part for part in (model or "", kind) if part).strip()
    kwargs = dict(name=name, brand=item["brand"], multipliers=bands,
                  attribute_text=full_text or name)

    # Storleken kommer ur specens Variant-fält när den står där ("2-sits",
    # "3-sits", "Bord och 4 stolar"). En verklig användare vet vilken storlek
    # hon har, och `core_name` kapar just de orden ur modellnamnet — utan detta
    # kan storleksnivån aldrig prövas.
    from price_engine.size import extract as _size
    spec_size = _size(str(item.get("variant") or "").lower())
    if spec_size:
        kwargs["size"] = spec_size
    if mode.startswith("kärnnamn + bild") and image_path:
        kwargs["image"] = Path(image_path).read_bytes()
        kwargs["vectors"] = store
        kwargs["classifier"] = _no_openai
    elif mode == "kärnnamn + typ":
        kwargs["variant"] = item.get("variant") or item.get("category")
    # Jämförelseläget kör den gamla bildfiltreringen, som annars är avstängd
    # via config.IMAGE_RERANK_ENABLED. Flaggan återställs alltid.
    old_rerank, old_cue = config.IMAGE_RERANK_ENABLED, config.CUE_FILTER_ENABLED
    if mode == "kärnnamn + bild (gammal filtrering)":
        config.IMAGE_RERANK_ENABLED = True
        config.CUE_FILTER_ENABLED = True
    try:
        return price_query(listings, **kwargs)
    except Exception as exc:  # pragma: no cover - loggas och rapporteras
        log.warning("Möbel %s (%s) misslyckades: %s", item["nr"], mode, exc)
        return {"default": None, "low": None, "high": None, "matchCount": 0,
                "note": f"fel: {exc}", "variantMethod": "error"}
    finally:
        config.IMAGE_RERANK_ENABLED, config.CUE_FILTER_ENABLED = old_rerank, old_cue


#: Felklasser för rapporteringen. En totalsiffra döljer vilken sorts fel som
#: återstår, och de fyra kräver helt olika åtgärder.
ERROR_CLASSES = {
    "storlek": "storleksvariant av samma modell",
    "anonym": "inget märke eller modellnamn (ekbordsklassen)",
    "tunt": "under 20 träffar",
    "övrigt": "allt annat",
}


def classify_case(item: dict, result: dict) -> str:
    """Vilken felklass hör fallet till? Avgörs av fallet, inte av utfallet."""
    if not item.get("brand") and not item.get("model"):
        return "anonym"
    from price_engine.size import extract as _size
    if _size(str(item.get("variant") or "").lower()):
        return "storlek"
    if (result.get("matchCount") or 0) < 20:
        return "tunt"
    return "övrigt"


def composition_report(items: list) -> dict:
    """Räknar av listan mot sammansättningskraven i TESTFALL_MALL.md."""
    from price_engine.size import extract as _size

    anonymous = sum(1 for i in items if not i.get("brand") and not i.get("model"))
    sized = sum(1 for i in items
                if _size(str(i.get("variant") or "").lower()))
    with_image = sum(1 for i in items if i.get("img"))
    requirements = {
        "fall totalt (20-30)": (len(items), 20),
        "storleksvarianter (>= 5)": (sized, 5),
        "anonyma utan modellnamn (>= 5)": (anonymous, 5),
        "med bild": (with_image, 0),
    }
    return {
        name: {"antal": value, "krav": floor, "uppfyllt": value >= floor}
        for name, (value, floor) in requirements.items()
    }


def spec_fingerprint(path: Path) -> str:
    """Hash av specfilen. Skrivs till resultatet så att en ändrad testmängd
    inte tyst kan förväxlas med den ursprungliga — frysregel 4."""
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="evaluate_examples.py")
    parser.add_argument("--specs", required=True)
    parser.add_argument("--check-composition", action="store_true",
                        help="Räkna av mängden mot sammansättningskraven och avsluta")
    parser.add_argument("--frozen", action="store_true",
                        help="Skriv specfilens hash till resultatet (frysregel)")
    parser.add_argument("--images", default=None)
    parser.add_argument("--out", default="evaluation")
    parser.add_argument("--blind-type", action="store_true",
                        help="Stryk möbeltypen ur frågan. Enda sättet att mäta "
                             "om kedjan hjälper när användaren inte säger vad "
                             "möbeln är.")
    parser.add_argument("--modes",
                        default="modell som angiven,kärnnamn,kärnnamn + bild,kärnnamn + typ")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s: %(message)s")

    items = json.loads(Path(args.specs).read_text())

    if args.check_composition:
        report = composition_report(items)
        print(f"{'krav':<34}{'antal':>7}{'krävs':>7}   status")
        for name, row in report.items():
            print(f"{name:<34}{row['antal']:>7}{row['krav']:>7}   "
                  f"{'OK' if row['uppfyllt'] else 'SAKNAS'}")
        missing = [n for n, r in report.items() if not r["uppfyllt"]]
        if missing:
            print("\nUppfyller inte: " + ", ".join(missing))
            print("Se TESTFALL_MALL.md för varför varje krav finns.")
        return 0 if not missing else 1
    images = json.loads(Path(args.images).read_text()) if args.images else {}
    global BLIND_TYPE
    BLIND_TYPE = bool(args.blind_type)
    modes = [m.strip() for m in args.modes.split(",")]

    import random

    random.seed(20260816)
    np.random.seed(20260816)

    listings = load_listings()
    bands = build_bands(listings)
    store = load_vectors()

    rows = []
    for item in items:
        picks = images.get(str(item["nr"])) or []
        for mode in modes:
            result = run_one(listings, item, picks[0] if picks else None,
                             bands, store, mode)
            rows.append({
                "nr": item["nr"],
                "möbel": item.get("label") or " ".join(
                    p for p in (item.get("brand"), item.get("model")) if p)
                    or str(item.get("category") or "?"),
                "läge": mode,
                "facit_low": item["facit_low"], "facit_high": item["facit_high"],
                "low": result["low"], "default": result["default"],
                "high": result["high"],
                "n": result["matchCount"],
                "variantMethod": result.get("variantMethod"),
                "variantSource": result.get("variantSource"),
                "effectiveN": result.get("effectiveN"),
                "sizeMethod": result.get("sizeMethod"),
                "sizeQuery": result.get("sizeQuery"),
                "sizeWarning": ",".join((result.get("sizeWarning") or {}).keys()) or None,
                "filtersConverted": ",".join(result.get("filtersConverted") or []) or None,
                "variant": (result.get("query") or {}).get("variant"),
                "imageFiltered": result.get("imageFiltered"),
                "cellLevel": result.get("cellLevel"),
                "cellKey": result.get("cellKey"),
                "priceBasis": result.get("priceBasis"),
                "note": result.get("note"),
                "confidence": result.get("confidence"),
                "träff_intervall": overlaps(result["low"], result["high"],
                                            item["facit_low"], item["facit_high"]),
                "träff_default": (result["default"] is not None
                                  and item["facit_low"] <= result["default"]
                                  <= item["facit_high"]),
                "avvikelse": deviation(result["default"], item["facit_low"],
                                       item["facit_high"]),
                "felklass": classify_case(item, result),
            })

    frame = pd.DataFrame(rows)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    frame.to_csv(out / "resultat.csv", index=False)

    summary = {}
    for mode, group in frame.groupby("läge", sort=False):
        answered = group[group["default"].notna()]
        outside = answered[answered["avvikelse"] != 0]
        summary[mode] = {
            "möbler": len(group),
            "svar_gavs": len(answered),
            "accuracy_intervall_överlapp": round(float(group["träff_intervall"].mean()), 4),
            "accuracy_default_inom_facit": round(float(group["träff_default"].mean()), 4),
            "median_avvikelse_när_utanför": (
                round(float(outside["avvikelse"].abs().median()), 4)
                if len(outside) else None),
            "för_högt": int((answered["avvikelse"] > 0).sum()),
            "för_lågt": int((answered["avvikelse"] < 0).sum()),
        }
    # Per felklass, inte bara totalt: svält, storlek och ekbord är olika
    # problem med olika åtgärder, och totalen döljer vilket som återstår.
    per_class = {}
    for (mode, klass), group in frame.groupby(["läge", "felklass"], sort=False):
        per_class.setdefault(mode, {})[klass] = {
            "fall": len(group),
            "överlapp": round(float(group["träff_intervall"].mean()), 4),
            "default_inom": round(float(group["träff_default"].mean()), 4),
        }
    payload = {"totalt": summary, "per_felklass": per_class,
               "spec_fingerprint": spec_fingerprint(Path(args.specs)),
               "harness_version": HARNESS_VERSION,
               "price_cells_enabled": config.PRICE_CELLS_ENABLED,
               "cell_filter_enabled": config.CELL_FILTER_ENABLED}
    (out / "sammanfattning.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2))

    pd.set_option("display.width", 250)
    print("\n" + "=" * 118)
    print("PER MÖBEL")
    print("=" * 118)
    for mode in modes:
        group = frame[frame["läge"] == mode]
        print(f"\n--- läge: {mode} ---")
        print(f"{'nr':<4}{'möbel':<32}{'facit':>14}{'motorns intervall':>24}"
              f"{'default':>9}{'n':>7}  träff")
        for row in group.itertuples():
            facit = f"{row.facit_low}-{row.facit_high}"
            span = (f"{row.low:,.0f}-{row.high:,.0f}" if row.low is not None
                    else "inget svar")
            mark = "JA " if row.träff_intervall else "nej"
            mark += " (default inom)" if row.träff_default else ""
            print(f"{row.nr:<4}{row.möbel[:31]:<32}{facit:>14}{span:>24}"
                  f"{(f'{row.default:,.0f}' if row.default else '—'):>9}"
                  f"{row.n:>7}  {mark}")

    print("\n" + "=" * 118)
    print("SAMMANFATTNING")
    print("=" * 118)
    print(f"{'läge':<12}{'accuracy (överlapp)':>22}{'default inom facit':>21}"
          f"{'medianavvikelse':>18}{'för högt':>10}{'för lågt':>10}")
    for mode, s in summary.items():
        dev = (f"{s['median_avvikelse_när_utanför'] * 100:.0f} %"
               if s["median_avvikelse_när_utanför"] is not None else "—")
        print(f"{mode:<12}{s['accuracy_intervall_överlapp'] * 100:>21.1f} %"
              f"{s['accuracy_default_inom_facit'] * 100:>20.1f} %"
              f"{dev:>18}{s['för_högt']:>10}{s['för_lågt']:>10}")
    print("\n" + "=" * 118)
    print("PER FELKLASS")
    print("=" * 118)
    for mode, classes in per_class.items():
        print(f"\n--- {mode} ---")
        print(f"{'felklass':<12}{'fall':>6}{'överlapp':>11}{'default inom':>14}   {'beskrivning'}")
        for klass, row in sorted(classes.items()):
            print(f"{klass:<12}{row['fall']:>6}{row['överlapp']*100:>10.1f} %"
                  f"{row['default_inom']*100:>13.1f} %   {ERROR_CLASSES.get(klass, '')}")
    if args.frozen:
        print(f"\nspec_fingerprint: {spec_fingerprint(Path(args.specs))}")
    print(f"\nSkrev {out}/resultat.csv och {out}/sammanfattning.json")
    if not config.CONDITION_PRICING:
        print("\nOBS: skickjusteringen är avstängd (CONDITION_PRICING = False), "
              "så det angivna skicket påverkar inte priserna.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
