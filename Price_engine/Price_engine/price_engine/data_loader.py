"""Inläsning och städning av annonsdata.

Slår ihop alla datafiler i DATA_DIR till en tabell med ett känt schema:

    name | brand | price | condition | date | price_kind | source
    name_norm | brand_norm | condition_norm | search_blob

Körs en gång vid uppstart; resultatet hålls i minnet. Den städade tabellen
cachas på disk eftersom normaliseringen av 1,5M rader annars tar ~45 s.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path

import pandas as pd

from . import config

log = logging.getLogger(__name__)

# Plockar ut talet ur strängar som "1 299 kr", "1.299:-", "SEK 1,299.00".
# Matchningen börjar på en siffra och sväljer efterföljande siffror,
# mellanslag (även hårda:  ,  ) och separatorer — men stannar
# vid ":-", "kr" och annan text.
_NUMBER = re.compile("-?\\d[\\d\\u00a0\\u202f .,]*")
_SPACES = re.compile("[\\s\\u00a0\\u202f]")

# Höj när städlogiken ändras, så att gamla cachefiler förkastas.
CACHE_VERSION = 21  # 21: buntkonnektor pa fragor + u-soffa i vocab


# --------------------------------------------------------------------------
# Normalisering
# --------------------------------------------------------------------------
def _normalize_series(series: pd.Series) -> pd.Series:
    """Gemener, utan diakriter (å/ä/ö -> a/a/o), med kollapsade mellanslag.

    Vektoriserad via pandas str-accessor istället för en Python-loop per rad;
    skillnaden är ungefär 40 s -> 3 s på 1,5M rader.
    """
    return (
        series.fillna("")
        .astype(str)
        .str.normalize("NFKD")  # å -> a + kombinerande ring
        .str.encode("ascii", "ignore")  # släng de kombinerande tecknen
        .str.decode("ascii")
        .str.lower()
        .str.replace(r"\s+", " ", regex=True)
        .str.strip()
    )


def normalize_text(value: object) -> str:
    """Skalär motsvarighet till _normalize_series. Används för API-input."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    return _normalize_series(pd.Series([value], dtype="object")).iloc[0]


def normalize_condition(value: object) -> str | None:
    """Mappar fritext-skick till en av de fyra kanoniska nivåerna.

    Returnerar None när skicket inte går att tolka, vilket betyder
    "filtrera inte på skick".
    """
    text = normalize_text(value)
    if not text:
        return None
    if text in config.CONDITION_SYNONYMS:
        return config.CONDITION_SYNONYMS[text]
    # Delsträngsträff som fallback: "soffan är i gott skick" -> Bra skick.
    # Längsta nyckeln först så att "mycket bra skick" vinner över "bra skick".
    for key in sorted(config.CONDITION_SYNONYMS, key=len, reverse=True):
        if key in text:
            return config.CONDITION_SYNONYMS[key]
    return None


def condition_tier(value: object) -> str | None:
    """Skicknivå -> prissättningsnivå. Nyskick och Mycket bra slås ihop.

    De två har nästan identisk priskvot (1,43 mot 1,39) men Nyskick spretar
    2,5x mer, så sammanslagningen vinner stabilitet utan att kosta precision.
    """
    canonical = normalize_condition(value)
    return config.CONDITION_TIERS.get(canonical) if canonical else None


def clean_price(value: object) -> float | None:
    """Gör pris till ett rent tal. Hanterar "1 299 kr", "1.299:-", 1299.0."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        match = _NUMBER.search(str(value))
        if not match:
            return None
        text = _SPACES.sub("", match.group(0)).rstrip(".,")
        if not text or text == "-":
            return None

        if "," in text and "." in text:
            # Den sist förekommande separatorn är decimaltecknet.
            # "1.299,50" -> 1299.50 ; "1,299.50" -> 1299.50
            text = (
                text.replace(".", "").replace(",", ".")
                if text.rfind(",") > text.rfind(".")
                else text.replace(",", "")
            )
        elif "," in text:
            # Ett komma: decimaltecken om högst 2 siffror följer, annars tusental.
            tail = text.split(",")[-1]
            text = text.replace(
                ",", "." if text.count(",") == 1 and len(tail) <= 2 else ""
            )
        elif "." in text:
            # Punkt med exakt 3 avslutande siffror är svensk tusenavgränsare:
            # "1.299" -> 1299, men "1299.50" -> 1299.5 och "1.5" -> 1.5.
            if len(text.split(".")[-1]) == 3:
                text = text.replace(".", "")

        try:
            number = float(text)
        except ValueError:
            return None
    return number if number == number else None  # filtrera NaN


# --------------------------------------------------------------------------
# Filinläsning
# --------------------------------------------------------------------------
def _allowed(available) -> list:
    """Skärningen mellan filens kolumner och vitlistan, minus det förbjudna.

    RESTRIKTIV inläsning. Tidigare lästes varje kolumn i filen och det okända
    kastades efteråt — vilket betydde att `description`, `condition_text`,
    `lat` och `lon` lästes in i minnet vid varje uppstart trots att motorn
    aldrig använde dem. Se config.ingest_columns.
    """
    allowed = config.ingest_columns()
    keep = [c for c in available
            if c in allowed and c not in config.FORBIDDEN_COLUMNS]
    skipped = [c for c in available if c not in keep]
    if skipped:
        log.info("Hoppar över %d kolumn(er) utanför vitlistan: %s",
                 len(skipped), ", ".join(sorted(skipped)[:8]))
    return keep


def _read_file(path: Path, columns: list[str] | None = None) -> pd.DataFrame:
    """Läser en fil oavsett format. Bara vitlistade kolumner läses."""
    suffix = path.suffix.lower()
    if suffix == ".parquet":
        import pyarrow.parquet as pq

        available = pq.ParquetFile(path).schema_arrow.names
        return pd.read_parquet(path, columns=columns or _allowed(available))
    if suffix in (".csv", ".tsv"):
        frame = pd.read_csv(path, sep="\t" if suffix == ".tsv" else ",",
                            low_memory=False)
        return frame[_allowed(frame.columns)]
    if suffix in (".xlsx", ".xls"):
        frame = pd.read_excel(path)
        return frame[_allowed(frame.columns)]
    if suffix in (".ndjson", ".jsonl"):
        frame = pd.read_json(path, lines=True)
        return frame[_allowed(frame.columns)]
    raise ValueError(f"Okänt format: {path}")


def _file_columns(path: Path) -> list[str]:
    """Kolumnnamnen i en fil, utan att läsa in hela innehållet."""
    suffix = path.suffix.lower()
    if suffix == ".parquet":
        import pyarrow.parquet as pq

        return list(pq.ParquetFile(path).schema.names)
    if suffix in (".csv", ".tsv"):
        return list(pd.read_csv(path, sep="\t" if suffix == ".tsv" else ",", nrows=0).columns)
    if suffix in (".ndjson", ".jsonl"):
        return list(pd.read_json(path, lines=True, nrows=1).columns)
    return list(pd.read_excel(path, nrows=0).columns)


def discover_files(data_dir: Path) -> list[Path]:
    """Hittar datafiler. Föredrar master.parquet framför lösa källfiler."""
    if not data_dir.is_dir():
        raise FileNotFoundError(
            f"Datamappen finns inte: {data_dir}\n"
            f"Peka ut rätt mapp med PRICE_ENGINE_DATA=/sokvag/till/data"
        )
    # master.parquet är huvudtabellen, men den är INTE ensam längre. Tidigare
    # returnerade den här grenen bara master.parquet, vilket gjorde att en ny
    # datafil som lades i katalogen ignorerades TYST — inget felmeddelande, inga
    # nya rader, bara samma svar som förut.
    #
    # Nu läses huvudtabellen plus allt i `extra/`. Att lägga ny skrapad data i
    # produktion är därmed att kopiera en fil dit; cachenyckeln innehåller
    # filernas mtid och storlek, så nästa uppstart bygger om av sig själv utan
    # att CACHE_VERSION behöver röras. Se README.
    for preferred in config.PREFERRED_FILES:
        candidate = data_dir / preferred
        if candidate.is_file():
            extra = sorted(
                p for p in (data_dir / config.EXTRA_DATA_DIR).glob("*")
                if p.is_file() and p.suffix.lower() in config.SUPPORTED_SUFFIXES
            ) if (data_dir / config.EXTRA_DATA_DIR).is_dir() else []
            if extra:
                log.info("Extra datafiler: %s", ", ".join(p.name for p in extra))
            return [candidate, *extra]
    files = sorted(
        p
        for p in data_dir.rglob("*")
        if p.is_file() and p.suffix.lower() in config.SUPPORTED_SUFFIXES
    )
    if not files:
        raise FileNotFoundError(f"Inga datafiler i {data_dir}")
    return files


def resolve_columns(available: list[str]) -> dict[str, str]:
    """Mappar kanoniska fältnamn -> faktiska kolumnnamn i filen."""
    lookup = {c.lower(): c for c in available}
    resolved: dict[str, str] = {}
    for canonical, candidates in config.COLUMN_CANDIDATES.items():
        for candidate in candidates:
            if candidate.lower() in lookup:
                resolved[canonical] = lookup[candidate.lower()]
                break
    return resolved


# --------------------------------------------------------------------------
# Cache
# --------------------------------------------------------------------------
def _cache_path(files: list[Path]) -> Path:
    """Cachenyckel = filsökväg + mtid + storlek + version av städlogiken."""
    signature = json.dumps(
        [[str(p), int(p.stat().st_mtime), p.stat().st_size] for p in files]
        + [CACHE_VERSION],
        sort_keys=True,
    )
    digest = hashlib.sha256(signature.encode()).hexdigest()[:16]
    cache_dir = Path(__file__).resolve().parent.parent / ".cache"
    cache_dir.mkdir(exist_ok=True)
    return cache_dir / f"listings-{digest}.parquet"


# --------------------------------------------------------------------------
# Huvudingång
# --------------------------------------------------------------------------
def load_listings(data_dir: Path | None = None, use_cache: bool = True) -> pd.DataFrame:
    """Läser in, städar och slår ihop alla annonser till en tabell."""
    data_dir = Path(data_dir) if data_dir else config.DATA_DIR
    files = discover_files(data_dir)

    cache = _cache_path(files) if use_cache else None
    if cache and cache.is_file():
        log.info("Läser städad data från cache: %s", cache.name)
        return pd.read_parquet(cache)

    log.info("Läser %d fil(er) från %s", len(files), data_dir)
    frames: list[pd.DataFrame] = []
    for path in files:
        available = _file_columns(path)
        mapping = resolve_columns(available)

        if "price" not in mapping or "name" not in mapping:
            log.warning("Hoppar över %s (saknar pris- eller namnkolumn)", path.name)
            continue

        # Läs bara de kolumner vi behöver — sparar minne på breda parquet-filer.
        keep = list(
            dict.fromkeys(
                list(mapping.values())
                + [c for c in config.EXTRA_TEXT_COLUMNS if c in available]
                + (["title_raw"] if "title_raw" in available else [])
                # Skadeflaggorna är härledda ur `condition_text`, som raderats.
                # Utan dem här läses de aldrig, hur väl vitlistan än släpper
                # igenom dem — den här listan är den smalare grinden.
                + [c for c in config.DAMAGE_COLUMNS if c in available]
            )
        )
        frame = _read_file(
            path, columns=keep if path.suffix.lower() == ".parquet" else None
        )
        frames.append(_standardize(frame, mapping, path.name))

    if not frames:
        raise ValueError(f"Ingen fil i {data_dir} hade både namn- och priskolumn")

    listings = _clean(pd.concat(frames, ignore_index=True))

    if cache:
        listings.to_parquet(cache, index=False)
        log.info("Cachade städad data: %s", cache.name)
    return listings


def _standardize(frame: pd.DataFrame, mapping: dict[str, str], origin: str) -> pd.DataFrame:
    """Byter namn på kolumnerna till det kanoniska schemat."""
    out = pd.DataFrame(index=frame.index)
    for canonical in ("name", "brand", "price", "condition", "date", "listed_at",
                      "price_kind", "dedup_key", "source", "category", "subgroup",
                      "image_url"):
        column = mapping.get(canonical)
        out[canonical] = frame[column] if column else None

    # Fritextfält: allt som kan innehålla varumärke eller modellnamn.
    # title_raw tas med utöver title_norm eftersom de skiljer sig åt.
    # OBS: canonical_text används INTE — den är trunkerad i datan och
    # innehåller ofta bara skicktexten, vilket förstör namnmatchningen.
    parts = [out["name"].fillna("").astype(str), out["brand"].fillna("").astype(str)]
    if mapping.get("name") != "title_raw" and "title_raw" in frame:
        parts.append(frame["title_raw"].fillna("").astype(str))
    parts += [
        frame[c].fillna("").astype(str) for c in config.EXTRA_TEXT_COLUMNS if c in frame
    ]
    # Vektoriserad konkatenering, inte en Python-loop över raderna.
    blob = parts[0]
    for part in parts[1:]:
        blob = blob.str.cat(part, sep=" ")
    # Skadeflaggorna följer med rakt igenom. De är HÄRLEDDA ur `condition_text`
    # som raderades i upphovsrättssaneringen — se type_system/damage.py. Utan
    # den här genomkopplingen finns de i filen men aldrig i motorn, och
    # extraktionen hade varit meningslös.
    for column in config.DAMAGE_COLUMNS:
        if column in frame:
            out[column] = frame[column]

    out["_blob"] = blob
    out["origin_file"] = origin
    return out


def _clean(listings: pd.DataFrame) -> pd.DataFrame:
    """Städning: numeriskt pris, bort med skräprader, dedup, normaliserad text."""
    before = len(listings)

    # 1. Pris -> rent tal. Redan numeriska kolumner behöver ingen parsning.
    if not pd.api.types.is_numeric_dtype(listings["price"]):
        listings["price"] = listings["price"].map(clean_price)
    listings["price"] = pd.to_numeric(listings["price"], errors="coerce")

    # Släng rader utan pris eller med orimligt pris (specen: pris <= 0 bort).
    listings = listings[listings["price"].notna()]
    listings = listings[
        (listings["price"] >= config.MIN_PRICE) & (listings["price"] <= config.MAX_PRICE)
    ]

    # 2. Trimma text och bygg normaliserade sökkolumner.
    listings["name"] = listings["name"].fillna("").astype(str).str.strip()
    listings["brand"] = listings["brand"].fillna("").astype(str).str.strip()
    listings["name_norm"] = _normalize_series(listings["name"])
    listings["brand_norm"] = _normalize_series(listings["brand"])
    listings["search_blob"] = _normalize_series(listings["_blob"])
    listings = listings.drop(columns=["_blob"])

    # 3. Skick -> kanonisk nivå. Kolumnen har få unika värden, så vi mappar
    #    över de unika istället för rad för rad.
    condition_map = {
        value: normalize_condition(value)
        for value in listings["condition"].dropna().unique()
    }
    listings["condition_norm"] = listings["condition"].map(condition_map)

    #    Prissättningen använder tre nivåer, inte fyra: Nyskick och Mycket bra
    #    skick slås ihop till Toppskick. condition_norm behålls oförändrad så
    #    att rådatan inte går förlorad.
    listings["condition_tier"] = listings["condition_norm"].map(config.CONDITION_TIERS)

    # 4. Dedupa. dedup_key finns i datan; annars namn + pris + skick.
    keys = (
        ["dedup_key"]
        if listings["dedup_key"].notna().any()
        else ["name_norm", "price", "condition_norm"]
    )
    listings = listings.drop_duplicates(subset=keys, keep="first")

    # 5. Rader utan användbar text kan aldrig matchas -> bort.
    listings = listings[listings["search_blob"].str.len() > 0]

    # 6. En enda tidsstämpel. listed_at_ms (epoch-ms) finns på alla
    #    utropspriser men inga auktioner; sold_at (text) tvärtom. Utan
    #    sammanslagning skulle färskhetsfiltret radera hela ena halvan.
    listed = pd.to_datetime(
        pd.to_numeric(listings["listed_at"], errors="coerce"),
        unit="ms", errors="coerce", utc=True,
    )
    #    format="ISO8601" är INTE valfritt. sold_at blandar två varianter —
    #    "2026-07-05T19:43:00.2530000Z" med sju decimaler och
    #    "2026-04-05T17:32:00Z" utan. Utan explicit format gissar pandas ETT
    #    format från första raden och tystar resten till NaT via
    #    errors="coerce". Det raderade 7 816 av 7 831 tradera-datum utan
    #    ett enda felmeddelande.
    sold = pd.to_datetime(
        listings["date"], errors="coerce", utc=True, format="ISO8601"
    )
    listings["listed_at"] = listed.fillna(sold)

    # 7. Möbeltyp ur titeltexten. Exklusiv tilldelning: varje annons får
    #    precis en variant, annars hamnar "3-sits soffa med divan och fotpall"
    #    i tre hinkar och medianerna blir meningslösa.
    from .variant import classify_series

    listings["variant"] = classify_series(listings["search_blob"])

    #    Samma text typad med ATTRIBUTSYSTEMETS kod. Två kolumner för att
    #    övergången ska gå att mäta och att backa: `variant` är den gamla
    #    taxonomin (å/ä/ö, fåtölj som egen typ, ingen skänk/vitrin),
    #    `derived_type` är den nya (ASCII-vikt, mätt granularitet).
    #
    #    Utan den här kolumnen kan frågans typ aldrig jämföras med korpusens:
    #    `"hornsoffa" in ["hörnsoffa"]` är falskt och filtrerar bort allt.
    from type_system.attributes import derive_type as _derive
    from type_system.text_layer import extract as _extract

    listings["derived_type"] = [
        _derive(_extract(blob, prenormalized=True))
        for blob in listings["search_blob"]
    ]

    # 8. Storlek — steget under möbeltyp. Prisspridningen INOM variant har
    #    median 78 % (Kivik hörnsoffa: 2-sits 1 250 kr, 5-sits 4 900 kr), så
    #    utan denna nivå blandas fyra gånger i pris i samma median.
    from .size import classify_series as size_series

    listings["size"] = size_series(listings["search_blob"], listings["variant"])

    # 9. Cellnycklarna. Grupperingen som avgör VILKA annonser som hamnar i
    #    samma median: märke x produkttyp x modell x konfiguration, med
    #    tillbehör, jämförelser och lösa sektioner flaggade och buntar i egna
    #    celler. Se type_system/grouping.py.
    #
    #    Ligger på listings och inte i en sidofil, eftersom färskhets- och
    #    skickfiltren behöver kolumner som en sidofil inte bär, och en join på
    #    (titel, pris) inte är unik.
    from type_system.grouping import assign_cells

    cells = assign_cells(listings["name"].fillna("").astype(str))
    for column in cells.columns:
        listings[column] = cells[column].to_numpy()

    listings = listings.reset_index(drop=True)
    log.info(
        "Städat: %d -> %d rader (%d bortsorterade)",
        before, len(listings), before - len(listings),
    )
    return listings
