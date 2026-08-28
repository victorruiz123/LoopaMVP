"""Bildpar med TEXTBASERAT facit — ersätter handmärkningen.

Handmärkningen underkändes i stickprov, och felet var metoden: att bedöma
"samma möbel?" ur två foton är subjektivt, och jag var för liberal. Trösklarna
som räknades fram ur den (0,65 / 0,68 / 0,76) är därför ogiltiga.

Databasen vet redan svaret. Två annonser vars titlar bär samma märke OCH samma
modellnamn visar samma modell — det är ingen bedömning, det är en uppslagning.
Två annonser med samma möbeltyp men olika kända modellnamn visar olika modeller.

    positiva par    samma märke + samma modellnamn      -> samma_modell
    negativa par    samma möbeltyp + olika modellnamn   -> olika_modell

Positiva par delas dessutom på storlek, eftersom "samma modell" och "samma
möbel" inte är samma fråga: en Ektorp 2-sits och en Ektorp 3-sits är samma
modell men olika möbler, och en tröskel som ska hitta den ena ska inte
kalibreras på den andra.
"""

from __future__ import annotations

import logging
import re

import numpy as np
import pandas as pd

import study_config as S
from price_engine import size as size_mod
from price_engine.data_loader import normalize_text
from price_engine.variant import PART, UNKNOWN

log = logging.getLogger("bildfacit")

SEED = 20260806

#: Modellnamn som är för generella för att bära ett facit på egen hand —
#: samma lista som bryggmätningen använder, av samma skäl.
AMBIGUOUS = {"string", "aalto", "egg", "shell", "standard", "eames", "montana",
             "aj", "non", "spin", "happy", "tank", "result", "fly", "sam",
             "eva", "karin", "maria", "annika", "bridge", "town"}


def _model_lookup() -> dict:
    """Normaliserat modellnamn -> märke, med de tvetydiga borttagna."""
    out = {}
    for brand, models in S.MODEL_NAMES.items():
        brand_key = normalize_text(brand)
        for model in models:
            key = normalize_text(model)
            if len(key) >= 4 and key not in AMBIGUOUS:
                out.setdefault(key, brand_key)
    return out


MODELS = _model_lookup()
_PATTERN = re.compile(
    r"\b(" + "|".join(sorted(map(re.escape, MODELS), key=len, reverse=True)) + r")\b"
)


def annotate(listings: pd.DataFrame, store) -> pd.DataFrame:
    """Annonser med vektor, modellnamn, märke och storlek.

    Kravet att BÅDE märke och modellnamn står i texten är hårt: "kivik" utan
    "ikea" kan vara ett ortsnamn, och facitet får inte vila på det.
    """
    rows = store.rows_for(listings)
    frame = listings.assign(_row=rows)
    frame = frame[frame["_row"] >= 0]
    # En rad per vektor — samma bild delas av flera annonser, och identisk bild
    # i båda ändar av ett par lär oss ingenting.
    frame = frame.drop_duplicates("_row")
    frame = frame[~frame["variant"].isin([UNKNOWN, PART])]

    blob = frame["search_blob"].fillna("")
    frame = frame.assign(model=blob.str.extract(_PATTERN, expand=False))
    frame = frame[frame["model"].notna()]

    # Märket måste stå i samma text.
    brand_ok = [
        MODELS[model] in text
        for model, text in zip(frame["model"], frame["search_blob"].fillna(""))
    ]
    frame = frame[brand_ok]
    log.info("Annonser med vektor + märke + modellnamn: %d (%d modeller)",
             len(frame), frame["model"].nunique())
    return frame


def is_screenshot(path) -> bool:
    """Skärmdumpar från ikea.se/jysk.se ligger i bilddatan som annonsbilder.

    De känns igen på två saker samtidigt: mobilproportion (hög och smal) och
    en stor andel nästan vita pixlar från gränssnittet. Ett av kriterierna
    ensamt fångar riktiga möbelfoton mot vit studiobakgrund.
    """
    from PIL import Image

    try:
        with Image.open(path) as im:
            width, height = im.size
            if height / max(width, 1) < 1.7:
                return False
            small = im.convert("L").resize((48, 96))
            pixels = np.asarray(small, dtype=float)
        return float((pixels > 236).mean()) > 0.55
    except Exception:
        return False


def build_pairs(frame: pd.DataFrame, store, per_class: int = 500,
                near_duplicate: float = 0.98) -> pd.DataFrame:
    """Positiva och negativa par per möbeltyp, balanserade.

    `near_duplicate` klipper bort par som i praktiken är samma foto — de skulle
    annars göra den positiva klassen konstlat lätt.
    """
    rng = np.random.default_rng(SEED)
    picked = []

    for variant, group in frame.groupby("variant", observed=True):
        if len(group) < 30:
            continue
        rows = group["_row"].to_numpy()
        vectors = store.embeddings[rows]
        similarity = vectors @ vectors.T
        np.fill_diagonal(similarity, -1.0)
        models = group["model"].to_numpy()
        names = group["name_norm"].to_numpy()
        prices = group["price"].to_numpy()

        same = models[:, None] == models[None, :]
        upper = np.triu(np.ones_like(same, dtype=bool), k=1)
        # Dubblettgrupper: samma rubrik OCH samma pris är samma annons.
        duplicate = (names[:, None] == names[None, :]) & (prices[:, None] == prices[None, :])
        usable = upper & ~duplicate & (similarity <= near_duplicate)

        for label, mask in (("samma_modell", same & usable),
                            ("olika_modell", ~same & usable)):
            i, j = np.where(mask)
            if not len(i):
                continue
            order = rng.permutation(len(i))[:per_class]
            for k in order:
                a, b = group.iloc[int(i[k])], group.iloc[int(j[k])]
                picked.append({
                    "variant": variant, "label": label,
                    "similarity": round(float(similarity[i[k], j[k]]), 4),
                    "a_row": int(a["_row"]), "b_row": int(b["_row"]),
                    "a_model": a["model"], "b_model": b["model"],
                    "a_size": a.get("size"), "b_size": b.get("size"),
                    "a_source": a["source"], "b_source": b["source"],
                    "a_url": a["image_url"], "b_url": b["image_url"],
                    "a_name": str(a["name"])[:80], "b_name": str(b["name"])[:80],
                })

    pairs = pd.DataFrame(picked)
    if pairs.empty:
        return pairs

    # Balansera klasserna per möbeltyp: en obalans skulle göra varje
    # separationsmått svårläst.
    balanced = []
    for variant, group in pairs.groupby("variant", observed=True):
        counts = group["label"].value_counts()
        if len(counts) < 2:
            continue
        take = int(counts.min())
        for label, part in group.groupby("label", observed=True):
            balanced.append(part.sample(take, random_state=SEED))
    pairs = pd.concat(balanced, ignore_index=True) if balanced else pairs

    # Positiva par delas på storlek. Saknas storleken för någon sida går
    # frågan inte att besvara, och paret märks som okänd storlek.
    def split(row):
        if row["label"] != "samma_modell":
            return row["label"]
        if not row["a_size"] or not row["b_size"] or pd.isna(row["a_size"]) \
                or pd.isna(row["b_size"]):
            return "samma_modell_okänd_storlek"
        return ("samma_modell_samma_variant" if row["a_size"] == row["b_size"]
                else "samma_modell_annan_variant")

    pairs["label_detail"] = pairs.apply(split, axis=1)
    log.info("Par: %d över %d möbeltyper", len(pairs), pairs["variant"].nunique())
    return pairs
