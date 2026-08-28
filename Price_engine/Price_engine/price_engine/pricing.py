"""Prislogiken: matchning av annonser + intervallalgoritmen.

Algoritmen är avsiktligt ren statistik — median och positionsbaserat fönster.
Ingen ML, ingen viktning, inga modeller.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, asdict
from typing import Sequence

import logging

import numpy as np
import pandas as pd

from . import config
from . import variant as variant_mod
from . import vision as vision_mod
from .data_loader import condition_tier, normalize_text

log = logging.getLogger(__name__)


@dataclass
class PriceRange:
    """Resultatet av algoritmen. Speglar API:ets output-format."""

    match_count: int
    half_interval: int
    default: int | None
    low: int | None
    high: int | None
    confidence: str
    note: str

    def to_dict(self) -> dict:
        data = asdict(self)
        # Ut mot API:et i camelCase enligt specen.
        data["matchCount"] = data.pop("match_count")
        data["halfInterval"] = data.pop("half_interval")
        return data


def weighted_quantile(prices: np.ndarray, weights: np.ndarray, q: float) -> float:
    """Kvantil av en viktad prisfördelning.

    Med enhetsvikter ger den samma `low` och `high` som positionslogiken, och
    samma `default` för de flesta n. `default` kan skilja EN position, eftersom
    den oviktade vägen avrundar (`median_index = n // 2`, `round(n * ratio)`)
    medan kvantilen räknar exakt. Skillnaden är försumbar mot vad viktningen
    själv gör, och den viktade vägen körs bara när ett filter konverterats.
    """
    order = np.argsort(prices)
    prices, weights = prices[order], weights[order]
    total = weights.sum()
    if total <= 0:
        return float(prices[0])
    target = float(np.clip(q, 0.0, 1.0)) * total
    cumulative = np.cumsum(weights)
    # side="right": med enhetsvikter blir cumsum [1..n] och target ett heltal,
    # och då är det positionen EFTER den kumulativa summan som motsvarar
    # positionsformelns index. Se testet för likvärdighet.
    index = int(np.searchsorted(cumulative, target, side="right"))
    return float(prices[min(index, len(prices) - 1)])


def compute_weighted_range(prices, weights) -> PriceRange:
    """Intervallalgoritmen på en VIKTAD jämförelsemängd.

    Används när ett filter konverterats till viktning för att inte bryta
    MIN_COMPARISON_SET. Percentilerna är samma som i den oviktade varianten —
    p30 / p40 / p60 — men räknade på vikternas summa i stället för på antal
    rader, och golven uttrycks som andel av den EFFEKTIVA mängden.
    """
    prices = np.asarray(prices, dtype=float)
    weights = np.asarray(weights, dtype=float)
    n = len(prices)
    if n == 0:
        return compute_price_range([])

    effective = float(weights.sum())
    if effective <= 0:
        return compute_price_range(prices.tolist())

    # Golven i positionstermer översatta till andelar: MIN_LOW_OFFSET annonser
    # av `effective` är samma sak som MIN_LOW_OFFSET/effective av fördelningen.
    low_share = max(config.LOW_OFFSET_RATIO, config.MIN_LOW_OFFSET / effective)
    high_share = max(config.HALF_INTERVAL_RATIO, config.MIN_HALF_INTERVAL / effective)

    median = weighted_quantile(prices, weights, 0.50)
    low = weighted_quantile(prices, weights, 0.50 - low_share)
    high = weighted_quantile(prices, weights, 0.50 + high_share)
    # Startläget använder offseten UTAN golv, precis som i den oviktade
    # varianten: golvet ska bredda fönstret, inte sänka startläget.
    default = min(weighted_quantile(prices, weights,
                                    0.50 - config.DEFAULT_OFFSET_RATIO), median)

    if effective < config.LOW_CONFIDENCE_BELOW:
        confidence, note = "low", (
            f"Tunt underlag: motsvarande {effective:.0f} annonser efter viktning."
        )
    else:
        confidence, note = "high", f"Baserat på {n} liknande annonser."

    return PriceRange(
        match_count=n,
        half_interval=_round_half_up(effective * config.HALF_INTERVAL_RATIO),
        default=round(default), low=round(low), high=round(high),
        confidence=confidence, note=note,
    )


def _percentile_grid(prices, weights=None) -> dict | None:
    """Priset vid p05..p95 i jämförelsemängden.

    Använder SAMMA kvantilfunktion som prissättningen, så ett värde ur rutnätet
    är exakt vad motorn skulle svarat med den percentilen. Ett eget
    `np.percentile` här hade gett en annan definition och gjort svepet
    obrukbart som beslutsunderlag.
    """
    prices = np.asarray(prices, dtype=float)
    if not len(prices):
        return None
    if weights is None or not len(weights) or len(weights) != len(prices):
        weights = np.ones(len(prices), dtype=float)
    return {
        str(p): round(float(weighted_quantile(prices, weights, p / 100.0)), 0)
        for p in range(5, 96, 5)
    }


def _round_half_up(value: float) -> int:
    """Avrundar till närmaste heltal, .5 uppåt.

    Pythons inbyggda round() avrundar .5 mot jämnt tal (round(6.5) == 6),
    vilket inte är vad "avrundat till närmaste heltal" betyder här.
    """
    return math.floor(value + 0.5)


def compute_price_range(prices: Sequence[float]) -> PriceRange:
    """Kör algoritmen på en lista med priser.

    Ren funktion utan pandas-beroende, så den går att enhetstesta direkt.
    Stegnumren nedan följer specifikationen.
    """
    # --- Steg 1: räkna matchande annonser ---------------------------------
    n = len(prices)

    # Kantfall: inga träffar alls.
    if n == 0:
        return PriceRange(
            match_count=0,
            half_interval=0,
            default=None,
            low=None,
            high=None,
            confidence="none",
            note="Hittade inga liknande annonser.",
        )

    # --- Steg 2: HalvIntervall = N * 0.1, avrundat ------------------------
    half_interval = _round_half_up(n * config.HALF_INTERVAL_RATIO)

    # --- Steg 3: golv på 5 ------------------------------------------------
    if half_interval < config.MIN_HALF_INTERVAL:
        half_interval = config.MIN_HALF_INTERVAL

    # --- Steg 4: sortera på pris, billigast -> dyrast ---------------------
    ordered = sorted(float(p) for p in prices)

    # --- Steg 5: medianpriset är förslaget (glidknappens startläge) -------
    # Vid jämnt antal är medianen medelvärdet av de två mittersta.
    if n % 2:
        median = ordered[n // 2]
    else:
        median = (ordered[n // 2 - 1] + ordered[n // 2]) / 2

    # --- Steg 6: ASYMMETRISKT fönster kring medianens position ------------
    # medianIndex = mittpositionen i den sorterade listan. Vid jämnt antal
    # finns ingen exakt mittpost; vi använder den övre av de två mittersta.
    median_index = n // 2

    # Fönstret lutar nedåt, för att glidknappen ska betyda vad den utger sig
    # för. Symmetriskt (N x 0,1 åt båda håll) spände det p40–p60 — mittersta
    # 20 % av marknaden — och även vänsterläget låg då över 35:e percentilen.
    # Den som drog reglaget hela vägen till "säljs snabbt" konkurrerade
    # fortfarande med en tredjedel av marknaden som var billigare.
    #
    #   low     = p30   lättsålt
    #   default = p40   startläget
    #   high    = p60   svårsålt
    low_offset = max(
        _round_half_up(n * config.LOW_OFFSET_RATIO), config.MIN_LOW_OFFSET
    )

    # Indexen clampas så att ett för litet underlag inte spräcker listan.
    low_i = max(0, median_index - low_offset)
    high_i = min(n - 1, median_index + half_interval)

    low = ordered[low_i]
    high = ordered[high_i]

    # --- Steg 7: startläget på p40 ----------------------------------------
    # Medianen är per definition genomsnittsfart: hälften av marknaden är
    # billigare. Ett startläge under den är ärligare mot löftet "rimligt men
    # snabbsäljande" — och två oberoende mätningar pekar åt samma håll.
    # Bryggmätningen, som mäter mot exakt den fråga motorn ställer, landade på
    # p34; omlistningsstudien visar att prissänkningarna passerar 50 % redan i
    # decilen p40-50. Startläget är därför p40, inte medelvärdet av p40 och p50
    # (~p45) som tidigare.
    #
    # OBS: här används offseten UTAN golvet. Golvet finns för att bredda
    # fönstret när underlaget är tunt — inte för att dra ned startläget.
    # Med golvet hade fem annonser gett p40 = billigaste annonsen.
    default_i = max(0, median_index
                    - _round_half_up(n * config.DEFAULT_OFFSET_RATIO))

    # Vid jämnt antal pekar median_index på det ÖVRE av de två mittersta, så
    # ankaret kan hamna över medianen när offseten är noll (litet N). p40 är
    # per definition aldrig högre än p50 — kapa det.
    default = min(ordered[default_i], median)

    # --- Konfidens och notering -------------------------------------------
    if n < config.LOW_CONFIDENCE_BELOW:
        confidence = "low"
        note = (
            f"Tunt underlag: bara {n} liknande "
            f"{'annons' if n == 1 else 'annonser'} hittades. "
            f"Fönstret täcker hela träffmängden, så intervallet är osäkert."
        )
    else:
        confidence = "high"
        note = f"Baserat på {n} liknande annonser."

    return PriceRange(
        match_count=n,
        half_interval=half_interval,
        default=round(default),
        low=round(low),
        high=round(high),
        confidence=confidence,
        note=note,
    )


# --------------------------------------------------------------------------
# Matchning mot annonsdatan
# --------------------------------------------------------------------------
# Söksträngen delas på allt som inte är bokstav eller siffra. Annars blir
# "3-sits" ett enda ord som bara matchar annonser med bindestreck — men
# "Soffa IKEA Landskrona 3 sits" skriver samma sak med mellanslag.
# normalize_text har redan fällt ner å/ä/ö till ascii, så a-z räcker.
_TOKEN = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    """Delar en normaliserad söksträng i ord: '3-sits' -> ['3', 'sits']."""
    return _TOKEN.findall(text)


def _token_hit(blob: pd.Series, token: str) -> pd.Series:
    """Mask för annonser vars text innehåller ett enskilt sökord.

    Vanliga ord matchas som delsträng, vilket ger böjningsformer gratis:
    "soffa" träffar även "soffor" och "3-sitssoffa".

    Rena siffror kräver däremot ordgräns. Som delsträng skulle "2" träffa
    varje titel som råkar innehålla siffran — "2024", "1200 kr", "12 mm" —
    och sökningen blir meningslös.
    """
    if token.isdigit():
        return blob.str.contains(rf"\b{re.escape(token)}\b", regex=True, na=False)
    return blob.str.contains(token, regex=False, na=False)


def _all_tokens_hit(blob: pd.Series, text: str) -> pd.Series | None:
    """Mask för annonser som innehåller SAMTLIGA ord i text. None om text är tom."""
    mask = None
    for token in _tokenize(text):
        hit = _token_hit(blob, token)
        mask = hit if mask is None else (mask & hit)
    return mask


def strip_stopwords(text: str) -> tuple:
    """(söknyckel utan funktionsord, de ord som ströks).

    Sökningen kräver att SAMTLIGA ord träffar, så ett funktionsord blir ett hårt
    krav som smalnar av utan att identifiera. Se config.SEARCH_STOPWORDS.

    Spärren: stryks allt återlämnas texten orörd. En söknyckel som består av
    enbart funktionsord är visserligen dålig, men en TOM söknyckel matchar hela
    korpusen och är mycket värre.
    """
    tokens = _tokenize(normalize_text(text or ""))
    if not tokens:
        return text, []
    kept = [t for t in tokens if t not in config.SEARCH_STOPWORDS]
    if not kept:
        return text, []
    ignored = [t for t in tokens if t in config.SEARCH_STOPWORDS]
    return " ".join(kept), ignored


def _relax_search(listings: pd.DataFrame, name: str, brand: str | None,
                  minimum: int | None = None) -> tuple:
    """Släpper ord tills sökningen bär. (träffar, släppta ord, spår).

    Prioritetsordningen är avgörande och följer hur mycket ordet identifierar:

      1. ORD SOM INTE FINNS i korpusen alls — "bycrea". Att kräva ett ord som
         ingen annons innehåller kan bara ge noll träffar.
      2. BESKRIVANDE ord — material, färg, typord. De är redan lästa av
         attributkedjan och styr typfiltret därifrån, så att släppa dem ur
         SÖKNINGEN förlorar ingen information.
      3. Sist, och helst aldrig: modellnamn och märke. Släpps de är frågan i
         praktiken anonym, och anonymitetsreglerna tar över — inklusive
         tvånget att prissätta på utropspriser.

    Attributen läses ur den URSPRUNGLIGA texten INNAN något släpps. Samma
    princip som core_name-fixen: läs först, stryk sen. Ett släppt typord ska
    fortfarande styra typfiltret.
    """
    minimum = config.TERM_RELAX_MIN if minimum is None else minimum
    clean, _ = strip_stopwords(name)
    tokens = _tokenize(normalize_text(clean))
    if len(tokens) < 2:
        return None, [], []

    blob = listings["search_blob"]
    # Hur många annonser innehåller ordet ÖVER HUVUD TAGET? Ett ord med noll
    # egna träffar kan aldrig ingå i en icke-tom konjunktion.
    alone = {t: int(_token_hit(blob, t).sum()) for t in set(tokens)}
    generic = {t for t in tokens if _token_is_generic(t)}

    def rank(token: str) -> tuple:
        """Lägre = släpps först.

        Första nyckeln är avgörande och var fel i första försöket: ett ord som
        ENSAMT har färre träffar än golvet kan aldrig bära frågan, hur
        identifierande det än är. "bycrea" finns 8 gånger i korpusen och
        "matgrupp" 17 386 — att släppa `matgrupp` för att det är ett
        beskrivande ord gav svaret 1 095 kr för en matgrupp, alltså priset på
        vad som råkar heta bycrea.

        Ordningen är därför:
          0  ordet kan inte bära en fråga ens ensamt (alone < golvet)
          1  beskrivande ord — redan lästa av attributkedjan, styr typfiltret
             därifrån, så sökningen förlorar inget på att släppa dem
          2  allt annat: modellnamn och märke, släpps sist och helst aldrig
        Inom varje nivå släpps det SÄLLSYNTASTE först.
        """
        if alone[token] < minimum:
            # Kan inte bära en fråga ens ensamt. Sällsyntast först.
            return (0, alone[token])
        if token in generic:
            # Beskrivande ord. Redan lästa av attributkedjan.
            return (1, alone[token])
        # Modellnamn och märke. Här är sorteringen OMVÄND: bland identifierande
        # ord är det SÄLLSYNTA mest värdefullt, så det VANLIGASTE släpps först.
        #
        # Rättat 2026-08-19. Med sällsyntast-först släpptes `capella`
        # (188 träffar) före `kinnarps` (3 851), alltså modellnamnet före
        # märket — och Kinnarps Capella X gick från 1 480 kr (träff) till
        # 458 kr på benchmarken.
        return (2, -alone[token])

    order = sorted(set(tokens), key=rank)
    dropped, trail = [], []
    remaining = list(tokens)
    for token in order:
        hits = find_listings(listings, " ".join(remaining), brand,
                             condition=None, price_kind=None)
        if len(hits) >= minimum:
            break
        if len(remaining) <= 1:
            break
        before = len(hits)
        remaining = [t for t in remaining if t != token]
        after = len(find_listings(listings, " ".join(remaining), brand,
                                  condition=None, price_kind=None))
        dropped.append(token)
        trail.append({"term": token, "before": before, "after": after,
                      "aloneInCorpus": alone[token]})
        if after >= minimum:
            break

    if not dropped:
        return None, [], []
    return (find_listings(listings, " ".join(remaining), brand,
                          condition=None, price_kind=None),
            dropped, trail)


def find_listings(
    listings: pd.DataFrame,
    name: str,
    brand: str | None = None,
    condition: str | None = None,
    price_kind: str | None = config.DEFAULT_PRICE_KIND,
) -> pd.DataFrame:
    """Hittar annonser som matchar förfrågan.

    Ordning enligt specen: varumärke -> modellnamn -> (valfritt) skick.

    Matchningen är ordbaserad, inte delsträngsbaserad: varje ord i sökningen
    måste finnas någonstans i annonstexten, oberoende av ordning och
    skiljetecken. Delsträngsmatchning krävde en sammanhängande teckensekvens
    och missade därför majoriteten av de giltiga träffarna — "Landskrona
    3-sits" hittade 95 annonser, medan "Soffa IKEA LANDSKRONA Grå 3-sits",
    "LANDSKRONA soffa 3-sits" och "Landskrona 3 sits grön" föll bort.
    """
    matches = listings

    # Delar och tillbehör bort direkt. Modellnamnet bärs av hela
    # reservdelssortimentet, så "IKEA PAX" drog in gångjärn för 25 kr och
    # klädstänger för 30 kr i samma median som garderoberna — 17,5 % av
    # underlaget låg under 200 kr. Se variant.PART.
    if "variant" in matches.columns:
        matches = matches[matches["variant"] != variant_mod.PART]

    # Prissort: utropspriser och realiserade priser får inte blandas,
    # de har olika prisnivå (median 900 vs 800 kr i datan).
    if price_kind and matches["price_kind"].notna().any():
        matches = matches[matches["price_kind"] == price_kind]

    # --- 1. Varumärke (skiftlägesokänsligt, normaliserat) -----------------
    # brand-kolumnen är null på 97,7 % av raderna, så en ren kolumnmatchning
    # skulle kasta bort nästan hela underlaget. Vi accepterar därför träff
    # antingen i brand-kolumnen eller i annonstexten. Tvåordsmärken som
    # "Fritz Hansen" matchar även när orden står isär i titeln.
    if brand:
        brand_key = normalize_text(brand)
        if brand_key:
            in_text = _all_tokens_hit(matches["search_blob"], brand_key)
            if in_text is not None:
                matches = matches[(matches["brand_norm"] == brand_key) | in_text]

    # --- 2. Modellnamn: alla ord måste finnas -----------------------------
    # Filtreras ord för ord så att varje efterföljande sökning körs på en
    # allt mindre delmängd, istället för att bygga hela masken över 1,5M rader.
    if name:
        # Funktionsorden stryks FÖRE matchningen. De är hårda krav i en
        # konjunktiv sökning och identifierar ingenting — se strip_stopwords.
        clean, _ = strip_stopwords(name)
        for token in _tokenize(normalize_text(clean)):
            matches = matches[_token_hit(matches["search_blob"], token)]

    # --- 3. Skick, bara om det angavs ------------------------------------
    # Filtreras på nivå, inte på de fyra råa värdena: Nyskick och Mycket bra
    # skick är samma prissättningsnivå.
    if condition and "condition_tier" in matches.columns:
        tier = condition_tier(condition)
        if tier:
            matches = matches[matches["condition_tier"] == tier]

    return matches


def identity_is_anonymous(name: str, brand: str | None) -> bool:
    """Går varken märke eller modellnamn att fastställa ur förfrågan?

    Ett märke räcker för att identiteten är känd — "Bellus soffa" är en Bellus.
    Utan märke krävs minst ett ord som INTE bara beskriver möbeln: "Matgrupp
    5 stolar" och "Ekbord med stolar" består uteslutande av typord, siffror och
    material, och identifierar därför ingen produkt.

    Se config.FORCE_ASKING_WHEN_ANONYMOUS för vad det får för konsekvens.
    """
    if brand and normalize_text(brand):
        return False
    for token in _tokenize(normalize_text(name or "")):
        if not _token_is_generic(token):
            return False
    return True


def _token_is_generic(token: str) -> bool:
    """Beskriver ordet bara möbeln, eller identifierar det en produkt?

    Svenskan sätter ihop ord, så en ordlista räcker inte: "ekbord" är
    `ek` + `bord` och "sitssoffa" är `sits` + `soffa`, men ingen av dem står i
    listan. Regeln blir därför att ett ord är generiskt om det står i listan,
    ELLER om det slutar på ett listat typord och resten också är generisk.

    Suffixet måste vara minst fyra tecken, annars börjar modellnamn falla:
    "Landskrona" slutar på "ona", "Strandmon" på "mon".
    """
    if token.isdigit() or token in config.GENERIC_TOKENS:
        return True
    for word in config.GENERIC_TOKENS:
        if len(word) >= 4 and token.endswith(word) and len(token) > len(word):
            head = token[: -len(word)]
            # Svenska sammansättningar skjuter in ett foge-s: "sammetssoffa"
            # är sammet + s + soffa.
            for candidate in (head, head[:-1] if head.endswith("s") else head):
                if candidate and (candidate in config.GENERIC_TOKENS
                                  or _token_is_generic(candidate)):
                    return True
    return False


BASIS_LABELS = {
    "realized": "faktiskt betalda priser (auktion)",
    "asking": "utropspriser i annonser",
    "all": "både utrops- och slutpriser",
    "realized_corrected": (
        "auktionspriser uppräknade till utropsnivå (för få utropsannonser)"
    ),
    "asking_forced_unknown_identity": (
        "utropspriser i annonser (auktionsdata utesluten: varken märke eller"
        " modellnamn kunde fastställas)"
    ),
}


def _brand_class(candidates: pd.DataFrame) -> str | None:
    """Märkesklassen bland kandidaterna — styr auktionskorrektionen."""
    if candidates.empty or "search_blob" not in candidates.columns:
        return None
    sample = " ".join(candidates["search_blob"].head(200).fillna(""))
    for klass, brands in config.BRAND_CLASSES.items():
        if any(f" {b} " in f" {sample} " or sample.startswith(b) for b in brands):
            return klass
    return None


def _correct_auction(frame: pd.DataFrame, klass: str | None) -> tuple:
    """Räknar upp auktionspriser till utropsnivå. Se config.AUCTION_CORRECTION.

    Priserna skrivs om på en kopia så att alla percentiler nedströms blir
    konsekventa — korrigerar man bara medianen blir intervallet fel.
    """
    factor = config.AUCTION_CORRECTION.get(klass,
                                           config.AUCTION_CORRECTION_DEFAULT)
    out = frame.copy()
    out["price"] = out["price"] * factor
    return out, factor


def _select_basis(candidates: pd.DataFrame, price_kind: str | None,
                  anonymous: bool = False) -> tuple:
    """Väljer prissort och returnerar (träffar, basnamn).

    `anonymous` betyder att förfrågan inte identifierar någon produkt. Då
    utesluts auktionsdata helt — se config.FORCE_ASKING_WHEN_ANONYMOUS.
    """
    if "price_kind" not in candidates.columns or candidates["price_kind"].isna().all():
        return candidates, "all"

    if anonymous and config.FORCE_ASKING_WHEN_ANONYMOUS:
        asking = candidates[candidates["price_kind"] == "asking"]
        if len(asking):
            return asking, "asking_forced_unknown_identity"
        # Finns inga utropspriser alls faller vi tillbaka — men då är det
        # tydligt i svaret att basen inte är den önskade.

    if price_kind == "auto":
        realized = candidates[candidates["price_kind"] == "realized"]
        asking = candidates[candidates["price_kind"] == "asking"]

        # UTROP FÖRST. Motorn hjälper någon sälja på en marknadsplats, så
        # utropspriset är rätt marknad även när auktionshusen har fler rader.
        # Räcker utropen till en jämförelsemängd används de.
        if config.BASIS_PREFER_ASKING:
            if len(asking) >= config.BASIS_MIN_ASKING:
                return asking, "asking"
            if len(realized) and len(realized) > len(asking):
                # Auktion som fallback — men uppräknad till utropsnivå med en
                # kvot mätt parvis inom modell. Se config.AUCTION_CORRECTION.
                corrected, factor = _correct_auction(
                    realized, _brand_class(candidates)
                )
                return corrected, f"realized_corrected_{factor:g}"
            if len(asking):
                return asking, "asking"
            return realized, "realized"

        # Gamla dominansregeln, kvar bakom flaggan för jämförbarhet.
        threshold = max(
            config.AUTO_MIN_REALIZED, len(asking) * config.AUTO_REALIZED_SHARE
        )
        if len(realized) >= threshold:
            return realized, "realized"
        if len(asking) >= len(realized):
            return asking, "asking"
        return realized, "realized"

    if price_kind:
        return candidates[candidates["price_kind"] == price_kind], price_kind
    return candidates, "all"


def _apply_recency(matches: pd.DataFrame) -> tuple:
    """Begränsar till färska annonser. Returnerar (träffar, metod, gräns).

    Marknaden faller mätbart — medianen i hela datan har gått från 1 167 kr
    (2024-07) till 700–750 kr (2026) — och 92 % av annonserna är från archive
    som slutar 2025-12. Utan filter dominerar alltså gamla priser.

    Fönstret är RECENCY_MONTHS månader. Räcker det inte utökas det bakåt: de
    senaste annonserna tas med även utanför fönstret tills RECENCY_MIN_LISTINGS
    är uppnått. Hellre några gamla priser än ett svar byggt på tre annonser.
    """
    if "listed_at" not in matches.columns:
        return matches, "none", None

    dated = matches[matches["listed_at"].notna()]
    if dated.empty:
        # Ingen tidsstämpel alls — filtrera inte, hellre gammalt än tomt.
        return matches, "none", None

    cutoff = pd.Timestamp.now(tz="UTC") - pd.DateOffset(months=config.RECENCY_MONTHS)
    fresh = dated[dated["listed_at"] >= cutoff]
    if len(fresh) >= config.RECENCY_MIN_LISTINGS:
        return fresh, "window", cutoff

    # Utöka bakåt tills golvet nås. nlargest ger de senaste oavsett ålder.
    return dated.nlargest(config.RECENCY_MIN_LISTINGS, "listed_at"), "extended", cutoff


def _median_tier(matches: pd.DataFrame) -> str | None:
    """Medianskicket bland träffarna — den nivå som får faktor 1,0.

    Träffarna sorteras sämst -> bäst skick och medianen tas. Motiveringen är
    att medianPRISET per konstruktion speglar batchens medianSKICK: är de
    flesta annonserna i "Bra skick" så är medianpriset ett Bra skick-pris,
    och då är det den nivån som ska lämnas orörd.

    Mätt på riktig data är medianskicket "Bra skick" i varje undersökt
    sökning — men det räknas ut per förfrågan, inte antas.
    """
    if "condition_tier" not in matches.columns:
        return None
    tiers = matches["condition_tier"].dropna()
    if len(tiers) < config.CONDITION_ANCHOR_MIN:
        return None

    counts = tiers.value_counts()
    seen, halfway = 0, len(tiers) / 2
    for tier in config.CONDITION_TIER_ORDER_WORST_FIRST:
        seen += int(counts.get(tier, 0))
        if seen >= halfway:
            return tier
    return None


def _apply_image(matches: pd.DataFrame, query, store) -> tuple:
    """Fas 6 — omsortering på bildlikhet. (träffar, metod, spann).

    Detta är INTE en sökmotor utan en omsortering: kandidaterna är redan
    filtrerade på märke, modell, typ och skick. Bilden rangordnar bara dem.
    Därmed kan en fåtölj inte matcha en soffa för att bakgrunden är lika, och
    vi jämför mot ~200 vektorer i stället för 94 000.

    Fallback: överlever för få annonser lättas tröskeln stegvis, och till sist
    tas de K mest lika. Metoden i svaret säger alltid vilket som hände.
    """
    if query is None or store is None or not store.ready:
        return matches, "none", None

    rows = store.rows_for(matches)
    have = rows >= 0
    if have.sum() < config.IMAGE_MIN_LISTINGS:
        # För få kandidater har embeddad bild — filtrera inte alls.
        return matches, "none", None

    scored, rows = matches[have], rows[have]
    query_vec, query_color = query
    sims = vision_mod.similarity(
        query_vec, query_color, store.embeddings[rows], store.colors[rows]
    )

    thresholds = (config.IMAGE_SIMILARITY_MIN, *config.IMAGE_LOOSEN_STEPS)
    for i, threshold in enumerate(thresholds):
        keep = sims >= threshold
        if keep.sum() >= config.IMAGE_MIN_LISTINGS:
            method = "filtered" if i == 0 else "loosened"
            kept = sims[keep]
            return scored[keep], method, (float(kept.min()), float(kept.max()))

    # Ingen tröskel räckte — ta de mest lika oavsett poäng.
    top = np.argsort(-sims)[: config.IMAGE_TOP_K]
    if len(top) < config.IMAGE_MIN_LISTINGS:
        return matches, "none", None
    return (
        scored.iloc[top],
        "loosened",
        (float(sims[top].min()), float(sims[top].max())),
    )


def _broad_candidates(
    listings: pd.DataFrame, brand: str | None, variants: list | None,
    matches: pd.DataFrame, price_kind: str | None,
) -> pd.DataFrame:
    """Bredare jämförelsemängd: samma märke och möbeltyp, UTAN modellnamn.

    Modellnamnet är det som gör mängden tunn, så det är det som släpps. Märket
    och möbeltypen behålls — en Kinnarps kontorsstol jämförs med andra
    Kinnarps kontorsstolar, inte med alla kontorsstolar i landet (det gav
    500 kr mot facit 1 300-1 600).

    Möbeltypen tas från förfrågan när den är känd, annars från vad de smala
    träffarna faktiskt är. Det andra fallet är viktigt: utan bild vet motorn
    inte typen, men de tre Capella-annonserna är alla stolar.
    """
    if "variant" in matches.columns and not matches.empty:
        modal = matches["variant"].mode()
        fallback_variants = [modal.iloc[0]] if len(modal) else []
    else:
        fallback_variants = []
    targets = list(variants) if variants else fallback_variants
    targets = [v for v in targets if v and v != variant_mod.UNKNOWN]

    broad = find_listings(listings, name="", brand=brand, condition=None,
                          price_kind=None)
    if broad.empty:
        return broad
    broad, _ = _select_basis(broad, price_kind)
    if targets and "variant" in broad.columns:
        broad = broad[broad["variant"].isin(targets)]
    broad, _, _ = _apply_recency(broad)
    return broad


def _apply_shrinkage(
    result: PriceRange, listings: pd.DataFrame, brand: str | None,
    variants: list | None, matches: pd.DataFrame, price_kind: str | None,
) -> tuple:
    """Glider ett tunt svar mot den bredare skattningen. Se config.FALLBACK_*.

    Returnerar (intervall, info) där info är None när ingen blandning skedde.
    """
    n = result.match_count
    if not n or n >= config.FALLBACK_BELOW:
        return result, None

    broad = _broad_candidates(listings, brand, variants, matches, price_kind)
    if len(broad) < config.FALLBACK_MIN_BROAD:
        return result, None

    wide = compute_price_range(broad["price"].tolist())
    if not wide.match_count or wide.default is None or result.default is None:
        return result, None

    weight = n / (n + config.FALLBACK_SHRINKAGE_K)

    def blend(narrow: float, broad_value: float) -> int:
        # Geometriskt: priser är multiplikativa, och ett fel på 2x uppåt ska
        # väga lika mycket som 2x nedåt.
        if narrow <= 0 or broad_value <= 0:
            return round(narrow)
        return round(math.exp(weight * math.log(narrow)
                              + (1 - weight) * math.log(broad_value)))

    before = result.default
    result.low = blend(result.low, wide.low)
    result.default = blend(result.default, wide.default)
    result.high = blend(result.high, wide.high)
    # Kanterna kan korsa mitten efter blandningen om de smala och breda
    # fördelningarna lutar olika. Sortera om i stället för att låta ett
    # intervall vända sig inåt.
    result.low, result.default, result.high = sorted(
        (result.low, result.default, result.high)
    )
    return result, {
        "method": "shrinkage",
        "weight": round(weight, 3),
        "narrowCount": int(n),
        "broadCount": int(wide.match_count),
        "narrowDefault": round(before),
        "broadDefault": round(wide.default),
    }


#: Rader som ALDRIG är rätt jämförelse, hur tunn mängden än blir. En klädsel till
#: en Ektorp är inte en Ektorp, en "liknande Lamino" är inte en Lamino, och en
#: lös schäslongsektion är inte en soffa. De kastas utan golvprövning.
CELL_JUNK_FLAGS = ("is_bundle", "is_accessory_only", "is_comparison", "is_section")


def _cell_filter(candidates: pd.DataFrame, name: str,
                 brand: str | None) -> tuple:
    """Rensningssteget: cellflaggorna som filter PÅ textsökningen.

    Textsökningen förblir motorn — den här funktionen tar bort skräp ur dess
    träffmängd, den söker aldrig själv. Skälet är mätt: en cell som ERSÄTTER
    sökningen kollapsar till märke x typ när modellordet saknas, och blir då en
    bredare jämförelsemängd än den textsökning den ersatte.

    Returnerar `(behållna, mjuk_mask, räknare)`:

      behållna    träffmängden utan skräpraderna
      mjuk_mask   rader vars typ MOTSÄGER frågans, när golvet stoppade
                  bortkastningen — de viktas ned senare i stället
      räknare     antal kastade per kategori, för svaret

    En bunt räknas som skräp bara när frågan INTE är en bunt. Söker användaren
    "matgrupp bord och 4 stolar" är buntarna precis rätt jämförelse, och att
    kasta dem hade lämnat kvar lösa bord.
    """
    from type_system import grouping

    if not any(flag in candidates.columns for flag in CELL_JUNK_FLAGS):
        return candidates, None, {}

    guess = grouping.classify(name or "")
    dropped: dict = {}
    junk = pd.Series(False, index=candidates.index)
    for flag in CELL_JUNK_FLAGS:
        if flag not in candidates.columns:
            continue
        if flag == "is_bundle" and guess.is_bundle:
            continue
        mask = candidates[flag].fillna(False).astype(bool)
        fresh = mask & ~junk
        if fresh.any():
            dropped[flag] = int(fresh.sum())
        junk |= mask
    kept = candidates[~junk]

    # --- typmotsägelse ----------------------------------------------------
    # OKÄND typ är inte en motsägelse. Två tredjedelar av korpusen har ingen
    # utskriven möbeltyp i rubriken, och att kasta dem hade tömt mängden på det
    # mesta av dess underlag utan att ta bort ett enda fel.
    wanted = guess.product_type
    contradiction = None
    if wanted and "cell_type" in kept.columns:
        kind = kept["cell_type"].fillna("okand").astype(str)
        known = ~kind.isin(("okand", "")) & ~kind.str.startswith("bunt:")
        contradiction = known & kind.ne(wanted)
        if contradiction.any():
            if len(kept[~contradiction]) >= config.MIN_COMPARISON_SET:
                dropped["typmotsagelse"] = int(contradiction.sum())
                kept = kept[~contradiction]
                contradiction = None
            else:
                # Golvet stoppade filtret: raderna behålls men viktas ned.
                dropped["typmotsagelse_nedviktad"] = int(contradiction.sum())
                contradiction = kept.index[contradiction]
        else:
            contradiction = None

    return kept, contradiction, dropped


def _weights_for(frame: pd.DataFrame, mask) -> pd.Series:
    """1,0 för de som filtret behöll, FILTER_DOWNWEIGHT för resten."""
    return pd.Series(
        np.where(np.asarray(mask), 1.0, config.FILTER_DOWNWEIGHT),
        index=frame.index,
    )


def _floor_or_weight(frame: pd.DataFrame, weights: pd.Series, mask,
                     label: str, state: dict) -> tuple:
    """Applicerar ett filter — eller konverterar det till viktning.

    Golvet är arkitekturen: ingen filterkedja får ta jämförelsemängden under
    config.MIN_COMPARISON_SET. Skulle detta filter bryta golvet behålls
    annonserna, men de filtret velat kasta väger FILTER_DOWNWEIGHT i stället.

    Skälet är mätt: variantfilter plus bildomsortering tog Vimle från 117
    träffar till 40 och Santos från 24 till 7, varpå shrinkagen drog svaret mot
    märkesnivån och default-träffen föll från 90,9 % till 72,7 %. Varje filter
    var rimligt; produkten av dem var det inte.
    """
    mask = np.asarray(mask, dtype=bool)
    if not mask.any() or mask.all():
        return frame, weights, state

    kept = frame[mask]
    if len(kept) >= config.MIN_COMPARISON_SET:
        state["applied"].append(label)
        return kept, weights[kept.index], state

    state["converted"].append(label)
    return frame, weights * _weights_for(frame, mask), state


def _apply_size(matches: pd.DataFrame, weights: pd.Series, wanted: str | None,
                state: dict) -> tuple:
    """Storleksfiltret — steget under variant, under samma golv som alla filter.

    Ingen egen specialmekanik: filtret går genom `_floor_or_weight` precis som
    variant och bild, så en modell med få annonser i rätt storlek får dem
    viktade i stället för att svälta.
    """
    if not wanted or "size" not in matches.columns or matches.empty:
        return matches, weights, state, "none"
    mask = (matches["size"] == wanted).to_numpy()
    if not mask.any():
        return matches, weights, state, "no_match"
    frame, weights, state = _floor_or_weight(matches, weights, mask, "storlek",
                                             state)
    method = "weighted" if "storlek" in state["converted"] else "filtered"
    return frame, weights, state, method


def _apply_cues(matches: pd.DataFrame, cues: list) -> tuple:
    """Rangordnar kandidaterna på ledord och behåller de mest lika.

    RANGORDNANDE, inte filtrerande. Att stapla hårda filter beskär för hårt:
    variantfilter plus bildomsortering tog Vimle från 117 träffar till 40 och
    Santos från 24 till 7, varpå shrinkage drog svaret mot märkesnivån. Här
    behålls därför bara de kandidater som ligger över medianpoängen, och bara
    om minst CUE_MIN_LISTINGS blir kvar.
    """
    if not cues or matches.empty or "search_blob" not in matches.columns:
        return matches, "none", None

    blob = matches["search_blob"].fillna("")
    score = pd.Series(0.0, index=matches.index)
    for word, lift in cues:
        score += blob.str.contains(word, regex=False, na=False) * float(lift)

    if not (score > 0).any():
        return matches, "no_hits", None

    cutoff = float(score[score > 0].median())
    kept = matches[score >= cutoff]
    if len(kept) < config.CUE_MIN_LISTINGS or len(kept) == len(matches):
        return matches, "too_few", [w for w, _ in cues[:6]]
    return kept, "ranked", [w for w, _ in cues[:6]]


def _join_sv(labels) -> str:
    """['soffa', 'bäddsoffa'] -> 'soffa eller bäddsoffa'."""
    labels = list(labels or [])
    if len(labels) <= 1:
        return labels[0] if labels else "(ingen)"
    return " eller ".join([", ".join(labels[:-1]), labels[-1]])


def _apply_variant(base: pd.DataFrame, targets: list | None) -> tuple:
    """Filtrerar på möbeltyp. Returnerar (träffar, metod).

    `targets` kan innehålla flera typer — bildmodellen får svara "soffa eller
    bäddsoffa" när skillnaden inte syns på foto. Då tas unionen, vilket
    fortfarande utesluter fotpall och fåtölj.

    Två steg, av samma skäl som skickkedjan: strikt filtrering är exakt men
    kollapsar på ovanliga varianter, och 26,5 % av annonserna anger ingen typ
    alls i titeln. De okända kan vara vad som helst och får inte uteslutas
    i onödan.
    """
    # Vilken kolumn som filtreras beror på vilken taxonomi typerna kommer ur.
    # Attributsystemets typer (`hornsoffa`, `skank`, `fatolj`) finns bara i
    # `derived_type`; den gamla taxonomins (`hörnsoffa`, `byrå`) bara i
    # `variant`. Att blanda dem ger noll träffar — se type_system/taxonomy.py.
    column = ("derived_type"
              if config.TYPE_SYSTEM_DRIVES_SEARCH and "derived_type" in base.columns
              else "variant")
    if not targets or column not in base.columns:
        return base, "none"

    if column == "variant" and config.TYPE_SYSTEM_DRIVES_SEARCH:
        # Kanoniska typer mot en gammal kolumn: översätt, annars ger filtret
        # noll träffar. Typer den gamla taxonomin saknar (skank, vitrin,
        # soffbord) faller bort — hellre inget filter än fel filter.
        from type_system import taxonomy

        available = taxonomy.legacy_vocabulary(base)
        translated = [t for t in (taxonomy.to_legacy(k, available) for k in targets)
                      if t]
        if not translated:
            # Typen fanns men går inte att uttrycka i den gamla kolumnen.
            # "ignored" och inte "none": ett filter begärdes och släpptes,
            # vilket är en annan sak än att inget filter fanns.
            return base, "ignored"
        targets = translated

    strict = base[base[column].isin(targets)]
    if len(strict) >= config.VARIANT_STRICT_MIN:
        return strict, "filtered"

    # Noll märkta träffar betyder att typen inte gäller den här modellen —
    # det finns ingen Landskrona-säng. Att då behålla de omärkta annonserna
    # vore att prissätta en möbel som inte existerar; släpp filtret istället.
    if len(strict) == 0:
        return base, "ignored"

    # Uteslut bara annonser som positivt ÄR något annat; behåll de okända.
    # Nya taxonomin markerar okänd typ med None, den gamla med strängen UNKNOWN.
    if column == "derived_type":
        relaxed = base[base[column].isin(targets) | base[column].isna()]
    else:
        relaxed = base[base[column].isin(list(targets) + [variant_mod.UNKNOWN])]
    if len(relaxed) >= config.VARIANT_STRICT_MIN and len(relaxed) < len(base):
        return relaxed, "relaxed"

    # Underlaget räcker inte ens relaxat — hellre bredare än tomt.
    return base, "ignored"


def _resolve_via_type_system(base, variant, image, query, vectors, listings,
                             name, brand, classifier=None,
                             media_type: str = "image/jpeg") -> tuple:
    """Typen ur attributsystemet. (typer, kandidater, metod).

    Returnerar en LISTA, inte ett värde: när ett prisviktigt attribut är okänt
    söker motorn över unionen av möjliga typer i stället för att gissa. Det är
    L5:s kärna — ett okänt attribut ska ge ett bredare underlag, aldrig ett
    falskt precist.
    """
    from type_system import chain
    from type_system.attributes import candidate_types, derive_type

    user_answers = None
    if variant:
        # Anroparen har angett typen explicit. Den går in som `user`, högsta
        # källan, och kan inte skrivas över av något lager.
        wanted = [variant] if isinstance(variant, str) else list(variant)
        from type_system.taxonomy import fold, is_canonical

        folded = [f for f in (fold(w) for w in wanted) if f and is_canonical(f)]
        if folded:
            return folded, [], "explicit"
        # Angiven men otolkbar typ ska inte filtrera på ett värde som inte
        # finns — det ger noll träffar, vilket är värre än inget filter.
        return None, [], "none"

    try:
        result = chain.resolve(
            name=name or "", brand=brand,
            user_answers=user_answers,
            queries=[query[0]] if query is not None else None,
            store=vectors, listings=listings,
            candidates=None, use_vision=False, ask_user=False,
        )
    except Exception as exc:  # noqa: BLE001 - typvalet får aldrig fälla priset
        log.warning("Attributsystemet misslyckades, faller tillbaka: %s", exc)
        return None, [], "type_system_error"

    kinds = list(result.possible_types)
    source = result.attributes.source("base") or "unknown"

    # En explicit inskickad klassificerare är anroparens egen typorakel för just
    # den här bilden. Den anlitas i två lägen, och aldrig när kedjan redan är
    # entydig — då finns inget att tillföra och anropet vore bortkastat:
    #
    #   kedjan tom      -> klassificeraren får SÄTTA typen
    #   kedjan tvetydig -> den får SMALNA AV unionen, aldrig bredda den
    #
    # Att låta den bredda vore att låta bilden lägga till typer, och bilden är
    # mätt sämst av alla källor på undertyp.
    if classifier is not None and image is not None and len(kinds) != 1:
        candidates = variant_mod.available_variants(base)
        if len(candidates) >= 2:
            picked = _narrow_by_classifier(
                kinds or None, candidates, classifier, image, media_type,
                name, brand)
            if picked:
                method = "classifier" if not kinds else f"{source}+classifier"
                return picked, candidates, f"type_system:{method}"

    if not kinds:
        return None, [], "unresolved"
    method = f"type_system:{source}"
    if len(kinds) > 1:
        method += f"+union{len(kinds)}"
    return kinds, [], method


def _narrow_by_classifier(kinds, candidates, classifier, image, media_type,
                          name, brand):
    """Klassificerarens svar, vikt och begränsat till unionen.

    Returnerar None när den inte kan användas: låg konfidens, tomt svar, eller
    svar utanför de typer som fortfarande är möjliga. Att låta den lägga TILL en
    typ vore att låta bilden bredda underlaget, och bilden är mätt sämst av alla
    källor på undertyp.
    """
    from type_system.taxonomy import fold

    try:
        guess = classifier(image_bytes=image, candidates=candidates,
                           name=name, brand=brand, media_type=media_type)
    except Exception as exc:  # noqa: BLE001 - typvalet får aldrig fälla priset
        log.warning("Klassificeraren misslyckades: %s", exc)
        return None
    if guess is None or getattr(guess, "confidence", "låg") == "låg":
        return None
    from type_system.taxonomy import is_canonical

    folded = [f for f in (fold(v) for v in getattr(guess, "variants", []))
              if f and is_canonical(f)]
    if kinds is None:
        # Kedjan hade ingen åsikt — klassificeraren får sätta typen.
        return folded or None
    narrowed = [k for k in kinds if k in folded]
    return narrowed or None


def _resolve_variants(
    base: pd.DataFrame,
    variant,
    image: bytes | None,
    image_media_type: str,
    classifier,
    name: str,
    brand: str | None,
    query=None,
    vectors=None,
    listings: pd.DataFrame | None = None,
    attribute_text: str | None = None,
) -> tuple:
    """Bestämmer vilka möbeltyper som ska filtreras på. (typer, kandidater, metod).

    Ordningen är vald efter kostnad och tillförlitlighet:

      1. Explicit `variant` — gratis och kan inte gissa fel.
      2. DINOv2 mot de 94 000 embeddade annonsbilderna. Lokal, gratis, och
         kalibrerad mot den faktiska datan. Kan svara "vet inte".
      3. OpenAI. Kostar per förfrågan och kan sluta fungera — vilket den gjorde
         mitt i en utvärdering när krediterna tog slut, och då föll hela
         bildvägen bort. Den är därför sista utpost, inte första.

    Varför detta avgör priset: Mio Town finns som rak soffa OCH hörnsoffa, och
    bland träffarna ligger hyllor och fotpallar med samma modellnamn. Blandat
    ger p40 6 000 kr mot facit 7 000-12 000.
    """
    # --- Attributsystemet (L0-L5) -------------------------------------------
    # Med flaggan på avgörs typen av `type_system`: texten, modellnamnspriorn
    # och bilden i den ordningen, och resultatet är den MÄTTA taxonomin
    # (fatolj 2,60x, skank 1,691x, soffbord 0,492x) i stället för den gamla.
    #
    # Priset räknas oförändrat — median över träffmängden. Det enda som ändras
    # är vilka annonser som hamnar där.
    if config.TYPE_SYSTEM_DRIVES_SEARCH:
        return _resolve_via_type_system(
            base, variant, image, query, vectors, listings,
            attribute_text or name, brand,
            classifier=classifier, media_type=image_media_type)

    if variant:
        wanted = [variant] if isinstance(variant, str) else list(variant)
        resolved = [
            v for v in (variant_mod.normalize_variant(w) for w in wanted) if v
        ]
        return (resolved or None), [], "explicit"

    # Textens egen typ, om förfrågan råkar innehålla ett typord
    # ("Söderhamn bäddsoffa"). Används både som fallback när bilden avstår och
    # som jämförelse när båda har en åsikt.
    text_variant = variant_mod.normalize_variant(name or "")

    if image is None:
        return ([text_variant] if text_variant else None), [], (
            "text" if text_variant else "none")

    candidates = variant_mod.available_variants(base)
    # Noll kandidater: inget att filtrera på. En enda: filtret ändrar ingenting
    # (en Billy är alltid en hylla). I båda fallen är arbetet bortkastat.
    if len(candidates) < 2:
        return ([text_variant] if text_variant else None), candidates, (
            "text" if text_variant else "single_candidate")

    offered = {label for label, _ in candidates}

    # --- 2. DINOv2-grannarna ------------------------------------------------
    if query is not None and vectors is not None and listings is not None:
        from . import visual_variant

        guessed, _ = visual_variant.classify(query[0], vectors, listings)
        # Bara typer som faktiskt finns för den sökta modellen. En typ som
        # inte skulle klara filtret får aldrig erbjudas — annars svarar
        # motorn med noll träffar.
        guessed = [v for v in guessed if v in offered]
        if guessed:
            # Motsäger bilden texten vinner BILDEN — det är den enda uppgift
            # bilden har kvar, och texten kan sakna typordet helt eller bära
            # ett som beskriver serien snarare än exemplaret. Konflikten
            # rapporteras så att andelen går att följa.
            if text_variant and text_variant not in guessed:
                return guessed, candidates, f"dinov2_conflict:{text_variant}"
            return guessed, candidates, "dinov2"

    # --- 3. OpenAI ----------------------------------------------------------
    guess = (classifier or variant_mod.classify_image)(
        image_bytes=image,
        candidates=candidates,
        name=name,
        brand=brand,
        media_type=image_media_type,
    )
    # En klassificerare som ger något oväntat får inte fälla prisförfrågan —
    # möbeltypen är ett hjälpmedel, inte ett krav.
    if guess is None or not getattr(guess, "usable", False):
        # Bilden avstår. Textens typ om den finns, annars bredaste rimliga
        # sökning — och då ska svaret märkas osäkert, se steg G.
        if text_variant:
            return [text_variant], candidates, "text_fallback"
        return None, candidates, "unresolved"
    return list(guess.variants), candidates, "openai"


def price_query(
    listings: pd.DataFrame,
    name: str,
    brand: str | None = None,
    condition: str | None = None,
    price_kind: str | None = config.DEFAULT_PRICE_KIND,
    multipliers=None,
    variant=None,
    size: str | None = None,
    image: bytes | None = None,
    image_media_type: str = "image/jpeg",
    form_image: Optional[bytes] = None,
    classifier=None,
    vectors=None,
    image_rerank: bool = True,
    attribute_text: str | None = None,
    damages: list | None = None,
    form_hint: dict | None = None,
) -> dict:
    """Kör hela kedjan: matcha -> prisbas -> möbeltyp -> skick -> intervall.

    Tre val görs automatiskt och redovisas alltid i svaret, eftersom de
    påverkar prisnivån för mycket för att få vara implicita:

      priceBasis        realized eller asking (se _select_basis)
      variantMethod     filtered | relaxed | ignored | none
      conditionMethod   filtered | multiplier | ignored | none

    `attribute_text` är användarens HELA text, och används bara för att läsa
    attribut. `name` är söknyckeln och kan vara kapad: en anropare som vill
    matcha på "Söderhamn" skickar det som `name`, men "Söderhamn bäddsoffa" som
    `attribute_text`, så bäddfunktionen inte går förlorad.

    Utan den uppdelningen läses attributen ur en stympad text, och resten
    misstolkas: "Bolia soffa med puff" kapas till "med puff", och `puff` är ett
    fotpallsord — soffan blev en fotpall. Lämnas fältet tomt används `name`,
    vilket är rätt när anroparen inte kapat något.
    """
    # --- Steg A: kandidater, utan skick- och prissortfilter ----------------
    # En enda textsökning över ~1,5M rader; filtreringen sker på delmängden.
    # --- Steg A0: bilden skriver orden användaren inte skrev ---------------
    # Formord ("u-soffa") och tillbehör ("+ fotpall") ur lexikonets egna listor.
    # Skrivs in i FRÅGAN, så att allt nedströms fungerar oförändrat.
    # Har anroparen inte gett något form_hint men skickat en BILD, frågar vi
    # modellen själva. Det var hela poängen: användaren ska inte behöva skriva
    # "u-soffa" eller "+ fotpall" — bilden ska säga det.
    # `form_image` skiljs från `image` med flit. `image` nollställs av anroparen
    # när klienten redan valt möbeltyp, eftersom typklassningen då är onödig —
    # men FORMEN är en annan uppgift än typen. En soffa är en soffa vare sig
    # den är rak eller U-formad, så formlagret ska köra ändå.
    _form_src = form_image if form_image is not None else image
    if (config.FORM_VISION_ENABLED and form_hint is None
            and _form_src is not None):
        from type_system import form_layer as _fl

        try:
            # Familjen smalnar ordlistan från 19 ord till 6. Den tas ur
            # anroparens variant om den finns, annars ur textens egen typ.
            from type_system import grouping as _grp

            _base = _fl.base_family(
                *(list(variant) if variant else []),
                *_grp.classify(attribute_text or name or "").types)
            form_hint = _fl.ask(_form_src, base=_base,
                                media_type=image_media_type)
        except Exception:  # noqa: BLE001
            log.warning("Formlagret kunde inte anropas", exc_info=True)
            form_hint = None

    form_info = None
    if config.FORM_VISION_ENABLED and form_hint:
        from type_system import form_layer

        try:
            form_info = form_layer.enrich(attribute_text or name, form_hint)
            if form_info["added"]:
                log.info("Bilden lade till: %s", form_info["added"])
                attribute_text = form_info["text"]
                # Söknyckeln får BÅDE formordet och tillbehöret.
                #
                # Första försöket gav bara formordet, med resonemanget att
                # "+ fotpall" skulle styra buntlogiken utan att smalna
                # sökningen. Det var fel: en Lamino MED pall ska jämföras med
                # andra Lamino som också har pall, inte med alla Lamino. Utan
                # ordet i söknyckeln föll svaret 7 555 -> 5 743 kr i stället för
                # att stiga till ~10 700.
                #
                # Svälter ordet sökningen tar termuppmjukningen hand om det —
                # den släpper ord som ger för få träffar och redovisar det.
                name = form_info["text"]
        except Exception:  # noqa: BLE001 — bilden får aldrig fälla ett prissvar
            log.warning("Formlagret misslyckades", exc_info=True)
            form_info = {"error": "form_layer_failed"}

        # Ett misslyckat modellanrop MÅSTE synas i svaret. Förut stannade det i
        # en WARNING-rad i serverloggen: bilden avvisades som HEIC, priset kom
        # tillbaka utan formord, och svaret såg fullt rimligt ut. Ett tyst fel
        # är värre än ett högljutt, för det går inte att upptäcka utifrån.
        if isinstance(form_hint, dict) and form_hint.get("error"):
            form_info = dict(form_info or {})
            form_info["error"] = form_hint["error"]

    candidates = find_listings(listings, name, brand, condition=None, price_kind=None)
    _, ignored_terms = strip_stopwords(name)

    # --- Steg A1: termuppmjukning ------------------------------------------
    # Svälter sökningen släpps ord ett i taget, minst identifierande först.
    # Ett svar med bred osäkerhet är bättre än tystnad — men uppmjukningen får
    # aldrig ersätta ett svar som redan bar.
    relaxed_terms: list = []
    if len(candidates) < config.TERM_RELAX_MIN:
        wider, relaxed_terms, relax_trail = _relax_search(
            listings, name, brand)
        if wider is not None and len(wider) > len(candidates):
            candidates = wider
            log.info("Termuppmjukning: släppte %s", relaxed_terms)
        else:
            relaxed_terms = []
    cell_level = cell_key = None
    cell_dropped: dict = {}
    cell_soft = None

    # --- Steg A2: cellfiltret — rensning, inte sökning ---------------------
    # Textsökningen behålls oförändrad; cellflaggorna tar bort det som aldrig är
    # rätt jämförelse. Läses ur HELA texten av samma skäl som cellnyckeln: en
    # kapad söknyckel saknar möbelordet och kan inte avgöra typmotsägelse.
    if config.CELL_FILTER_ENABLED and not candidates.empty:
        candidates, cell_soft, cell_dropped = _cell_filter(
            candidates, attribute_text or name, brand)

    # --- Steg A2: priscellerna, bakom flagga -------------------------------
    # Textsökningen hittar annonser vars RUBRIK innehåller sökorden. Cellerna
    # grupperar på vad annonsen ÄR. Under namnet "Madison" låg fyra produkter i
    # fyra prisklasser — matta, soffa, bunt — och medianen togs över alla fyra.
    #
    # Cellen ersätter kandidatmängden men INGET annat: prisbas, variant,
    # färskhet, skick och storlek körs oförändrat på den. Hittas ingen cell
    # faller frågan tillbaka på textsökningen, så flaggan kan aldrig göra ett
    # svar till `no_data` som annars hade funnits.
    if config.PRICE_CELLS_ENABLED:
        from type_system import cells as cells_mod

        # HELA texten, inte söknyckeln. `name` kan vara kapad av anroparen —
        # "Söderhamn bäddsoffa" skickas som `name="Söderhamn"` med typordet i
        # `attribute_text`. Cellnyckeln innehåller produkttypen, så en kapad
        # text ger `okand` och slår upp en uppsamlingscell: Söderhamn hamnade i
        # `ikea|okand|` med 1 489 rader och prissattes till 299 kr mot facit
        # 2 000–2 500. Cellnyckeln är en attributavläsning och ska läsa samma
        # text som de andra attributen.
        cell_rows, cell_level, cell_key = cells_mod.lookup(
            listings, attribute_text or name, brand)
        if cell_rows is not None and not cell_rows.empty:
            candidates = cell_rows
        else:
            log.debug("Ingen cell för %r (%s) — faller tillbaka på text",
                      name, cell_level)

    # --- Steg B: välj prisbas ----------------------------------------------
    # Identitetsprövningen först: en anonym förfrågan får aldrig prissättas på
    # auktionsdata, oavsett vilken datamängd som råkar vara störst.
    anonymous = identity_is_anonymous(name, brand)
    base, basis = _select_basis(candidates, price_kind, anonymous=anonymous)

    # --- Frågebildens vektor -------------------------------------------------
    # Beräknas här, före möbeltypen, eftersom typbestämningen numera använder
    # den: DINOv2 mot de embeddade annonsbilderna avgör typen utan modellanrop.
    # Samma vektor återanvänds sedan i bildomsorteringen (steg F).
    query = None
    if image is not None and vectors is not None and vectors.ready:
        try:
            import io as _io

            from PIL import Image as _Image

            vec, col, _ = vision_mod.prepare_one(_Image.open(_io.BytesIO(image)))
            query = (vec, col)
        except Exception:
            log.warning("Kunde inte läsa frågebilden", exc_info=True)

    # --- Steg C: möbeltyp ---------------------------------------------------
    # Före skicket: variantspannet är större (2–5,5x) än skickspannet (1,4–2,6x),
    # och skickets tröskel ska räknas på den typrätta delmängden.
    # En BUNT ska inte typas efter sitt tillbehör. "Lamino + fotpall" gav
    # `derived_type=fotpall`, varpå variantfiltret smalnade till fotpallar och
    # svaret föll till 4 724 kr i stället för att stiga mot 10 000.
    #
    # Produkten är modellen, tillbehöret är tillägget. Saknas huvudtypen i
    # texten — och den gör den, den ligger i modellnamnet — är det bättre att
    # inte filtrera alls än att filtrera på fel typ.
    _bundle_accessory_only = False
    try:
        from type_system import grouping as _g

        _guess = _g.classify(attribute_text or name or "")
        _bundle_accessory_only = bool(
            _guess.is_bundle and _guess.bundle_from_connector)
    except Exception:  # noqa: BLE001
        pass

    target_variants, candidates, variant_source = _resolve_variants(
        base, variant, image, image_media_type, classifier, name, brand,
        query=query, vectors=vectors, listings=listings,
        attribute_text=attribute_text,
    )
    # Golvet måste mätas på det som faktiskt går in i medianen, alltså EFTER
    # färskhetsfiltret. Därför beräknas färskheten på båda alternativen och
    # valet görs på det filtrerade utfallet — två billiga anrop i stället för
    # ett fel beslut.
    filters = {"applied": [], "converted": []}
    if _bundle_accessory_only and target_variants:
        from type_system.grouping import _ACCESSORY_TYPES

        if all(t in _ACCESSORY_TYPES for t in target_variants):
            log.info("Bunt typad efter tillbehöret (%s) — släpper typfiltret",
                     target_variants)
            target_variants = None
            variant_source = "bundle_accessory_ignored"

    narrow, variant_method = _apply_variant(base, target_variants)
    narrow_fresh, recency_method, cutoff = _apply_recency(narrow)

    if (variant_method in ("filtered", "relaxed")
            and len(narrow_fresh) < config.MIN_COMPARISON_SET
            and target_variants):
        # Filtret skulle bryta golvet -> behåll allt, vikta ned fel typ.
        base, recency_method, cutoff = _apply_recency(base)
        type_column = ("derived_type"
                       if config.TYPE_SYSTEM_DRIVES_SEARCH
                       and "derived_type" in base.columns else "variant")
        wrong_type = ~base[type_column].isin(list(target_variants)
                                           + [variant_mod.UNKNOWN])
        weights = _weights_for(base, ~wrong_type)
        filters["converted"].append("variant")
        variant_method = "weighted"
    else:
        base = narrow_fresh
        weights = pd.Series(1.0, index=base.index)
        if variant_method in ("filtered", "relaxed"):
            filters["applied"].append("variant")

    # Cellfiltrets typmotsägelse när golvet stoppade bortkastningen: raderna
    # ligger kvar men väger FILTER_DOWNWEIGHT. Görs här, efter att `weights`
    # finns, så att den mjuka varianten hamnar i samma viktvektor som resten.
    if cell_soft is not None:
        overlap = base.index.intersection(cell_soft)
        if len(overlap):
            weights = weights * _weights_for(base, ~base.index.isin(overlap))
            filters["converted"].append("cellfilter_typ")

    # Obetingad referens = takpriset. Skicket får sänka men aldrig höja.
    ceiling = compute_price_range(base["price"].tolist())

    # --- Steg C2: storlek ---------------------------------------------------
    # Efter varianten, eftersom kompatibilitetsspärren behöver möbeltypen, och
    # före skicket av samma skäl som varianten ligger där.
    from . import size as size_mod

    variant_hint = (target_variants or [None])[0]
    wanted_size = size or size_mod.extract(normalize_text(name or ""), variant_hint)
    base, weights, filters, size_method = _apply_size(
        base, weights, wanted_size, filters
    )

    # --- Steg E: skick ------------------------------------------------------
    # Hela steget hoppas över när config.CONDITION_PRICING är False. Priset
    # blir då rent medianbaserat och helt oberoende av skick.
    enabled = config.CONDITION_PRICING
    target = condition_tier(condition) if (condition and enabled) else None
    matches, band, band_source = base, None, None
    method = "none" if enabled else "disabled"

    # Medianskicket bland träffarna: den nivå medianpriset faktiskt speglar,
    # och därmed den som ska få faktor 1,0.
    anchor = _median_tier(base) if target is not None else None

    if target is not None and "condition_tier" in base.columns:
        strict = base[base["condition_tier"] == target]
        if len(strict) >= config.CONDITION_STRICT_MIN:
            # Riktiga observationer av rätt möbel i rätt skick — men de är
            # selektionsbiased uppåt för toppskick, se taket i steg G.
            matches, method = strict, "filtered"
        elif basis == "realized" or multipliers is None:
            # Auktionsdatans skickkvoter är icke-monotona och därmed obrukbara,
            # så där släpps skicket helt istället för att skalas.
            matches, method = base, "ignored"
        elif anchor is not None and target == anchor:
            # Målet ÄR medianskicket — medianpriset speglar redan det, så
            # det finns inget att justera.
            matches, method = base, "reference"
        else:
            # Bandet väljs efter prisnivå, så vi behöver det obetingade priset
            # först. Beräknas här och återanvänds nedan.
            matches, method = base, "band"

    # --- Steg F: bildlikhet -------------------------------------------------
    # Sist av filtren: kandidaterna är redan rätt märke, modell, typ och skick,
    # och bilden rangordnar bara dem. Vektorn är redan beräknad ovan.
    weights = weights.reindex(matches.index).fillna(1.0)
    # Bilden filtrerar INTE längre jämförelsemängden — se
    # config.IMAGE_RERANK_ENABLED. Den bestämmer möbeltyp i steg C, inget mer.
    rerank = image_rerank and config.IMAGE_RERANK_ENABLED
    reranked, image_method, sim_range = _apply_image(
        matches, query if rerank else None, vectors
    )
    if rerank and image_method not in ("none", "too_few_vectors"):
        keep = matches.index.isin(reranked.index)
        matches, weights, filters = _floor_or_weight(
            matches, weights, keep, "bild", filters
        )
        if "bild" in filters["converted"]:
            image_method = "weighted"

    # --- Steg F2: ledord ----------------------------------------------------
    # Möbeltypen är grov. Ledorden ur grannarnas titlar särskiljer finare —
    # "divan", "schäslong", "sammet" — och kommer ur den egna datan, utan
    # modellanrop. Se visual_variant.cue_words.
    cue_words, cue_method, cue_used = [], "none", None
    if query is not None and vectors is not None and config.CUE_MAX_WORDS:
        # Ledorden extraheras och redovisas, men filtrerar bara när
        # CUE_FILTER_ENABLED är satt — se konfigkommentaren.
        from . import visual_variant as _vv

        cue_words = _vv.cue_words(query[0], vectors, listings)
        ranked, cue_method, cue_used = _apply_cues(matches, cue_words)
        if not config.CUE_FILTER_ENABLED:
            cue_method = "reported_only" if cue_words else "none"
        elif cue_method == "ranked":
            keep = matches.index.isin(ranked.index)
            matches, weights, filters = _floor_or_weight(
                matches, weights, keep, "ledord", filters
            )
            if "ledord" in filters["converted"]:
                cue_method = "weighted"

    # --- Steg F2b: visuell kohort -------------------------------------------
    # Aktiveras bara när orden inte bär värdet: anonym förfrågan, bild finns,
    # och ordkohortens prisspridning är stor. Se cohort.py.
    from . import cohort as cohort_mod

    cohort_info = None
    dispersion_warning = None
    if (anonymous and query is not None and vectors is not None
            and vectors.ready and len(matches)):
        word_dispersion = cohort_mod.dispersion(matches["price"].tolist())
        if word_dispersion >= config.COHORT_DISPERSION_TRIGGER:
            frame, cohort_weights, info = cohort_mod.find_cohort(
                query[0], vectors, listings, target_variants
            )
            if frame is not None and len(frame) >= config.COHORT_MIN:
                matches, weights = frame, cohort_weights
                basis = "visual_cohort"
                info["word_dispersion"] = round(word_dispersion, 1)
                cohort_info = info
            else:
                cohort_info = {**info, "word_dispersion": round(word_dispersion, 1)}

    # --- Steg F3: storleksvarning -------------------------------------------
    # Saknar förfrågan storleksuppgift men jämförelsemängden spretar över
    # storlekar är det inte ett fel att rapportera bort — det är information
    # användaren behöver. Intervallet breddas till att omfatta grupperna, och
    # deras prislägen följer med i svaret.
    size_warning = None
    if not wanted_size:
        groups = size_mod.spread(matches)
        if groups:
            medians = [g["median"] for g in groups.values()]
            if max(medians) / max(min(medians), 1) >= config.SIZE_WARN_RATIO:
                size_warning = groups

    # --- Steg G: intervallet -----------------------------------------------
    weights = weights.reindex(matches.index).fillna(1.0)
    effective_n = float(weights.sum())
    if (filters["converted"] or (cohort_info or {}).get("method") == "visual_cohort") \
            and len(matches):
        result = compute_weighted_range(matches["price"].to_numpy(float),
                                        weights.to_numpy(float))
    else:
        result = compute_price_range(matches["price"].tolist())

    # Prisfördelningen i jämförelsemängden, som rutnät. Redovisande fält —
    # påverkar inget pris. Finns för att `default` i dag är låst till samma
    # knopp som fönstrets bredd (HALF_INTERVAL_RATIO styr både startläget och
    # `high`), och den kopplingen går inte att pröva utan att kunna se var i
    # fördelningen andra percentiler ligger.
    percentile_grid = _percentile_grid(matches["price"].to_numpy(float),
                                       weights.to_numpy(float))

    # --- Steg G2: shrinkage mot bredare underlag ---------------------------
    # Görs FÖRE bandskalningen: skicket ska justera det svar motorn landat i,
    # inte det tunna svaret som sedan flyttas.
    result, shrinkage = _apply_shrinkage(
        result, listings, brand, target_variants, matches, price_kind
    )

    # --- Steg H: skala kanterna olika när skicket hanteras med band --------
    # p25 på låg kant och p75 på hög: osäkerheten i kvoten hamnar i bandbredden
    # istället för att döljas bakom en punktskattning.
    if method == "band" and result.match_count:
        band, band_source = multipliers.lookup(result.default, target, anchor)
        if band_source == "none":
            method, band = "ignored", None
        else:
            result.low = round(result.low * band.low)
            result.default = round(result.default * band.median)
            result.high = round(result.high * band.high)
            # Vidöppet band, eller ett band från för få undergrupper: i båda
            # fallen vet vi för lite för att kalla svaret säkert.
            if band.shaky:
                result.confidence = "low"

    if cohort_info and cohort_info.get("method") == "visual_cohort":
        # Spridningskontrollen behålls. Är även den visuella kohorten spretig
        # ska motorn säga att den är osäker, inte gissa snävt och fel.
        cohort_spread = cohort_mod.dispersion(matches["price"].tolist())
        if cohort_spread >= config.COHORT_DISPERSION_WARN:
            clusters = cohort_mod.price_clusters(matches["price"].tolist())
            dispersion_warning = {
                "dispersion": round(cohort_spread, 1),
                "clusters": clusters or None,
            }
            result.confidence = "low"
            # Bredda kanterna så att de omfattar klungorna. Specen är tydlig
            # om vilket fel som är billigare: "hellre osäkert 800-3 500 än
            # gissa fel snävt". Ett snävt intervall runt den tunga klungan
            # döljer att den andra finns.
            if clusters and result.low is not None:
                medians = [c["median"] for c in clusters]
                result.low = min(result.low, min(medians))
                result.high = max(result.high, max(medians))

    # --- Degraderingsskydd: gammal data får inte se färsk ut ---------------
    # `extended` betyder att färskhetsfönstret inte gick att uppfylla och att de
    # N senaste togs oavsett ålder. Är även DE gamla är svaret byggt på en
    # marknad som inte finns längre, och det ska stå i svaret.
    staleness = None
    if result.low is not None and "listed_at" in matches.columns:
        newest = matches["listed_at"].max()
        if pd.notna(newest):
            age_months = (pd.Timestamp.now(tz="UTC") - newest).days / 30.44
            staleness = {
                "newest": newest.date().isoformat(),
                "ageMonths": round(float(age_months), 1),
                "stale": bool(recency_method == "extended"
                              and age_months > config.STALE_AFTER_MONTHS),
            }
            if staleness["stale"]:
                result.confidence = "low"
                result.note += (
                    f" Underlaget är gammalt: färskaste jämförbara annonsen är"
                    f" från {staleness['newest']}"
                    f" ({age_months:.0f} månader). Prisläget kan ha ändrats"
                    f" sedan dess — marknaden har fallit mätbart under perioden."
                )

    if relaxed_terms and result.low is not None:
        # Uppmjukningen gav ett svar där det annars blivit tystnad, men på en
        # bredare fråga än den ställda. Det ska synas i konfidensen.
        result.confidence = "low"
        result.note += (
            " Sökningen breddades: orden "
            + ", ".join(f"'{t}'" for t in relaxed_terms)
            + " gav för få träffar och utelämnades."
        )

    if variant_source == "unresolved" and result.low is not None:
        # Varken bild eller text kunde bestämma möbeltypen, så sökningen är
        # bredast möjliga. Det ska synas.
        result.confidence = "low"
        result.note += (
            " Möbeltypen kunde inte avgöras vare sig ur bilden eller texten,"
            " så jämförelsen är gjord på hela träffmängden."
        )

    if size_warning:
        # Bredda kanterna så att de omfattar storleksgruppernas prislägen.
        # Ett snävt intervall vore en självsäkerhet motorn inte har: den vet
        # inte om användaren har en tvåsits eller en femsits.
        medians = [g["median"] for g in size_warning.values()]
        if result.low is not None:
            result.low = min(result.low, min(medians))
            result.high = max(result.high, max(medians))
            result.confidence = "low"

    # Taket från den tidigare designen — "medianen får aldrig höjas" — är
    # borttaget här. Det fanns för att vi inte visste vilket skick medianen
    # representerade, så en uppräkning var ren spekulation. Nu MÄTS ankaret
    # per sökning, och en uppräkning mot ett sämre medianskick är grundad.
    # Kvar som spärr finns BAND_MAX_FACTOR på själva skalan.

    # --- Steg H2: skadeavdrag ----------------------------------------------
    # Bakom DAMAGE_PRICING, av som default. LLM:en har SETT och klassificerat;
    # här värderas det. Basen räknas på de OFLAGGADE jämförelseannonserna för
    # att skadan inte ska straffas två gånger — se damage_pricing.select_base.
    damage_info = None
    if config.DAMAGE_PRICING and damages and result.default:
        from . import damage_pricing

        try:
            clean, basis_label, halve = damage_pricing.select_base(matches)
            clean_range = (compute_price_range(clean["price"].tolist())
                           if len(clean) else None)
            base_price = (clean_range.default if clean_range
                          and clean_range.default else result.default)

            # Möbeltypen för tabelluppslaget är vad jämförelsemängden FAKTISKT
            # är, inte unionens första element. Unionen är alfabetiskt sorterad,
            # så "soffa" hade blivit "baddsoffa" och tabellraden missats.
            kind = None
            for column in ("derived_type", "variant"):
                if column in matches.columns and len(matches):
                    modal = matches[column].mode()
                    if len(modal):
                        kind = modal.iloc[0]
                        break
            if kind is None:
                kind = (target_variants or [None])[0]
            # Steg 1: deterministisk matchning mot tabellens synonymer.
            # Prismotorn DETEKTERAR inte — den tar emot en färdig skadelista
            # från skadesystemet och tolkar den.
            items = damage_pricing.normalise(damages)
            unmatched = damage_pricing.needs_model(items)
            if unmatched:
                log.info("%d skadepost(er) matchade inte deterministiskt",
                         len(unmatched))
            # Deduplicering FÖRE värderingen. Skadesystemet rapporterar varje
            # enskild skada, och utan det här steget staplas 8-12 poster till
            # taket på varje normalsliten möbel.
            items, dedup = damage_pricing.deduplicate(items)
            damage_info = damage_pricing.resolve(items, kind, base_price)
            damage_info["matchedDeterministically"] = len(items) - len(
                damage_pricing.needs_model(items))
            damage_info["needsModel"] = len(damage_pricing.needs_model(items))
            damage_info["deduplication"] = dedup
            damage_info["basis"] = basis_label
            damage_info["basisN"] = int(len(clean))

            total = damage_info["totalDeduction"]
            ci_low = damage_info["totalCiLow"]
            ci_high = damage_info["totalCiHigh"]
            if halve:
                # Den blandade medianen bär redan en del av skadeeffekten.
                total, ci_low, ci_high = (round(x / 2.0, 4)
                                          for x in (total, ci_low, ci_high))
                damage_info["totalDeductionApplied"] = total
                damage_info["halved"] = True

            if total > 0:
                # HELA intervallet skalas, inte bara mitten — och från den
                # OSKADADE basen. Tidigare skalades `default` från den oskadade
                # medianen medan `low`/`high` skalades från den BLANDADE, så
                # basregeln gällde bara en av tre punkter och kanterna kunde
                # hamna fel i förhållande till mitten.
                span = clean_range if clean_range and clean_range.default else result
                # Osäkerheten i AVDRAGET blir bredd i priset: det minsta
                # avdraget ger den högsta kanten och tvärtom.
                result.default = round(base_price * (1.0 - total))
                if span.low:
                    result.low = round(span.low * (1.0 - ci_high))
                if span.high:
                    result.high = round(span.high * (1.0 - ci_low))
                spread = ("" if damage_info["missingCi"]
                          else f" ({ci_low*100:.0f}\u2013{ci_high*100:.0f} %)")
                result.note += (
                    f" Avdrag för deklarerad skada: {total*100:.0f} %{spread}"
                    f" ({len(damage_info['items'])} post(er))."
                )
                if damage_info["missingCi"]:
                    result.note += (
                        " Avdraget saknar konfidensintervall, så intervallets"
                        " bredd speglar inte osäkerheten i själva avdraget."
                    )
            # Konfidensen sjunker när avdraget vilar på en uppskattning eller
            # på en blandad bas — båda är svagare än en uppmätt tabellrad.
            if damage_info["estimatedCount"] or halve:
                result.confidence = "low"
            damage_pricing.log_unmapped(damage_info["items"], kind)
            damage_pricing.log_shadow(damage_info, dedup, kind)
        except Exception:  # noqa: BLE001 — ett dött API får aldrig fälla priset
            log.warning("Skadeavdraget misslyckades, prissätter utan det",
                        exc_info=True)
            damage_info = {"items": [], "totalDeduction": 0.0,
                           "error": "damage_pricing_failed"}

    # --- Förbehållen i klartext --------------------------------------------
    if result.match_count:
        result.note = f"{result.note} Baserat på {BASIS_LABELS.get(basis, basis)}."

        if recency_method == "window":
            result.note += (
                f" Endast annonser från senaste {config.RECENCY_MONTHS} månaderna."
            )
        elif recency_method == "extended":
            result.note += (
                f" För få annonser inom {config.RECENCY_MONTHS} månader, så de"
                f" {config.RECENCY_MIN_LISTINGS} senaste används oavsett ålder."
            )

        if cohort_info and cohort_info.get("method") == "visual_cohort":
            result.note += (
                f" Orden identifierade ingen produkt och prisspridningen bland"
                f" dem var {cohort_info['word_dispersion']:.0f}x, så priset"
                f" bygger på {cohort_info['cohort_size']} annonser som LIKNAR"
                f" din bild (likhet"
                f" {cohort_info['similarity_range'][0]:.2f}–"
                f"{cohort_info['similarity_range'][1]:.2f})."
            )

        if shrinkage:
            result.note += (
                f" Bara {shrinkage['narrowCount']} annonser av just den"
                f" modellen, så priset är sammanvägt med"
                f" {shrinkage['broadCount']} liknande annonser av samma märke"
                f" och möbeltyp (vikt {shrinkage['weight']:.2f} på modellen)."
            )
            result.confidence = "low"

        if image_method == "filtered":
            result.note += " Endast annonser som liknar din bild."
        elif image_method == "loosened":
            result.note += (
                " Få annonser liknade din bild, så bildfiltret fick lättas."
            )

        # Visningsform, inte den kanoniska: "Endast soffa eller baddsoffa" ser
        # ut som en bugg för den som läser prissvaret.
        from type_system.taxonomy import display as _display

        typ = _join_sv([_display(t) or t for t in (target_variants or [])])
        if variant_method == "filtered":
            result.note += f" Endast {typ}."
        elif variant_method == "relaxed":
            result.note += (
                f" För få annonser märkta {typ}, så annonser utan angiven"
                f" möbeltyp räknas med."
            )
        elif variant_method == "ignored":
            result.note += (
                f" Möbeltypen {typ} gav för tunt underlag och ingår inte"
                f" i beräkningen."
            )

        if method == "filtered":
            result.note += f" Endast annonser i {target}."
        elif method == "reference":
            result.note += (
                f" {target} är medianskicket bland träffarna, så medianpriset"
                f" speglar redan det och används oförändrat."
            )
        elif method == "band" and band is not None:
            result.note += (
                f" För få annonser i {target}, så priset bygger på alla skick"
                f" och är skalat med {band.low:.2f}–{band.median:.2f}–{band.high:.2f}x"
                f" från medianskicket {anchor}."
            )
            if band.wide:
                result.note += (
                    " Kvoten spretar kraftigt mellan möbler, så intervallet är"
                    " brett av osäkerhet snarare än av marknadsspridning."
                )
            elif band.thin:
                result.note += (
                    f" Kvoten vilar på bara {band.groups} möbelgrupper och är"
                    f" därför osäker."
                )
        elif method == "ignored":
            why = (
                "auktionsdata saknar tillförlitlig skicksignal"
                if basis == "realized"
                else "underlaget räcker inte"
            )
            result.note += f" Skick ingår inte i beräkningen ({why})."
        elif method == "disabled" and condition:
            result.note += (
                " Skickjusteringen är avstängd, så priset är oberoende av"
                " angivet skick."
            )

    payload = {
        "query": {
            "name": name,
            "brand": brand,
            "condition": condition,
            "variant": target_variants,
        },
        "priceBasis": basis,
        "cellLevel": cell_level,
        "cellKey": cell_key,
        "cellFilterDropped": cell_dropped or None,
        "formFromImage": form_info,
        "damage": damage_info,
        "ignoredTerms": ignored_terms or None,
        "relaxedTerms": relaxed_terms or None,
        "identityAnonymous": anonymous,
        "variantMethod": variant_method,
        "variantSource": variant_source,
        "filtersApplied": filters["applied"] or None,
        "filtersConverted": filters["converted"] or None,
        "effectiveN": round(effective_n, 1),
        "cohort": cohort_info,
        "dispersionWarning": dispersion_warning,
        "sizeMethod": size_method,
        "sizeQuery": wanted_size,
        "sizeWarning": size_warning,
        "percentileGrid": percentile_grid,
        "cueMethod": cue_method,
        "cueWords": cue_used,
        "variantCandidates": [label for label, _ in candidates] or None,
        "imageFiltered": image_method,
        "imageMatchCount": int(len(matches)) if image_method != "none" else None,
        "similarityRange": (
            [round(sim_range[0], 3), round(sim_range[1], 3)] if sim_range else None
        ),
        "recencyMethod": recency_method,
        "recencyCutoff": cutoff.date().isoformat() if cutoff is not None else None,
        "dataStaleness": staleness,
        "fallbackMethod": (shrinkage or {}).get("method", "none"),
        "fallback": shrinkage,
        "conditionMethod": method,
        "conditionAnchor": anchor,
        "conditionBand": (
            {**band.as_dict(), "source": band_source} if band is not None else None
        ),
        **_type_system_fields(attribute_text or name, brand, condition, query,
                              vectors, listings, matches, variant),
        **result.to_dict(),
    }
    # Behåll nyckelordningen från specen, med de nya fälten inskjutna.
    order = ["query", "priceBasis", "cellLevel", "cellKey", "cellFilterDropped", "formFromImage", "damage",
             "ignoredTerms", "relaxedTerms", "identityAnonymous",
             "variantMethod", "variantSource",
             "variantCandidates", "filtersApplied", "filtersConverted",
             "effectiveN", "cohort", "dispersionWarning",
             "sizeMethod", "sizeQuery", "sizeWarning",
             "cueMethod", "cueWords", "percentileGrid",
             "fallbackMethod", "fallback",
             "conditionMethod", "conditionAnchor", "conditionBand",
             "imageFiltered", "imageMatchCount", "similarityRange",
             "recencyMethod", "recencyCutoff", "dataStaleness",
             "attributes", "derivedType", "possibleTypes", "typeConfidence",
             "clarifyingQuestions", "typeUncertainty", "typeUncertaintyAction",
             "matchCount", "halfInterval", "default", "low", "high",
             "confidence", "note"]
    return {key: payload[key] for key in order}


def _type_system_fields(name, brand, condition, query, vectors, listings,
                        matches, variant) -> dict:
    """Attributsystemets svarsfält — redovisande, inte styrande.

    Fälten läggs på svaret utan att påverka priset. Skälet är regeln "ett lager i
    taget, mätning mellan varje": att koppla in kedjan i själva prissättningen är
    en beteendeändring som förtjänar en egen mätning, medan att exponera vad
    kedjan ser är rent additivt och kan granskas direkt i API-svaret.

    Allt fångas. Ett fel i attributsystemet får aldrig fälla ett prissvar.
    """
    empty = {"attributes": None, "derivedType": None, "possibleTypes": None,
             "typeConfidence": None, "clarifyingQuestions": None,
             "typeUncertainty": None, "typeUncertaintyAction": None}
    try:
        from type_system import chain, decide

        candidates = None
        if matches is not None and len(matches) and "search_blob" in matches:
            candidates = decide.annotate(matches[["search_blob", "price"]])
        resolution = chain.resolve(
            name=name or "", brand=brand,
            description=condition or "",
            user_answers={"variant": None},
            queries=[query[0]] if query is not None else None,
            store=vectors, listings=listings, candidates=candidates,
            use_vision=False,
        )
        payload = resolution.as_dict()
        return {
            "attributes": payload["attributes"] or None,
            "derivedType": payload["derivedType"],
            "possibleTypes": payload["possibleTypes"] or None,
            "typeConfidence": payload["typeConfidence"],
            "clarifyingQuestions": payload["clarifyingQuestions"] or None,
            "typeUncertainty": payload["uncertainty"],
            "typeUncertaintyAction": payload["uncertaintyAction"],
        }
    except Exception as exc:  # noqa: BLE001 - redovisande fält får aldrig fälla svaret
        log.warning("Attributsystemet misslyckades, fälten utelämnas: %s", exc)
        return empty
