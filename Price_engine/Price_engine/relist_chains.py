"""Del B — omlistningskedjor: Blockets egen utfallssignal.

Auktionsspåret innehåller noll osålda objekt, så "för dyrt"-gränsen måste
komma ur Blocket-världens egen data. Archive spänner 17 månader och 31,7 % av
annonserna ligger i dubblettgrupper. En del av dem är samma möbel OMLISTAD —
och varje omlistning med sänkt pris är en dom: första priset förkastades.

Skillnaden som avgör allt: en KEDJA är samma objekt vid olika tidpunkter, en
MASSDUBBLETT är samma annons publicerad brett samtidigt (ofta en handlare).
Blandas de ihop mäter man handlares publiceringsrutiner i stället för
marknadens dom.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

import study_config as S

log = logging.getLogger("omlistning")


def _jaccard(a: str, b: str) -> float:
    """Ordmängdslikhet. Robust mot omkastad ordning och små tillägg."""
    first, second = set(a.split()), set(b.split())
    if not first or not second:
        return 0.0
    return len(first & second) / len(first | second)


def find_chains(listings: pd.DataFrame) -> pd.DataFrame:
    """Kandidatkedjor: samma normaliserade titel, olika datum.

    Titeln är nyckeln och den är sträng med avsikt. Blocket-titlar är
    beskrivande nog att fungera som identifierare ("Vitt klaffbord IKEA Norden
    med två fina vita trästolar"), och en lösare nyckel drar in olika exemplar
    av samma möbelmodell — vilket är precis vad vi INTE mäter här.
    """
    frame = listings[
        (listings["price_kind"] == "asking")
        & listings["listed_at"].notna()
        & (listings["name_norm"].str.len() >= 12)
    ].copy()

    counts = frame["name_norm"].value_counts()
    repeated = counts[counts > 1].index
    frame = frame[frame["name_norm"].isin(repeated)]
    log.info("Titlar som förekommer mer än en gång: %d (%d rader)",
             len(repeated), len(frame))

    frame = frame.sort_values(["name_norm", "listed_at"])
    chains, chain_id = [], 0

    for title, group in frame.groupby("name_norm", sort=False):
        rows = group.reset_index(drop=True)
        # Massdubbletter: många rader samma dag är en publiceringsrutin, inte
        # en omlistning. De sållas bort genom att bara behålla en rad per dag.
        rows["day"] = rows["listed_at"].dt.floor("D")
        per_day = rows.groupby("day", as_index=False).first()
        if len(per_day) < 2:
            continue

        per_day = per_day.sort_values("day").reset_index(drop=True)
        gaps = per_day["day"].diff().dt.days
        link = 0
        for i in range(len(per_day)):
            if i > 0 and (gaps[i] < S.RELIST_MIN_DAYS
                          or gaps[i] > S.RELIST_MAX_DAYS):
                # Avbrott: för tätt (dubblett) eller för glest (troligen en
                # annan möbel som råkar ha samma titel).
                link = 0
                chain_id += 1
            if link == 0:
                chain_id += 1
            row = per_day.iloc[i]
            chains.append({
                "chain_id": chain_id, "link": link, "title": title,
                "listed_at": row["day"], "price": row["price"],
                "variant": row["variant"], "source": row["source"],
                "image_url": row.get("image_url"), "name": row["name"],
                "days_since_prev": float(gaps[i]) if i > 0 else np.nan,
            })
            link += 1

    result = pd.DataFrame(chains)
    if result.empty:
        return result
    # Bara kedjor med minst två länkar överlever.
    sizes = result.groupby("chain_id").size()
    result = result[result["chain_id"].isin(sizes[sizes >= 2].index)]
    log.info("Kedjor: %d, länkar: %d", result["chain_id"].nunique(), len(result))
    return result.reset_index(drop=True)


def confirm_with_images(chains: pd.DataFrame, store) -> pd.DataFrame:
    """Bekräftar kedjor med bildlikhet där båda länkarna har vektor.

    Titeln ensam kan ljuga: två personer kan skriva "Ikea Poäng fåtölj". Har
    båda länkarna en embeddad bild går det att kontrollera att det är samma
    exemplar, inte samma modell.
    """
    if store is None or not store.ready:
        chains["image_check"] = "no_store"
        return chains

    rows = store.rows_for(chains)
    chains = chains.assign(_vec_row=rows)
    verdicts = {}
    for chain_id, group in chains.groupby("chain_id"):
        available = group[group["_vec_row"] >= 0]
        if len(available) < 2:
            verdicts[chain_id] = "no_image"
            continue
        vectors = store.embeddings[available["_vec_row"].to_numpy()]
        # Lägsta parvisa likhet i kedjan — svagaste länken avgör.
        similarity = vectors @ vectors.T
        lowest = float(np.min(similarity[np.triu_indices(len(vectors), k=1)]))
        verdicts[chain_id] = ("image_confirmed" if lowest >= S.RELIST_IMAGE_SIM
                              else "image_rejected")
    chains["image_check"] = chains["chain_id"].map(verdicts)
    return chains.drop(columns=["_vec_row"])


def summarise_chains(chains: pd.DataFrame) -> pd.DataFrame:
    """En rad per kedja: startpris, slutpris, sänkning, längd."""
    rows = []
    for chain_id, group in chains.groupby("chain_id"):
        group = group.sort_values("link")
        first, last = group.iloc[0], group.iloc[-1]
        change = (last["price"] - first["price"]) / first["price"]
        rows.append({
            "chain_id": chain_id,
            "title": first["title"],
            "variant": first["variant"],
            "links": len(group),
            "start_price": float(first["price"]),
            "end_price": float(last["price"]),
            "price_change": round(float(change), 4),
            "lowered": bool(change < -S.RELIST_PRICE_EPS),
            "raised": bool(change > S.RELIST_PRICE_EPS),
            "span_days": float((last["listed_at"] - first["listed_at"]).days),
            "listed_at": first["listed_at"],
            "image_check": first.get("image_check"),
        })
    return pd.DataFrame(rows)


def audit_precision(chains: pd.DataFrame, summary: pd.DataFrame,
                    store, n: int = 100, seed: int = None) -> dict:
    """Programmatisk granskning av 100 slumpade kedjor.

    Tre kriterier, alla måste hålla för att kedjan ska räknas som säker:
      titel      identisk normaliserad titel (per konstruktion) OCH minst
                 RELIST_TITLE_SIM i ordlikhet mot råtiteln
      bild       bekräftad, eller åtminstone inte motbevisad
      pris       prisändringen är rimlig — en möbel som byter pris med mer än
                 en faktor 5 är sannolikt två olika objekt
    """
    rng = np.random.default_rng(seed or S.RANDOM_SEED)
    sample_ids = rng.choice(summary["chain_id"].to_numpy(),
                            size=min(n, len(summary)), replace=False)
    verdicts = []
    for chain_id in sample_ids:
        links = chains[chains["chain_id"] == chain_id].sort_values("link")
        row = summary[summary["chain_id"] == chain_id].iloc[0]
        titles = links["name"].fillna("").tolist()
        title_ok = all(_jaccard(titles[0].lower(), t.lower()) >= S.RELIST_TITLE_SIM
                       for t in titles[1:])
        image = row["image_check"]
        image_ok = image != "image_rejected"
        ratio = row["end_price"] / row["start_price"] if row["start_price"] else 0
        price_ok = 0.2 <= ratio <= 5.0
        verdicts.append({
            "chain_id": int(chain_id), "title_ok": title_ok,
            "image_ok": image_ok, "price_ok": price_ok,
            "image_check": image,
            "safe": bool(title_ok and image_ok and price_ok),
        })
    audit = pd.DataFrame(verdicts)
    return {
        "n_sampled": len(audit),
        "precision_safe": round(float(audit["safe"].mean()), 4),
        "title_ok": round(float(audit["title_ok"].mean()), 4),
        "image_ok": round(float(audit["image_ok"].mean()), 4),
        "price_ok": round(float(audit["price_ok"].mean()), 4),
        "image_confirmed": int((audit["image_check"] == "image_confirmed").sum()),
        "image_rejected": int((audit["image_check"] == "image_rejected").sum()),
        "no_image": int((audit["image_check"] == "no_image").sum()),
    }
