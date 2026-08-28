#!/usr/bin/env python
"""Extraherar benchmarkspecarna och deras bilder ur de tre PDF:erna.

    python extract_benchmark_specs.py

Specarna låg tidigare bara i en temporär katalog och försvann. Att bygga om dem
ur PDF:en varje gång gör körningen reproducerbar: PDF:en är källan, JSON-filen
en härledning. `spec_fingerprint` i resultatet visar vilken version som kördes.

Två format förekommer i samma dokument — de första möblerna skriver
`Varumärke:/Modell:/Variant:` och de senare `● Brand: / ● Model:` — så båda
läses. De två prisbenchmarkerna är enradiga: "Mio Town Godkänt pris: 7000-12000".
"""

from __future__ import annotations

import argparse
import json
import logging
import re
from pathlib import Path

from pypdf import PdfReader

log = logging.getLogger("specar")

SOURCES = (
    ("11", "/Users/test/Price_engine/List of furniture specs - EXACT.pdf"),
    ("b1", "/Users/test/Price_engine/Pris benchmark.pdf"),
    ("b2", "/Users/test/Price_engine/Pris benchmark 2.pdf"),
)

#: Märken som förekommer i de enradiga benchmarkerna. Raden "Mio Town" måste
#: delas i märke och modell, och det går inte att gissa ur ordföljden ensam.
BENCH_BRANDS = ("mio", "ikea", "bellus", "stalands", "kartell", "bolia",
                "jysk", "swedese", "dux")

#: Facit-rättelser beslutade efter att PDF:en skrevs. Nyckeln är (tag, nr) och
#: värdet ersätter posten med en eller flera nya. PDF:en förblir källan för allt
#: annat — det här är den enda vägen in för en ändring, så att `spec_fingerprint`
#: rör sig när facit rör sig.
#:
#: PINNTORP låg som EN post: "Bord och 4 stolar, Matgrupp, 600-800 kr". Den
#: motsvarade inte marknadsbedömningen och delas i två testfall: bordet ensamt
#: och hela matgruppen. Matgruppsfallet är markerat `disputed` — facit 1 500-2 500
#: står i spänning med den uppmätta matgruppsrabatten (grupper annonseras runt
#: 0,52x bordet, vilket skulle ge cirka 300-400 kr). Annonsgranskningen som ligger
#: i kö avgör; tills dess gäller facit, men en miss där ska inte överdramatiseras.
FACIT_OVERRIDES = {
    ("11", 10): [
        {"nr": 10, "brand": "IKEA", "model": "PINNTORP", "variant": "Matbord",
         "category": "Matbord", "facit_low": 300, "facit_high": 800,
         "facit_note": "satt for BORDET ensamt, utan stolar",
         "images_from": 10},
        {"nr": 12, "brand": "IKEA", "model": "PINNTORP",
         "variant": "Bord och 4 stolar", "category": "Matgrupp",
         "facit_low": 1500, "facit_high": 2500, "disputed": True,
         "facit_note": "hela matgruppen; disputed mot matgruppsrabatten 0,52x",
         "images_from": 10},
    ],
}

#: Rader utan märke. Kategorin är allt användaren har — "ekbordsklassen".
BENCH_TYPES = {"matgrupp": "matgrupp", "ekbord": "matbord", "matbord": "matbord",
               "soffa": "soffa", "fatolj": "fatolj", "fåtölj": "fatolj",
               "sang": "sang", "säng": "sang"}


def apply_overrides(tag: str, items: list) -> list:
    """Byter ut poster enligt FACIT_OVERRIDES och håller listan sorterad."""
    out = []
    for item in items:
        replacement = FACIT_OVERRIDES.get((tag, item["nr"]))
        if replacement is None:
            out.append(item)
            continue
        for new in replacement:
            merged = dict(item)
            merged.update(new)
            out.append(merged)
            log.info("%s: möbel #%s ersatt av #%s (%s, %s-%s kr)", tag,
                     item["nr"], new["nr"], new.get("variant"),
                     new["facit_low"], new["facit_high"])
    return sorted(out, key=lambda i: i["nr"])


def _flat(path: str) -> str:
    return re.sub(r"\s+", " ", "\n".join(p.extract_text() or ""
                                         for p in PdfReader(path).pages))


def parse_specs(path: str) -> list:
    """De 11 möblerna ur det utförliga specdokumentet."""
    text = _flat(path)
    # Rubriken skrivs på två sätt i samma dokument: "Möbel #10" och "Möbel 11:".
    # Ett regex som kräver brädgården tappar den elfte möbeln tyst.
    blocks = re.split(r"Möbel\s*#?\s*(\d+)\s*[:.]?\s", text)
    items = []
    for nr, body in zip(blocks[1::2], blocks[2::2]):
        def grab(*patterns):
            for pattern in patterns:
                hit = re.search(pattern, body, re.I)
                if hit and hit.group(1).strip(" :●"):
                    return hit.group(1).strip(" :●")
            return None

        low_high = re.search(
            r"(?:Godkänt\s*prisintervall|Accepted second-hand price range)\s*:?\s*"
            r"([\d\s.]+)\s*[-–]\s*([\d\s.]+)", body, re.I)
        if not low_high:
            log.warning("Möbel #%s: inget facit, hoppas över", nr)
            continue
        items.append({
            "nr": int(nr),
            "brand": grab(r"Varumärke\s*:?\s*([^●\n]+?)\s+(?:Modell|Model)",
                          r"Brand\s*:?\s*([^●\n]+?)\s*●"),
            "model": grab(r"Modell\s*:?\s*([^●\n]+?)\s+(?:Variant|Om\s)",
                          r"Model\s*:?\s*([^●\n]+?)\s*●"),
            "variant": grab(r"Variant\s*:?\s*([^●\n]+?)\s+(?:Om\s|Kategori|●)",
                            r"Variant\s*:?\s*([^●\n]+?)\s*●"),
            "category": grab(r"Kategori\s*:?\s*([^●\n]+?)\s+(?:Färg|●)",
                             r"Category\s*:?\s*([^●\n]+?)\s*●"),
            "facit_low": int(re.sub(r"\D", "", low_high.group(1))),
            "facit_high": int(re.sub(r"\D", "", low_high.group(2))),
        })
    return items


def parse_bench(path: str) -> list:
    """De enradiga prisbenchmarkerna."""
    text = re.sub(r"\s+", " ", "\n".join(p.extract_text() or ""
                                         for p in PdfReader(path).pages))
    items = []
    pattern = re.compile(
        r"([A-Za-zÅÄÖåäö][\w åäöÅÄÖ]{2,40}?)\s*"
        r"(?:[Gg]odkänt\s*)?(?:pris|intervall)\s*:?\s*"
        r"(\d[\d\s]*)\s*[-–]\s*(\d[\d\s]*)", re.I)
    for nr, hit in enumerate(pattern.finditer(text), 1):
        label = re.sub(r"\s+", " ", hit.group(1)).strip()
        label = re.sub(r"^(godkänt|pris|M)\s+", "", label, flags=re.I).strip()
        words = label.split()
        brand = model = None
        if words and words[0].lower() in BENCH_BRANDS:
            brand, model = words[0], " ".join(words[1:]) or None
        category = next((v for w in words
                         if (v := BENCH_TYPES.get(w.lower()))), None)
        items.append({
            "nr": nr, "label": label, "brand": brand, "model": model,
            "variant": None, "category": category,
            "facit_low": int(re.sub(r"\D", "", hit.group(2))),
            "facit_high": int(re.sub(r"\D", "", hit.group(3))),
        })
    return items


def extract_images(path: str, out: Path, tag: str, items: list) -> dict:
    """Bilderna, kopplade till rätt möbel. Returnerar {nr: [sökvägar]}.

    Benchmarkbilderna är produktbilder ur PDF:en, inte annonsbilder — de faller
    inte under regeln att annonsbilder aldrig sparas.

    Kopplingen skiljer sig mellan dokumenten och kan inte gissas ur sidnumret:

      specdokumentet  rubriken "Möbel #N" står på en sida, och bilderna på den
                      sidan och följande fram till nästa rubrik hör till N
      benchmark 1     sida 1 bär TVÅ möbler (Town och Saturday) med var sin
                      bild; därefter är sidan förskjuten ett steg
      benchmark 2     en möbel per sida, rakt av
    """
    out.mkdir(parents=True, exist_ok=True)
    reader = PdfReader(path)
    per_page: dict = {}
    for page_no, page in enumerate(reader.pages, 1):
        for index, image in enumerate(getattr(page, "images", [])):
            suffix = Path(image.name).suffix or ".png"
            target = out / f"s{page_no:02d}_{index}{suffix}"
            target.write_bytes(image.data)
            per_page.setdefault(page_no, []).append(str(target))

    mapping: dict = {}
    if tag == "11":
        headers = {}
        for page_no, page in enumerate(reader.pages, 1):
            text = re.sub(r"\s+", " ", page.extract_text() or "")
            for nr in re.findall(r"Möbel\s*#?\s*(\d+)", text):
                headers.setdefault(int(nr), page_no)
        starts = sorted(headers.items(), key=lambda kv: kv[1])
        for page_no, paths in sorted(per_page.items()):
            owner = None
            for nr, start in starts:
                if start <= page_no:
                    owner = nr
            if owner is not None:
                mapping.setdefault(str(owner), []).extend(paths)
    elif tag == "b1":
        first = per_page.get(1, [])
        if len(first) >= 2:
            mapping["1"], mapping["2"] = [first[0]], [first[1]]
        for page_no, paths in sorted(per_page.items()):
            if page_no > 1:
                mapping[str(page_no + 1)] = paths
    else:
        for page_no, paths in sorted(per_page.items()):
            mapping[str(page_no)] = paths

    # En delad post ärver originalets bilder — "images_from" pekar på numret i
    # PDF:en. Utan detta står det nya fallet utan bild och läge B/D mäter
    # ingenting för det.
    for item in items:
        source = item.get("images_from")
        if source is not None and str(item["nr"]) not in mapping:
            mapping[str(item["nr"])] = list(mapping.get(str(source), []))

    missing = [i["nr"] for i in items if str(i["nr"]) not in mapping]
    if missing:
        log.warning("%s: möbel utan bild: %s", tag, missing)
    return mapping


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="extract_benchmark_specs.py")
    parser.add_argument("--out", type=Path, default=Path("benchmark"))
    parser.add_argument("--images", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    args.out.mkdir(exist_ok=True)
    total = 0
    for tag, path in SOURCES:
        items = parse_specs(path) if tag == "11" else parse_bench(path)
        items = apply_overrides(tag, items)
        target = args.out / f"items_{tag}.json"
        target.write_text(json.dumps(items, ensure_ascii=False, indent=1))
        total += len(items)
        print(f"{tag:<4}{len(items):>3} möbler -> {target}")
        for item in items:
            name = item.get("label") or " ".join(
                p for p in (item.get("brand"), item.get("model")) if p)
            print(f"     #{item['nr']:<3}{name[:44]:<46}"
                  f"{item['facit_low']:>7,}-{item['facit_high']:<7,}"
                  f"  {item.get('category') or '-'}")
        if args.images:
            mapping = extract_images(path, args.out / f"bilder_{tag}", tag, items)
            (args.out / f"images_{tag}.json").write_text(
                json.dumps(mapping, ensure_ascii=False, indent=1))
            print(f"     bilder: {sum(len(v) for v in mapping.values())} st "
                  f"över {len(mapping)}/{len(items)} möbler")
    print(f"\ntotalt {total} möbler")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
