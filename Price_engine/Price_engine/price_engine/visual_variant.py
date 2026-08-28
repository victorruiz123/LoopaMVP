"""Möbeltyp ur bilden med DINOv2 — utan modellanrop.

Motorns typklassning har hittills gått via OpenAI: ett foto in, en etikett ut.
Det fungerar men har tre problem — den kostar per förfrågan, den kan sluta
fungera (krediter, kvot, nedtid), och den vet ingenting om hur just den här
datan ser ut.

Det finns ett bättre underlag redan i huset: 94 305 embeddade annonsbilder vars
möbeltyp redan är bestämd av textklassningen. En frågebild behöver därför inte
klassas i abstrakt mening — den behöver bara hitta sina närmaste grannar och
läsa av vad de är.

    frågebild -> DINOv2-vektor -> k närmaste annonsbilder -> deras varianter
                                                          -> viktad röstning

Det gör klassningen lokal, gratis och kalibrerad mot den faktiska datan. Den
kan dessutom svara "vet inte", vilket en promptad modell sällan gör.

Varför detta spelar roll för priset: Mio Town finns som rak soffa och som
hörnsoffa, och bland träffarna ligger dessutom hyllor och fotpallar med samma
modellnamn. Ofiltrerat blir p40 6 000 kr mot facit 7 000-12 000; filtrerat på
rak soffa blir det 7 500 kr. Skillnaden är hela felet.
"""

from __future__ import annotations

import logging
import re

import numpy as np
import pandas as pd

from . import config
from .variant import PART, UNKNOWN

log = logging.getLogger(__name__)


#: rad i vektorlagret -> möbeltyp. Byggs en gång; uppslaget går annars över
#: 1,5 miljoner annonser per förfrågan.
_ROW_VARIANT: np.ndarray | None = None


def row_variants(store, listings: pd.DataFrame) -> np.ndarray:
    """Möbeltypen bakom varje vektorrad.

    Vektorerna nycklas på URL-hash, inte annons-ID, så flera annonser kan dela
    rad (tradera har 65 % dubblettbilder). Delar de rad men inte möbeltyp
    vinner den vanligaste — och att de alls kan skilja sig är i sig ett mått på
    textklassningens brus.
    """
    global _ROW_VARIANT
    if _ROW_VARIANT is not None:
        return _ROW_VARIANT

    rows = store.rows_for(listings)
    known = rows >= 0
    table = pd.DataFrame({
        "row": rows[known],
        "variant": listings["variant"].to_numpy()[known],
    })
    modal = table.groupby("row")["variant"].agg(
        lambda values: values.mode().iloc[0] if len(values.mode()) else None
    )
    out = np.full(len(store.embeddings), None, dtype=object)
    out[modal.index.to_numpy()] = modal.to_numpy()
    log.info("Variantkarta byggd: %d av %d vektorrader har en möbeltyp",
             int(modal.notna().sum()), len(out))
    _ROW_VARIANT = out
    return out


def classify(
    query_vector: np.ndarray,
    store,
    listings: pd.DataFrame,
    k: int | None = None,
) -> tuple:
    """Röstar fram möbeltypen ur de k närmaste annonsbilderna.

    Returnerar (varianter, diagnostik). `varianter` är en lista eftersom en
    bild kan vara genuint tvetydig — en hörnsoffa fotograferad rakt framifrån
    ser ut som en rak soffa — och att tvinga fram ett val ger fel svar i
    halva fallen. Samma resonemang som bildklassningens `VariantGuess`.

    Rösterna VIKTAS med likheten. En granne på 0,80 ska väga mer än en på
    0,50, annars kan en klump medelmåttiga grannar rösta ned den enda riktigt
    lika bilden.
    """
    k = k or config.VISUAL_VARIANT_K
    if query_vector is None or store is None or not store.ready:
        return [], {"method": "none"}

    scores = store.embeddings @ query_vector
    if len(scores) <= k:
        top = np.argsort(scores)[::-1]
    else:
        # argpartition är O(n) mot sorteringens O(n log n) — 94 000 vektorer
        # per förfrågan gör skillnaden märkbar.
        top = np.argpartition(scores, -k)[-k:]
        top = top[np.argsort(scores[top])[::-1]]

    variants = row_variants(store, listings)[top]
    neighbours = pd.DataFrame({"variant": variants, "similarity": scores[top]})
    neighbours = neighbours[neighbours["variant"].notna()]
    if neighbours.empty:
        return [], {"method": "no_variants"}

    neighbours = neighbours[neighbours["similarity"] >= config.VISUAL_VARIANT_MIN_SIM]
    neighbours = neighbours[~neighbours["variant"].isin([UNKNOWN, PART])]
    if len(neighbours) < config.VISUAL_VARIANT_MIN_VOTES:
        return [], {"method": "too_few_neighbours",
                    "neighbours": int(len(neighbours))}

    votes = neighbours.groupby("variant")["similarity"].sum().sort_values(ascending=False)
    share = votes / votes.sum()
    winner = share.index[0]

    # Ta med tvåan när den ligger nära. Tvetydigheten är äkta: en hörnsoffa
    # rakt framifrån och en rak soffa är samma bild.
    chosen = [str(winner)]
    if len(share) > 1 and share.iloc[1] >= share.iloc[0] * config.VISUAL_VARIANT_RUNNERUP:
        chosen.append(str(share.index[1]))

    return chosen, {
        "method": "knn",
        "neighbours": int(len(neighbours)),
        "top_similarity": round(float(neighbours["similarity"].max()), 3),
        "votes": {str(v): round(float(s), 3) for v, s in share.head(4).items()},
    }


# --------------------------------------------------------------------------
# Ledord ur grannarnas titlar
# --------------------------------------------------------------------------
# Möbeltypen är en grov signal — tretton hinkar. Det som verkligen skiljer en
# stor U-soffa från en liten hörnsoffa står i orden: "divan", "schäslong",
# "u-soffa", "3-sits", "sammet", "mörkgrå".
#
# De orden behöver ingen språkmodell. Grannarnas titlar innehåller dem redan,
# och vilka som är SÄRSKILJANDE går att räkna: ett ord som förekommer hos
# grannarna men sällan i korpusen bär information, ett som förekommer överallt
# gör inte det. Uppmätt på benchmarkbilderna ger metoden
#
#   Mio Town (U-soffa)        divan, hornsoffa, schaslong
#   Kartell Victoria Ghost    transparent, ghost, starck, philippe, plast
#   Ekbord med stolar         ilaggsskiva, matbord, massiv
#
# Det är samma slags ledord som en promptad modell skulle generera, men hämtade
# ur den egna datan och därmed garanterat matchbara mot den.
_TOKEN = re.compile(r"[a-z0-9]+")

#: Ord som är för vanliga för att bära information. Inte en språklista utan en
#: korpuslista: de förekommer i var tredje annons oavsett möbel.
_CUE_STOPWORDS = frozenset(
    "och med i pa av till fran for den det en ett som ar var nya ny fint fin"
    " bra skick st stycken cm kr mycket helt snygg fina bortskankes".split()
)

_CORPUS_FREQUENCY: dict | None = None
_CORPUS_SIZE = 0


def _corpus_frequency(listings: pd.DataFrame) -> tuple:
    """Hur vanligt varje ord är i annonstexterna. Baslinjen ledorden mäts mot."""
    global _CORPUS_FREQUENCY, _CORPUS_SIZE
    if _CORPUS_FREQUENCY is not None:
        return _CORPUS_FREQUENCY, _CORPUS_SIZE

    sample = listings["search_blob"].dropna()
    if len(sample) > config.CUE_CORPUS_SAMPLE:
        sample = sample.sample(config.CUE_CORPUS_SAMPLE,
                               random_state=config.CUE_RANDOM_SEED)
    counter: dict = {}
    for blob in sample:
        for word in set(_TOKEN.findall(blob)):
            counter[word] = counter.get(word, 0) + 1
    _CORPUS_FREQUENCY, _CORPUS_SIZE = counter, len(sample)
    log.info("Korpusbaslinje för ledord: %d ord ur %d annonser",
             len(counter), len(sample))
    return _CORPUS_FREQUENCY, _CORPUS_SIZE


def cue_words(query_vector, store, listings: pd.DataFrame,
              k: int | None = None) -> list:
    """Särskiljande ord bland de närmaste annonsbildernas titlar.

    Returnerar [(ord, lyft)] sorterat på lyft, där lyft är hur många gånger
    vanligare ordet är bland grannarna än i korpusen. Ett ord måste
    förekomma hos minst CUE_MIN_NEIGHBOURS grannar för att räknas — annars
    fångar man en enskild annonsförfattares ordval.
    """
    k = k or config.VISUAL_VARIANT_K
    if query_vector is None or store is None or not store.ready:
        return []

    scores = store.embeddings @ query_vector
    if len(scores) <= k:
        top = np.argsort(scores)[::-1]
    else:
        top = np.argpartition(scores, -k)[-k:]
        top = top[np.argsort(scores[top])[::-1]]
    top = top[scores[top] >= config.VISUAL_VARIANT_MIN_SIM]
    if len(top) < config.VISUAL_VARIANT_MIN_VOTES:
        return []

    blobs = _row_blobs(store, listings)
    counts: dict = {}
    seen = 0
    for row in top:
        blob = blobs.get(int(row))
        if not blob:
            continue
        seen += 1
        for word in set(_TOKEN.findall(blob)):
            counts[word] = counts.get(word, 0) + 1
    if not seen:
        return []

    frequency, size = _corpus_frequency(listings)
    floor = 1.0 / max(size, 1)
    cues = []
    for word, count in counts.items():
        if (count < config.CUE_MIN_NEIGHBOURS or len(word) < 3
                or word in _CUE_STOPWORDS or word.isdigit()):
            continue
        lift = (count / seen) / max(frequency.get(word, 0) / size, floor)
        if lift >= config.CUE_MIN_LIFT:
            cues.append((word, round(float(lift), 1)))
    cues.sort(key=lambda pair: -pair[1])
    return cues[:config.CUE_MAX_WORDS]


_ROW_BLOB: dict | None = None


def _row_blobs(store, listings: pd.DataFrame) -> dict:
    """vektorrad -> annonstext. Byggs en gång, som variantkartan."""
    global _ROW_BLOB
    if _ROW_BLOB is not None:
        return _ROW_BLOB
    rows = store.rows_for(listings)
    known = rows >= 0
    frame = pd.DataFrame({
        "row": rows[known],
        "blob": listings["search_blob"].to_numpy()[known],
    }).drop_duplicates("row")
    _ROW_BLOB = dict(zip(frame["row"].tolist(), frame["blob"].tolist()))
    return _ROW_BLOB
