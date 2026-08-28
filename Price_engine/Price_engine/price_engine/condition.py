"""Skickband — hur mycket skicket flyttar priset, uttryckt som percentiler.

Används när ett strikt skickfilter ger för tunt underlag. Då beräknas priset
på alla skick och skalas istället med en kvot för det efterfrågade skicket.

Tre saker skiljer den här implementationen från en naiv skickmultiplikator,
och alla tre kommer ur mätningar på datan.

**1. Kvoterna räknas parvis inom undergrupp, aldrig som global median per
skicknivå.** Den naiva varianten mäter inte skick utan vilka möbler som råkar
ligga i respektive nivå:

    Global median (fel):      Nyskick 850 kr  <  Mycket bra skick 1 000 kr
    Parvis inom grupp (rätt): Nyskick 1,43x   >  Mycket bra skick 1,39x

**2. Grupperingen sker på PRISNIVÅ, inte kategori.** Kvoten beror systematiskt
på hur dyr möbeln är — dyra möbler tappar nästan dubbelt så mycket
proportionellt på slitage:

    Okej skick:  0,79 vid 500 kr  ->  0,60 vid 833 kr  ->  0,44 vid 1 800 kr

Kategorigruppering testades och var *sämre än en global konstant* i
leave-one-out (Okej −7 %, Mycket bra −20 %): 59 undergrupper fördelade på sju
kategorier ger för tunt underlag per kategori, och kvoten börjar följa bruset.

**3. Resultatet är ett band, inte en punkt.** Spridningen mellan möbler är äkta
variation, inte samplingsbrus — den krymper inte när cellerna växer 16x
(IQR/median 0,45 -> 0,42), och split-half-korrelationen är 0,65–0,73. En
punktskattning låtsas att kvoten är känd exakt. Istället skalas intervallets
kanter var för sig:

    low     = obetingad_low     x p40
    default = obetingad_default x median
    high    = obetingad_high    x p60

Kanterna skalas med p40/p60 — mittersta 20 % av kvotfördelningen, samma andel
som huvudalgoritmens fönster. Viddmätningen använder däremot p25/p75, alltså
den sanna spridningen: med p40/p60 hamnar alla spridningar på 1,01–1,48 och
osäkerhetsflaggan hade aldrig löst ut.

Det löser samtidigt Nyskick, vars kvot är för osäker för en punktskattning
(p25–p75 = 0,94–2,00): spridningen fångas av osäkerhetsflaggan istället för
att ge ett självsäkert fel svar.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

import pandas as pd

from . import config

log = logging.getLogger(__name__)


@dataclass
class Band:
    """Kvoterna mot referensskicket.

    Två uppsättningar tal med två olika jobb:

      low / median / high   skalar prisintervallets kanter (BAND_LOW_Q/HIGH_Q,
                            default p40/p60 — marknadens mitt)
      p25 / p75             mäter den sanna spridningen, används bara för att
                            avgöra om svaret ska märkas osäkert
    """

    low: float
    median: float
    high: float
    p25: float
    p75: float
    groups: int  # antal undergrupper kvoten vilar på

    @property
    def spread(self) -> float:
        """p75/p25. Hur mycket underlaget spretar."""
        return self.p75 / self.p25 if self.p25 else math.inf

    @property
    def wide(self) -> bool:
        """Så vid spridning att svaret bör märkas som osäkert."""
        return self.spread > config.BAND_WIDE_RATIO

    @property
    def thin(self) -> bool:
        """Byggt på så få undergrupper att percentilerna själva är osäkra."""
        return 0 < self.groups < config.BAND_SOLID_GROUPS

    @property
    def shaky(self) -> bool:
        """Bandet bör inte redovisas som ett säkert svar."""
        return self.wide or self.thin

    def as_dict(self) -> dict:
        return {
            # Faktorerna som faktiskt skalar priset.
            "low": round(self.low, 3),
            "median": round(self.median, 3),
            "high": round(self.high, 3),
            # Den sanna spridningen, för den som vill bedöma tillförlitligheten.
            "p25": round(self.p25, 3),
            "p75": round(self.p75, 3),
            "groups": self.groups,
        }


#: Referensskicket självt — ingen justering.
IDENTITY = Band(low=1.0, median=1.0, high=1.0, p25=1.0, p75=1.0, groups=0)


@dataclass
class ConditionBands:
    """Skickband per prisnivå, med globala band som fallback."""

    per_level: dict = field(default_factory=dict)  # (nivå, skick) -> Band
    overall: dict = field(default_factory=dict)  # skick -> Band
    edges: tuple = ()  # prisgränser mellan nivåerna
    reference: str = config.CONDITION_REFERENCE

    def level_for(self, price: float | None) -> str | None:
        """Vilken prisnivå ett referenspris hamnar i."""
        if price is None or not self.edges:
            return None
        for name, upper in zip(config.PRICE_LEVELS, self.edges):
            if price <= upper:
                return name
        return config.PRICE_LEVELS[-1]

    def _raw(self, price: float | None, condition: str) -> tuple:
        """Bandet för ett skick mot skalans INTERNA ankare."""
        if condition == self.reference:
            return IDENTITY, "reference"
        level = self.level_for(price)
        if level and (level, condition) in self.per_level:
            return self.per_level[(level, condition)], "level"
        if condition in self.overall:
            return self.overall[condition], "overall"
        return None, "none"

    def lookup(self, price: float | None, condition: str, anchor: str | None = None) -> tuple:
        """Ger (Band, källa) för ett skick, omankrat mot `anchor`.

        `anchor` är medianskicket bland träffarna — den nivå som ska få faktor
        1,0, eftersom medianpriset per konstruktion speglar just det skicket.
        Faktorn blir därför en kvot mellan två punkter på samma skala:

            faktor(mål) = skala[mål] / skala[ankare]

        Ett mål som är bättre än ankaret får en faktor över 1, ett sämre under.
        Utan `anchor` används skalans interna referens (Bra skick).
        """
        band, source = self._raw(price, condition)
        if band is None or not anchor or anchor == self.reference:
            return band, source

        base, base_source = self._raw(price, anchor)
        if base is None or base.median <= 0:
            # Ankarnivån saknar band — då går skalan inte att flytta.
            return None, "none"

        cap = config.BAND_MAX_FACTOR
        return (
            Band(
                low=min(band.low / base.median, cap),
                median=min(band.median / base.median, cap),
                high=min(band.high / base.median, cap),
                p25=band.p25,
                p75=band.p75,
                groups=min(band.groups, base.groups),
            ),
            f"{source}/{base_source}",
        )

    def as_table(self) -> pd.DataFrame:
        """Banden som tabell — för inspektion via CLI."""
        rows = [
            {"nivå": "(alla)", "skick": cond, "low": round(b.low, 2),
             "median": round(b.median, 2), "high": round(b.high, 2),
             "p25": round(b.p25, 2), "p75": round(b.p75, 2), "grupper": b.groups}
            for cond, b in sorted(self.overall.items())
        ]
        rows += [
            {"nivå": level, "skick": cond, "low": round(b.low, 2),
             "median": round(b.median, 2), "high": round(b.high, 2),
             "p25": round(b.p25, 2), "p75": round(b.p75, 2), "grupper": b.groups}
            for (level, cond), b in sorted(self.per_level.items())
        ]
        return pd.DataFrame(rows)


def _pairwise_ratios(frame: pd.DataFrame, keys: list[str]) -> pd.DataFrame:
    """Kvot mot referensskicket inom varje grupp som `keys` definierar."""
    grouped = (
        frame.groupby(keys + ["condition_tier"], observed=True)["price"]
        .agg(median_price="median", rows="size")
        .reset_index()
    )
    # För få rader i en cell -> medianen är inte meningsfull.
    grouped = grouped[grouped["rows"] >= config.MULTIPLIER_MIN_ROWS]

    reference = grouped[grouped["condition_tier"] == config.CONDITION_REFERENCE]
    reference = reference[keys + ["median_price"]].rename(
        columns={"median_price": "reference_price"}
    )

    # Inner join: bara grupper som HAR ett referensskick kan bidra med en kvot.
    merged = grouped.merge(reference, on=keys, how="inner")
    merged = merged[merged["reference_price"] > 0]
    merged["ratio"] = merged["median_price"] / merged["reference_price"]
    return merged[merged["condition_tier"] != config.CONDITION_REFERENCE]


def _band(ratios: pd.Series) -> Band:
    """Percentiler av kvoterna, kapade vid BAND_MAX_FACTOR som sanitetsspärr."""
    cap = config.BAND_MAX_FACTOR
    return Band(
        low=min(float(ratios.quantile(config.BAND_LOW_Q)), cap),
        median=min(float(ratios.median()), cap),
        high=min(float(ratios.quantile(config.BAND_HIGH_Q)), cap),
        p25=float(ratios.quantile(0.25)),
        p75=float(ratios.quantile(0.75)),
        groups=len(ratios),
    )


def build_bands(
    listings: pd.DataFrame, price_kind: str | None = config.MULTIPLIER_PRICE_KIND
) -> ConditionBands:
    """Räknar ut skickband ur datan. Bara utropspriser, se MULTIPLIER_PRICE_KIND.

    Auktionsdatans skickkvoter är icke-monotona (Mycket bra 0,68 < Okej 0,91)
    eftersom nivåerna Nyskick/Mycket bra bara har ~2 000 rader vardera av
    339 065, och klubbpriset drivs av objektets åtråvärdhet snarare än av en
    fyrgradig skala. Därför byggs banden aldrig på realiserade priser.
    """
    bands = ConditionBands()

    needed = {"condition_tier", "subgroup", "price"}
    if not needed.issubset(listings.columns):
        log.warning("Saknar kolumner för skickband: %s", needed - set(listings.columns))
        return bands

    frame = listings
    if price_kind and "price_kind" in frame.columns:
        frame = frame[frame["price_kind"] == price_kind]
    frame = frame[frame["condition_tier"].notna() & frame["subgroup"].notna()]
    if frame.empty:
        log.warning("Inget underlag för skickband")
        return bands

    ratios = _pairwise_ratios(frame, ["subgroup"])
    if ratios.empty:
        return bands

    # --- Globala band -------------------------------------------------------
    for condition, rows in ratios.groupby("condition_tier", observed=True):
        if len(rows) >= config.MULTIPLIER_MIN_GROUPS:
            bands.overall[condition] = _band(rows["ratio"])

    # --- Band per prisnivå --------------------------------------------------
    # Nivåerna sätts som kvantiler av referenspriset, inte som fasta gränser,
    # så att indelningen följer datan istället för en gissning.
    levels = len(config.PRICE_LEVELS)
    if ratios["reference_price"].nunique() >= levels:
        binned, edges = pd.qcut(
            ratios["reference_price"], levels,
            labels=list(config.PRICE_LEVELS), retbins=True, duplicates="drop",
        )
        ratios = ratios.assign(level=binned)
        # Övre kanten på varje nivå utom den sista (som är obegränsad uppåt).
        bands.edges = tuple(float(e) for e in edges[1:-1])

        for (level, condition), rows in ratios.groupby(
            ["level", "condition_tier"], observed=True
        ):
            if len(rows) >= config.MULTIPLIER_MIN_GROUPS:
                bands.per_level[(str(level), condition)] = _band(rows["ratio"])

    log.info(
        "Skickband: %d globala, %d per prisnivå (gränser %s)",
        len(bands.overall), len(bands.per_level),
        [round(e) for e in bands.edges],
    )
    return bands
