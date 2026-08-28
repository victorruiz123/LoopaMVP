#!/usr/bin/env python
"""Bygger ett okulärt stickprov: bord ensamt mot matgrupp, samma modell.

    python build_matgrupp_pairs.py            # -> matgrupp_stickprov.html

Syftet är granskning, inte bevis. Ett enskilt par kan alltid se ut hur som helst
— därför står modellens **medianer och antal** intill varje par, så att anekdoten
kan skiljas från påståendet.

Paren väljs nära respektive buckets median inom modellen, med samma `price_kind`,
så att jämförelsen inte råkar ställa ett auktionsutfall mot ett utropspris.

Bilderna länkas via `image_url` ur datan och laddas från källan i webbläsaren.
Inga annonsbilder sparas till disk.
"""

from __future__ import annotations

import argparse
import html
import logging
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import pandas as pd

from price_engine.data_loader import load_listings
from type_system import model_tokens
from type_system.attributes import derive_type
from type_system.text_layer import extract

log = logging.getLogger("stickprov")
OUT = Path("matgrupp_stickprov.html")

MIN_PER_BUCKET = 5

#: Igenkännbara matserier, i vikt form som korpusen. Poängen är att "samma
#: modell" ska vara okontroversiellt när ett par granskas okulärt — en läsare kan
#: se att två BJURSTA-annonser är samma bord, men inte att två annonser med ordet
#: "troligen" är det. PINNTORP ligger först eftersom den nämns uttryckligen i
#: ATGARDSRAPPORT.md.
KNOWN_SERIES = (
    "pinntorp", "bjursta", "ingatorp", "morbylanga", "ekedalen", "norden",
    "melltorp", "lerhamn", "jokkmokk", "nordviken", "danderyd", "skogsta",
    "tarendo", "vangsta", "laneberg", "strandtorp", "ronninge", "gamlared",
    "ingo", "stefan", "sandsberg", "pello", "docksta", "lisabo", "moramo",
)


def bucket(blob: str):
    attrs = extract(blob, prenormalized=True)
    if attrs.get("base") != "bord":
        return None
    kind = derive_type(attrs)
    if kind == "matgrupp":
        return "matgrupp"
    if kind == "matbord":
        return "matbord"
    return None


def pick(frame: pd.DataFrame) -> pd.Series:
    """Annonsen närmast bucketens median, helst med bild."""
    with_image = frame[frame["image_url"].notna() & frame["image_url"].ne("")]
    pool = with_image if len(with_image) else frame
    target = pool["price"].median()
    return pool.iloc[(pool["price"] - target).abs().argsort().iloc[0]]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="build_matgrupp_pairs.py")
    parser.add_argument("--pairs", type=int, default=10)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    listings = load_listings()
    frame = listings[listings["search_blob"].str.contains(
        r"bord|matgrupp|matsalsgrupp", na=False)].copy()
    frame["bucket"] = [bucket(b) for b in frame["search_blob"]]
    frame = frame[frame["bucket"].notna() & frame["price"].gt(0)]
    log.info("bord i buckets: %d", len(frame))

    known = model_tokens.distinctive(frame["name_norm"], 30, 20_000)
    frame["token"] = [model_tokens.of(n, known) for n in frame["name_norm"]]
    frame = frame.explode("token")
    frame = frame[frame["token"].notna()]

    rows = []
    for (token, kind), group in frame.groupby(["token", "price_kind"], observed=True):
        parts = {b: g for b, g in group.groupby("bucket", observed=True)
                 if len(g) >= MIN_PER_BUCKET}
        if len(parts) < 2:
            continue
        med_bord = float(parts["matbord"]["price"].median())
        med_grupp = float(parts["matgrupp"]["price"].median())
        if med_bord <= 0:
            continue
        rows.append({
            "token": token, "price_kind": kind,
            "n_bord": len(parts["matbord"]), "n_grupp": len(parts["matgrupp"]),
            "med_bord": med_bord, "med_grupp": med_grupp,
            "ratio": med_grupp / med_bord,
            "row_bord": pick(parts["matbord"]), "row_grupp": pick(parts["matgrupp"]),
        })
    log.info("modellgrupper med båda buckets: %d", len(rows))
    if not rows:
        log.error("inga par hittades")
        return 1

    # Urvalet måste bestå av VERKLIGA modeller, annars håller inte "samma
    # modell". Ett första försök spred urvalet över prisnivåer och gav tokens
    # som `klassisk`, `troligen`, `1900-tal` och `massing` — beskrivningar, inte
    # modellnamn. Därför en namngiven lista med igenkännbara matserier först,
    # och prisspridning bara som utfyllnad.
    by_token = {}
    for r in rows:
        key = r["token"]
        if key not in by_token or r["n_bord"] + r["n_grupp"] > \
                by_token[key]["n_bord"] + by_token[key]["n_grupp"]:
            by_token[key] = r
    chosen = [by_token[t] for t in KNOWN_SERIES if t in by_token]
    if len(chosen) < args.pairs:
        rest = sorted((r for r in rows if r["token"] not in KNOWN_SERIES),
                      key=lambda r: -(r["n_bord"] + r["n_grupp"]))
        chosen += rest[:args.pairs - len(chosen)]
    chosen = chosen[:args.pairs]
    overall = pd.Series([r["ratio"] for r in rows]).median()

    parts = [_HEAD, f"""
<h1>Bord ensamt mot matgrupp — okulärt stickprov</h1>
<p class="lead">Mätningen säger att en <b>matgrupp ligger på 0,52&times; ett
matbord</b> inom samma modell (47,9 % skillnad, 959 modellgrupper,
95 % KI [0,50, 0,56]). Nedan {len(chosen)} par att ögna.</p>
<p class="warn">Ett enskilt par bevisar ingenting — därför står modellens medianer
och antal intill. Medianen av kvoten över <b>alla {len(rows)}</b> modellgrupper
i den här uppställningen är <b>{overall:.2f}&times;</b>.</p>
"""]
    for i, r in enumerate(chosen, 1):
        parts.append(_card(i, r))
    parts.append("</body>")
    args.out.write_text("\n".join(parts))

    print(f"\n{'modellord':<16}{'kind':<10}{'matbord':>10}{'matgrupp':>10}"
          f"{'kvot':>7}{'n bord':>8}{'n grupp':>9}")
    for r in chosen:
        print(f"{r['token']:<16}{r['price_kind']:<10}{r['med_bord']:>10,.0f}"
              f"{r['med_grupp']:>10,.0f}{r['ratio']:>7.2f}"
              f"{r['n_bord']:>8}{r['n_grupp']:>9}")
    print(f"\nmedian kvot över alla {len(rows)} grupper: {overall:.2f}")
    print(f"skrivet till {args.out.resolve()}")
    return 0


def _img(url) -> str:
    if not isinstance(url, str) or not url:
        return '<div class="noimg">ingen bild i datan</div>'
    return f'<img loading="lazy" src="{html.escape(url)}" alt="">'


def _side(label, row, median, n, cls) -> str:
    return f"""
    <div class="side {cls}">
      <div class="tag">{label}</div>
      {_img(row.get("image_url"))}
      <div class="title">{html.escape(str(row.get("name") or ""))}</div>
      <div class="price">{float(row["price"]):,.0f} kr</div>
      <div class="meta">källa: {html.escape(str(row.get("source") or "?"))}
        &middot; {html.escape(str(row.get("price_kind") or "?"))}</div>
      <div class="median">modellens median: <b>{median:,.0f} kr</b> ({n} annonser)</div>
    </div>"""


def _card(i, r) -> str:
    direction = ("matgruppen är BILLIGARE" if r["ratio"] < 1
                 else "matgruppen är DYRARE")
    cls = "down" if r["ratio"] < 1 else "up"
    return f"""
<div class="pair">
  <h2>{i}. {html.escape(r['token'])} <span class="kind">({r['price_kind']})</span></h2>
  <div class="verdict {cls}">{direction} — kvot {r['ratio']:.2f}&times;</div>
  <div class="cols">
    {_side("BORD ENSAMT", r["row_bord"], r["med_bord"], r["n_bord"], "bord")}
    {_side("MATGRUPP", r["row_grupp"], r["med_grupp"], r["n_grupp"], "grupp")}
  </div>
</div>"""


_HEAD = """<!doctype html><meta charset="utf-8">
<title>Bord mot matgrupp — stickprov</title>
<style>
 body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      max-width:1000px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
 h1{font-size:1.5rem} h2{font-size:1.05rem;margin:0 0 .4rem}
 .lead{background:#f0f4f8;padding:.8rem 1rem;border-radius:6px}
 .warn{background:#fff8e6;padding:.8rem 1rem;border-radius:6px;border-left:3px solid #e0a800}
 .kind{color:#777;font-weight:400;font-size:.85rem}
 .pair{border:1px solid #e0e0e0;border-radius:8px;padding:1rem;margin:1.2rem 0}
 .verdict{font-size:.85rem;font-weight:600;margin-bottom:.7rem}
 .verdict.down{color:#1a7f37} .verdict.up{color:#b3261e}
 .cols{display:flex;gap:1rem;flex-wrap:wrap}
 .side{flex:1 1 380px;min-width:280px}
 .tag{font-size:.7rem;letter-spacing:.08em;color:#666;margin-bottom:.3rem}
 img{width:100%;height:210px;object-fit:contain;background:#fafafa;
     border:1px solid #eee;border-radius:4px}
 .noimg{height:210px;display:flex;align-items:center;justify-content:center;
        background:#fafafa;border:1px dashed #ddd;border-radius:4px;color:#999;font-size:.8rem}
 .title{font-size:.85rem;margin:.5rem 0 .2rem}
 .price{font-size:1.15rem;font-weight:700}
 .meta{font-size:.75rem;color:#777}
 .median{font-size:.8rem;color:#444;margin-top:.35rem;padding-top:.35rem;
         border-top:1px solid #eee}
 @media(prefers-color-scheme:dark){
  body{background:#161616;color:#e8e8e8} .pair{border-color:#333}
  .lead{background:#1e2630} .warn{background:#2a2415}
  img,.noimg{background:#1e1e1e;border-color:#333} .median{border-color:#2a2a2a}
  .verdict.down{color:#5fd08a} .verdict.up{color:#ff8a80}}
</style><body>"""


if __name__ == "__main__":
    raise SystemExit(main())
