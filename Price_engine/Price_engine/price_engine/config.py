"""Konfiguration: sökvägar, kolumnmappning och tröskelvärden."""

from __future__ import annotations

import os
from pathlib import Path

# Läs .env om den finns, så att OPENAI_API_KEY inte behöver exporteras manuellt.
# Redan satta miljövariabler vinner — .env är en bekvämlighet, inte en override.
try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
except ImportError:  # pragma: no cover - python-dotenv är valfritt
    pass

# --- Datakälla -------------------------------------------------------------
# Peka om med miljövariabeln PRICE_ENGINE_DATA.
# Faller tillbaka på ./data om den finns, annars den uppackade vips-ml-datan.
_DEFAULT_LOCAL = Path(__file__).resolve().parent.parent / "data"
_DEFAULT_VIPS = Path.home() / "Price_engine" / "vips-ml-data" / "vips-fas0"

PREFERRED_FILES = ("master.parquet",)

SUPPORTED_SUFFIXES = (".parquet", ".csv", ".tsv", ".xlsx", ".xls", ".ndjson", ".jsonl")

#: Underkatalog i DATA_DIR för data som tillkommer efter master.parquet. Läses
#: ALLTID tillsammans med huvudtabellen. Finns för att ny skrapad data ska kunna
#: läggas in genom att kopiera en fil, i stället för att bygga om master.
#: Se README, avsnittet om att lägga till data.
EXTRA_DATA_DIR = "extra"

def _has_data(folder: Path) -> bool:
    """Innehåller katalogen en fil inläsaren faktiskt kan använda?

    Att bara kolla att katalogen FINNS är för svagt. En mätning som skrev
    `data/experiment/spread_inspection.csv` skapade `./data` som bieffekt, och
    därmed bytte motorn tyst datakälla från 1 525 135 annonser till en
    200-radig utdatafil. Inget felmeddelande — bara tomma svar.
    """
    if not folder.is_dir():
        return False
    for name in PREFERRED_FILES:
        if (folder / name).is_file():
            return True
    return any(p.suffix.lower() in SUPPORTED_SUFFIXES
               for p in folder.iterdir() if p.is_file())


DATA_DIR = Path(
    os.environ.get("PRICE_ENGINE_DATA")
    or (_DEFAULT_LOCAL if _has_data(_DEFAULT_LOCAL) else _DEFAULT_VIPS)
)

# Läs bara dessa filer om de finns (annars scannas hela DATA_DIR).
# master.parquet är den sammanslagna huvudtabellen: 1 526 119 rader.

# Format som inläsaren klarar.

# --- Prisurval -------------------------------------------------------------
# Datan blandar två prissorter som INTE får slås ihop:
#
#   realized  470 379 rader, median 800 kr — faktiskt betalt pris.
#             MEN: 99,97 % är auktion (auctionet 461 564 + tradera 8 674).
#             Bara 141 rader är marknadsplatsförsäljning.
#   asking  1 055 740 rader, median 900 kr — utropspris i annonser.
#             Rätt marknad, men aspirationspriser: osålda annonser ingår.
#
# Konsekvensen är att täckningen skiljer sig kraftigt per möbeltyp:
#   IKEA Landskrona   asking 1 114 rader / realized 22 rader
#   Bruno Mathsson    asking 2 363 rader / realized 8 025 rader
# Auktionshusen säljer designklassiker, inte IKEA.
#
# Lägen:
#   "auto"      realized när auktion dominerar marknaden, annars asking (default)
#   "realized"  bara faktiskt betalda priser
#   "asking"    bara utropspriser
#   None        båda (rekommenderas inte — prisnivåerna skiljer sig)
DEFAULT_PRICE_KIND = "auto"

# "auto" väljer bas på MARKNADSDOMINANS, inte på urvalsstorlek. Realiserade
# priser används bara när auktion är en verklig marknad för just den möbeln:
#
#   realized_N >= max(AUTO_MIN_REALIZED, asking_N * AUTO_REALIZED_SHARE)
#
# Utfallet på riktig data — separationen är entydig, inte en finjustering:
#   Wegner      1 972 /   224 = 8.80   -> realized
#   Mathsson    8 024 / 2 390 = 3.36   -> realized
#   String      5 358 / 6 813 = 0.79   -> realized
#   Pall       22 285 /34 854 = 0.64   -> realized
#   ---------------------------------- tröskel 0.50
#   Ektorp         55 / 2 131 = 0.026  -> asking
#   Landskrona     14 /   624 = 0.022  -> asking
#   Kivik          17 / 1 593 = 0.011  -> asking
AUTO_REALIZED_SHARE = 0.50

# Absolut golv: så få realiserade priser säger inget oavsett andel.
AUTO_MIN_REALIZED = 10

# Rimlighetsgränser vid städning. Datan sträcker sig 1 kr – 499 000 kr.
MIN_PRICE = 1.0
MAX_PRICE = 1_000_000.0

# --- Algoritm --------------------------------------------------------------
# Fönstret är ASYMMETRISKT och lutar nedåt:
#
#   low     = p30   lättsålt
#   default = p40   startläge
#   high    = p60   svårsålt
#
# Symmetriskt (N x 0,1 åt båda håll) spände fönstret p40–p60, alltså mittersta
# 20 % av marknaden. Mätt på riktig data låg då även vänsterläget över 35:e
# percentilen — Landskrona 1 990 kr vid p38, Madison 4 000 vid p35 — så den
# som drog reglaget till "säljs snabbt" konkurrerade ändå med en tredjedel av
# marknaden som var billigare.
#
# Startläget var tidigare medelvärdet av p40 och p50 (~p45). Två oberoende
# mätningar drog ned det till p40: bryggmätningen, som mäter mot exakt den
# fråga motorn ställer, landade på p34, och omlistningsstudien visar att
# prissänkningarna passerar 50 % redan i decilen p40-50. Se bridge_study/ och
# relist_study/.
HALF_INTERVAL_RATIO = 0.10  # avståndet till högerkanten (p60)
MIN_HALF_INTERVAL = 5  # golv enligt steg 3

# Startlägets avstånd från medianen, FRIKOPPLAT från högerkanten sedan
# 2026-08-19. Tidigare styrde HALF_INTERVAL_RATIO båda, så en ändring av
# startläget flyttade också `high` — p45 hade blivit p45/p55 i stället för
# p45/p60, alltså ett smalare intervall som ingen bett om.
#
#   0,10 -> p40   (tidigare värde, vilade på bryggmätningen p34 och
#                  omlistningsstudiens decil p40-50)
#   0,05 -> p45   <- valt av användaren 2026-08-19
#   0,00 -> p50   (medianen)
#
# STATUS: beslutat, inte mätt. Mätningen som finns pekar åt andra hållet —
# p40 gav 57,1 % inom facit mot p50:s 51,4 % på de 35 benchmarkmöblerna, och
# p45 ligger mellan dem. Se GRANSKNING_ATGARDER.md del 4 och avsnitt 3 i
# ARKITEKTUR.md. Talet är ett produktbeslut om vad `default` ska LOVA, inte en
# optimering mot facit: p40 lovar "pris som säljer", p50 "marknadens mitt".
DEFAULT_OFFSET_RATIO = 0.05

# Vänsterkanten går dubbelt så långt ned: 0,20 -> p30.
LOW_OFFSET_RATIO = 0.20
MIN_LOW_OFFSET = 10

# Under denna gräns täcker fönstret (±5) hela träffmängden, så low/high
# degenererar till absolut min/max -> markera svaret som osäkert.
LOW_CONFIDENCE_BELOW = 10

# --- Shrinkage mot bredare underlag ---------------------------------------
# Ett tunt underlag kan bära ett självsäkert men grovt fel svar. Kinnarps
# Capella X gav tre annonser — alla för undermodellen "Capella X Energy",
# nypris 10 376 kr — och motorn svarade 4 000 kr mot facit 1 300-1 600.
#
# Att i stället BYTA till en bredare sökning löser det inte, det flyttar bara
# felet: samma möbel mätt på alla Kinnarps-stolar ger 900 kr, alltså 31 % för
# lågt i stället för 150 % för högt. Sanningen ligger mellan nivåerna —
# den smala mängden är förorenad uppåt av en premiumvariant, den breda
# utspädd nedåt av billiga stolar.
#
# Därför glider svaret mot den bredare skattningen i stället för att hoppa dit,
# med samma viktning som skickmultiplikatorerna använder:
#
#     w = n / (n + FALLBACK_SHRINKAGE_K)
#     svar = smal^w * bred^(1-w)
#
# Blandningen sker i LOGARITMEN, eftersom priser är multiplikativa: mellan
# 900 och 4 000 kr ligger den geometriska mitten på 1 900, den aritmetiska på
# 2 450. Den geometriska är rätt när felet mäts i procent.
#
# Uppmätt på de 11 exempelmöblerna, se evaluation/.
FALLBACK_BELOW = 30  # över så här många träffar sker ingen blandning
# Svept mot de 11 exempelmöblerna, se evaluation/. k = 6 är enda värdet som
# klarar båda felriktningarna: Kinnarps (n=3, förorenad uppåt av en
# premiumundermodell) hamnar inom facit, och Mio Cordelia (n=11, där den smala
# mängden är RÄTT och märkets bredare sortiment är billigare) dras inte ned
# under facit. Vid k >= 8 offras Cordelia, vid k <= 4 räddas inte Kinnarps.
#
# OBS: k är inställd på samma 11 exempel som accuracy rapporteras på. Med en
# parameter och elva punkter är överanpassningen liten men verklig — värdet
# bör verifieras mot nya exempel innan det betraktas som satt.
FALLBACK_SHRINKAGE_K = 6  # n=3 -> w=0,33   n=11 -> w=0,65   n=24 -> w=0,80
FALLBACK_MIN_BROAD = 20  # den bredare mängden måste själv ha underlag

# --- Färskhet --------------------------------------------------------------
# Marknaden faller mätbart: medianen i hela datan går 1 167 kr (2024-07) ->
# 995 (2025-07) -> 800 (2025-10) -> 700-750 (2026). Samtidigt är 92 % av
# annonserna från archive, som slutar 2025-12. Utan färskhetsfilter dominerar
# alltså gamla priser: Mio Madison landar på 6 000 kr mot 5 000 på dagens
# Blocket.
#
# Fönstret är 8 månader. Räcker inte underlaget utökas det bakåt genom att ta
# de senaste annonserna även utanför fönstret, tills RECENCY_MIN_LISTINGS nås.
RECENCY_MONTHS = 8
RECENCY_MIN_LISTINGS = 15

# --- Degraderingsskydd: motorn får inte låtsas vara färsk -------------------
# Fönstret rör sig med kalendern; korpusen gör det inte. Mätt 2026-08-17 är
# archive-källan (973 009 rader, 63,8 % av korpusen) HELT utanför fönstret —
# dess färskaste rad är 2025-12-15 och gränsen passerade den 2026-08-15.
# 45,7 % av benchmarkfrågorna faller därför redan till `extended`.
#
# Det farliga är att felet är TYST. `extended` ger ett svar som ser likadant ut,
# men byggt på gamla priser i en fallande marknad — alltså systematisk
# ÖVERprisning. Ingenting i svaret skriker.
#
# Regeln: används `extended` OCH är även den färskaste raden i jämförelsemängden
# äldre än så här många månader, sänks konfidensen och förbehållet skrivs ut.
# Motorn får svara — ett gammalt pris är bättre än inget — men den får inte
# framställa svaret som aktuellt.
#
# 10 månader, alltså RECENCY_MONTHS + 2: marginalen finns för att en mängd vars
# färskaste rad ligger precis utanför fönstret inte är nämnvärt sämre än en vars
# ligger precis inuti. Talet är valt, inte mätt. Kör corpus_health.py för att se
# hur ofta det löser ut.
STALE_AFTER_MONTHS = int(os.environ.get("PRICE_ENGINE_STALE_MONTHS", "10"))

# ===========================================================================
# SKICK — skala, multiplikatorjobb och prisberäkning (steg 3)
# ===========================================================================
# Ordnad skala, BÄST FÖRST. Multiplikatorerna räknas relativt en referensnivå
# som väljs per grupp, och kedjas ihop längs den här ordningen.
#
# OBS: datan stödjer bara fyra av fem nivåer.
#   condition_vips har exakt fyra värden (Nyskick 7 775, Mycket bra 26 600,
#   Bra 196 111, Okej 191 068). "renoveringsobjekt" saknas helt.
#   condition_damaged är dessutom alltid False i alla 421 554 märkta rader —
#   kolumnen bär ingen information och används inte.
# Nivån behålls i skalan så att den fungerar direkt om data dyker upp; tills
# dess faller den tillbaka på defaulttrappan och märks source="default".
CONDITION_SCALE = (
    "nyskick",
    "mycket_gott",
    "gott",
    "slitet",
    "renoveringsobjekt",
)

# Datavärde -> skalnivå. Nycklarna normaliseras (gemener, utan diakriter)
# innan uppslag, så "Mycket bra skick" och "mycket bra skick" är samma.
CONDITION_VALUE_MAP = {
    "nyskick": "nyskick",
    "ny": "nyskick",
    "helt ny": "nyskick",
    "oanvand": "nyskick",
    "som ny": "nyskick",
    "mycket bra skick": "mycket_gott",
    "mycket gott skick": "mycket_gott",
    "mkt bra skick": "mycket_gott",
    "utmarkt skick": "mycket_gott",
    "bra skick": "gott",
    "gott skick": "gott",
    "fint skick": "gott",
    "okej skick": "slitet",
    "ok skick": "slitet",
    "slitet": "slitet",
    "bruksslitage": "slitet",
    "anvant skick": "slitet",
    "renoveringsobjekt": "renoveringsobjekt",
    "renoveringsbehov": "renoveringsobjekt",
    "for renovering": "renoveringsobjekt",
    "trasig": "renoveringsobjekt",
}

# --- Nattjobbet: härled multiplikatorerna ur egen data ---------------------
# Längre horisont än prisberäkningen: kvoter mellan skicknivåer åldras
# långsammare än prisnivån själv.
MULTIPLIER_HORIZON_MONTHS = 24

# En grupp bidrar bara om den har så här många annonser i minst två nivåer.
MULTIPLIER_MIN_PER_LEVEL = 10

# Antal grupper räcker inte som kvalitetsmått. Premium/nyskick vilade på fyra
# grupper vars kvoter var 0,39 / 1,43 / 2,25 / 4,25 — det passerar en
# antalsgräns men mäter uppenbart ingenting.
#
# Spridningen ensam duger dock inte heller som mått. Att kvoten varierar
# mellan möbeltyper är ÄKTA variation, inte samplingsbrus (se condition.py:
# den krymper inte när cellerna växer 16x). Ett spridningstak skulle döda
# nyskick globalt — 31 grupper och 1 717 annonser — av exakt samma skäl som
# det dödar premiums fyra.
#
# Det som ska mätas är osäkerheten i SKATTNINGEN, som krymper med antalet
# grupper. ln(p75/p25) / sqrt(grupper) är en grov standardavvikelse för
# logmedianen. Uppmätt på riktig data separerar den entydigt:
#
#   budget/slitet         1,38x /  32 grupper = 0,06   <- behålls
#   global/nyskick        2,24x /  31 grupper = 0,15   <- behålls
#   premium/mycket_gott   2,08x /  15 grupper = 0,19   <- behålls
#   ------------------------------------------ tröskel 0,25
#   mellan/slitet         2,29x /   8 grupper = 0,29   <- förkastas
#   premium/nyskick       2,35x /   4 grupper = 0,43   <- förkastas
MULTIPLIER_MAX_UNCERTAINTY = 0.25

# Märkesklass. Skickets priseffekt är större både i kronor och i andel för
# premiummöbler än för budgetmöbler, så en gemensam tabell skulle systematiskt
# fela åt båda håll. Okänt märke -> den globala fallback-tabellen.
BRAND_CLASSES = {
    "budget": (
        "ikea", "jysk", "mio", "ellos", "jotex", "granit", "h&m home",
        "hm home", "ahlens home", "venture home", "kungsangen", "hilding",
        "rusta", "em home", "chilli",
    ),
    "mellan": (
        "bolia", "boconcept", "ilva", "sweef", "string", "sofacompany",
        "muuto", "house doctor", "tempur", "sits", "broderna anderssons",
        "mavis", "furninova", "englesson",
    ),
    "premium": (
        "fritz hansen", "&tradition", "tradition", "hay", "vitra", "gubi",
        "dux", "swedese", "carl hansen", "artek", "louis poulsen",
        "bruno mathsson", "wegner", "kartell", "montana", "fredericia",
    ),
}

# Kallstart: räcker datan inte till märks tabellen source="default" och
# API-svaren exponerar det. ~25 % värdetapp per steg ned, symmetriskt uppåt.
DEFAULT_CONDITION_LADDER = {
    "nyskick": 1.5625,        # 1.25^2
    "mycket_gott": 1.25,
    "gott": 1.0,
    "slitet": 0.75,
    "renoveringsobjekt": 0.5625,   # 0.75^2
}

MULTIPLIER_TABLE_PATH = Path(
    os.environ.get("PRICE_ENGINE_MULTIPLIERS")
    or (Path(__file__).resolve().parent.parent / "condition_multipliers.json")
)

# --- Prisberäkningen: shrinkage ------------------------------------------
# w = n / (n + SHRINKAGE_K). Ingen hård klippa vid ett antal — viktningen
# ÄR den mjuka gränsen. n = 0 ger helt normaliserad skattning.
SHRINKAGE_K = 10

# Avviker den direkta skattningen mer än så här från den normaliserade
# halveras w. Fyra annonser kan vara två dubbletter och en felmärkning; en
# stor avvikelse i litet urval är skäl till MINDRE tillit, inte mer.
DIVERGENCE_LIMIT = 0.40

# basis-fältet i svaret: same_condition när w överstiger detta.
BASIS_SAME_CONDITION_W = 0.80

# --- Bilder (fas 1) --------------------------------------------------------
# Bilder kopplas till annonser via image_url. Lokala filer stöds också: sätt
# IMAGE_DIR till en mapp med en fil per annons-ID, så vinner den över URL:en.
IMAGE_DIR = os.environ.get("PRICE_ENGINE_IMAGE_DIR") or None

# Nedladdade bilder cachas här UNDER embeddingen och raderas efteråt.
#
# RÄTTAT 2026-08-19. Kommentaren påstod tidigare att cachen rensas explicit och
# att vi "aldrig sparar bilder permanent". Det var inte sant: en inventering
# hittade 94 356 JPEG-filer på 5,3 GB som legat kvar sedan 2026-08-04.
# Rensningen fanns som kommando men hade aldrig körts.
#
# Filerna är raderade. Dokumentation som ljuger är värre än ingen — därför står
# den här noten kvar i stället för att bara tas bort.
#
# Rensa manuellt med: python -m price_engine.images clear
IMAGE_CACHE_DIR = Path(
    os.environ.get("PRICE_ENGINE_IMAGE_CACHE")
    or (Path(__file__).resolve().parent.parent / ".cache" / "images")
)

IMAGE_FETCH_WORKERS = 16
IMAGE_FETCH_TIMEOUT = 20

# --- Bildmodeller (fas 2–3) ------------------------------------------------
# DINOv2 framför CLIP: CLIP är stark på det semantiska ("grön sammetssoffa")
# men trubbig på finkorniga skillnader. DINOv2 fångar visuell identitet —
# benens form, sömmar, klädselstruktur, proportioner — vilket är precis
# smärtpunkten: "samma soffa, olika utförande, väldigt olika pris".
# `small` räcker (384 dim) och håller jobbet snabbt. Apache 2.0.
# Byt här för att prova en större variant eller CLIP.
EMBED_MODEL = os.environ.get("EMBED_MODEL", "facebook/dinov2-small")
EMBED_DIM = 384

# Objektdetektor för beskärning. Uppmätt på denna maskin (CPU, 4 trådar):
#   imgsz=640  154 ms/bild   imgsz=320  38 ms/bild   imgsz=256  26 ms/bild
# Träffsäkerheten sjunker inte vid 320 (44 % mot 42 % vid 640), så 320 är
# rätt avvägning.
DETECTOR_MODEL = os.environ.get("DETECTOR_MODEL", "yolo11n.pt")
DETECT_IMGSZ = 320
DETECT_CONF = 0.25

# Marginal runt YOLO-rutan. Detektorn klipper ofta precis vid kanten och
# missar ben och armstöd — som är just det DINOv2 ska titta på.
CROP_MARGIN = 0.08

# Färghistogram: bins per HSV-kanal.
COLOR_BINS = 32

# Vikt mellan bildlikhet och färglikhet i den sammanvägda poängen:
#   poäng = (1 - COLOR_WEIGHT) * bildlikhet + COLOR_WEIGHT * färglikhet
# Justeras mot data i fas 5, inte gissas.
COLOR_WEIGHT = 0.15

TORCH_THREADS = 4
EMBED_BATCH = 32

# Vektorlagring (fas 4). Systemet HÅLLER inga annonsbilder — bara vektorerna.
# (Formuleringen är avsiktligt i presens om nuläget och inte ett löfte om
# processen: löftet stod här förut och höll inte. Se noten vid IMAGE_CACHE_DIR.)
# En embedding är inte en kopia av bilden, vilket gör upphovsrättsfrågan
# kring annonsbilder betydligt mindre obekväm.
VECTOR_DIR = Path(
    os.environ.get("PRICE_ENGINE_VECTORS")
    or (Path(__file__).resolve().parent.parent / ".cache" / "vectors")
)

# --- Bildsökning i API:et (fas 6) ------------------------------------------
# Bildsökningen är en OMSORTERING, inte en sökmotor: kandidaterna plockas
# först på märke/modell/typ/skick precis som förut, och bilden rangordnar
# bara dem. Det gör att en fåtölj inte kan matcha en soffa för att bakgrunden
# är lika, att vi jämför mot ~200 vektorer i stället för 94 000, och att den
# befintliga prisalgoritmen kan köras oförändrad på en bättre urvalsmängd.
#
# ===========================================================================
# BILDENS ROLL: bara möbeltyp — INTE filtrering av jämförelsemängden
# ===========================================================================
# Beslutat 2026-08-06 efter parmätningen mot textbaserat facit (9 779 par,
# se BILDTROSKEL_RAPPORT.md). DINOv2 kan inte identifiera MODELLER:
#
#   hörnsoffa   AUC 0,513   trots 99 % YOLO-beskärning
#   säng        AUC 0,522
#   hylla       AUC 0,577
#   soffa       AUC 0,662   (kalibreringen gjordes ursprungligen på soffor)
#
# Korsningen med beskärningen visade att det inte är detektorns fel — hörnsoffa
# är nästan helt beskuren och separerar ändå inte. Svagheten sitter i
# embeddingen, och ingen tröskel räddar den.
#
# Bilden får därför EN uppgift: avgöra möbeltyp. Rätt typ ger rätt
# jämförelsemängd, och det är där de stora prisfelen sitter (Mio Town blandade
# hörnsoffor med raka soffor och hyllor). Se visual_variant.py.
#
# Filtrerings- och omsorteringskoden är kvar och testad bakom flaggan, för att
# beslutet ska gå att ompröva när embeddingen byts.
IMAGE_RERANK_ENABLED = False

# Ledorden ur grannarnas titlar är också en bildbaserad filtrering av
# jämförelsemängden och faller under samma beslut. Extraktionen är kvar och
# exponeras i svaret som information; den filtrerar inte längre.
CUE_FILTER_ENABLED = False

# PROVISORISK TRÖSKEL — LÄSES INTE LÄNGRE AV PRISSÄTTNINGEN.
# Kvar eftersom tre andra ställen använder den: den visuella kohorten
# (cohort.py), grannröstningen för möbeltyp (VISUAL_VARIANT_MIN_SIM speglar
# den) och valideringsverktygen. Prissättningens bildfilter läser den bara när
# IMAGE_RERANK_ENABLED sätts tillbaka till True. Uppmätt på 2 000 vektorer: samma möbeltyp landar på
# 0,52–0,75, medan medianen mot slumpmässiga annonser är 0,22 och en fråga
# utan bra match toppar på 0,21. 0,45 ligger mellan dessa.
#
# Sätt den på riktigt med:  python validate_images.py pairs mina_par.csv
IMAGE_SIMILARITY_MIN = 0.45

# Överlever färre än så här många annonser tröskeln lättas den stegvis,
# och svaret markeras med imageFiltered="loosened".
IMAGE_MIN_LISTINGS = 5
IMAGE_LOOSEN_STEPS = (0.35, 0.25, 0.15)

# Sista utvägen när ingen tröskel räcker: ta de K mest lika.
IMAGE_TOP_K = 30

# --- Möbeltyp (variant) ----------------------------------------------------
# Modellnamnet ensamt räcker inte: "Landskrona" är en IKEA-serie som omfattar
# soffa, hörnsoffa, fåtölj och fotpall. Spannet inom ett modellnamn är stort —
# 5,5x för Vimle (bäddsoffa 5 500 kr mot fotpall 1 000 kr), 5,0x för Kivik
# och Malm. Användaren skriver aldrig "fotpall" själv, men ett foto visar det.
#
# Under så här många träffar släpps variantfiltret, se pricing.price_query.
# Samma tröskel styr vilka typer bildmodellen får välja bland: en typ som inte
# skulle klara strikt filtrering erbjuds aldrig som alternativ, så modellen kan
# inte svara något som ger noll träffar.
VARIANT_STRICT_MIN = 15

# Modell för bildklassningen. Detta är motorns enda modellanrop, och det görs
# bara när minst två möbeltyper är möjliga för den sökta modellen — en Billy
# är alltid en hylla, och då finns inget att välja mellan.
VARIANT_MODEL = os.environ.get("VARIANT_MODEL", "gpt-4o-mini")

# Modell för FORMLAGRET — en annan och svårare uppgift än typklassningen ovan.
# Typklassningen svarar "soffa eller hylla"; formlagret ska skilja en U-soffa
# från en hörnsoffa och en fastsittande divan från en lös puff bredvid soffan.
#
# Mätt 2026-08-20 på fyra soffbilder med känd form (litet underlag, n=4):
#
#     gpt-4o-mini    form 1/4    kallade rak soffa med lös puff "divansoffa"
#     gpt-4o         form 3/4    missade U-soffan
#     gpt-5          form 4/4    tillbehör 4/4
#
# Skillnaden är stor nog att inte vara brus vid n=4, men underlaget är litet:
# efter upphovsrättssaneringen finns inga soffbilder utanför benchmarken kvar.
# Mätningen gäller FORM, inte pris, och inga priskonstanter är rörda.
# STATUS: mätt (n=4, svagt underlag). Bör mätas om när fler bilder finns.
#
# Anropet cachas på bildens hash, så samma foto kostar ett anrop en gång.
FORM_VISION_MODEL = os.environ.get("FORM_VISION_MODEL") or "gpt-5"

# --- Leverantör för modellanropen ------------------------------------------
# Motorn talar OpenAI-protokoll, men inte nödvändigtvis med OpenAI. Lovables
# AI-gateway (`https://ai.gateway.lovable.dev/v1`) är protokollkompatibel och
# serverar `google/gemini-2.5-flash`, som Vips-appens edge functions redan
# använder för bildklassning.
#
# Sätt AI_BASE_URL + AI_API_KEY i .env för att gå via gatewayen i stället:
#
#   AI_BASE_URL=https://ai.gateway.lovable.dev/v1
#   AI_API_KEY=<LOVABLE_API_KEY>
#   VARIANT_MODEL=google/gemini-2.5-flash
#
# Utan dem används OPENAI_API_KEY mot OpenAI som förut.
AI_BASE_URL = os.environ.get("AI_BASE_URL") or None
AI_API_KEY = os.environ.get("AI_API_KEY") or os.environ.get("OPENAI_API_KEY")

# Strikt JSON-schema (`response_format=<pydantic-modell>`) stöds av OpenAI men
# inte av alla gateways. Lovables edge functions använder `json_object`, alltså
# fritt JSON utan schemagaranti. `auto` provar strikt först och faller tillbaka.
AI_STRUCTURED_MODE = os.environ.get("AI_STRUCTURED_MODE", "auto").lower()

# --- Priscellerna som jämförelsemängd --------------------------------------
# Med flaggan PÅ hämtas jämförelsemängden ur `type_system/price_cells.parquet`
# i stället för ur textsökningen. Cellen är märke x produkttyp x modell x
# konfiguration, med tillbehör, jämförelser och lösa sektioner uteslutna och
# buntar i egna celler. Nycklarna ligger som kolumner på listings — se
# data_loader och type_system/grouping.assign_cells.
#
# Skälet är mätt: den gamla grupperingen la en matta för 200 kr, en Mio-soffa
# för 3 000 och en Swedese-soffa för 73 000 i samma hink under namnet "Madison".
# Spridningen var inte prisvariation utan fyra olika produkter.
PRICE_CELLS_ENABLED = os.environ.get("PRICE_CELLS_ENABLED", "0").lower() in (
    "1", "true", "on", "ja")

# --- Cellfiltret: rensning, INTE sökning -----------------------------------
# Mätt 2026-08-16: att låta cellen ERSÄTTA textsökningen sänkte default inom
# facit från 55,9 % till 26,5 %, eftersom cellnyckeln kollapsar till märke x typ
# för de 85,7 % av raderna som saknar modellord — bredare än textsökningen den
# ersatte. PRICE_CELLS_ENABLED förblir därför av.
#
# Men cellbygget hittade 155 929 buntar, 59 191 tillbehör, 43 446
# jämförelseannonser och 5 675 lösa sektioner. Värdet sitter i städningen.
# CELL_FILTER_ENABLED behåller textsökningen som motor och använder
# cellflaggorna som ett rensningssteg på träffmängden.
#
# PÅ som standard sedan 2026-08-16. Mätt på 35 benchmarkmöbler: default inom
# facit 57,1 % -> 62,9 % och medianintervallbredd 126,6 % -> 111,1 %. På de 12
# första möblerna föll bredden 123,6 % -> 91,9 % med oförändrad träff, vilket är
# det renaste utfallet: samma sökning, renare jämförelsemängd, mindre spridning.
# 40,8 % av träffmängden rensades, mest buntar och tillbehör.
#
# Sätt CELL_FILTER_ENABLED=0 för att köra den gamla vägen — den är orörd och
# testad (tests/test_cell_filter.py).
CELL_FILTER_ENABLED = os.environ.get("CELL_FILTER_ENABLED", "1").lower() in (
    "1", "true", "on", "ja")

# --- Vision via edge function ----------------------------------------------
# Tredje vägen, vid sidan av OpenAI och en OpenAI-kompatibel gateway: en egen
# edge function som håller leverantörsnyckeln på servern. Finns för att Lovables
# LOVABLE_API_KEY är write-only i Lovable Cloud och alltså inte kan läsas ut till
# ett fristående mätskript.
#
#   VISION_EDGE_URL=https://<ref>.supabase.co/functions/v1/attribute-vision
#   VISION_EDGE_TOKEN=<delad hemlighet, samma som ATTRIBUTE_VISION_TOKEN>
#   VISION_EDGE_MODEL=google/gemini-2.5-flash
#
# Sätts den används den före allt annat. Lämnas den tom ändras ingenting.
# --- Attributsystemet driver sökningen -------------------------------------
# Med flaggan PÅ filtrerar motorn på `derived_type` (attributsystemets taxonomi)
# i stället för `variant` (den gamla). Skillnaden är inte kosmetisk:
#
#   fatolj   egen typ, MÄTT 2,60x en stol      (gamla hade den, nya saknade den)
#   skank    egen typ, 1,691x en hylla         (gamla slog ihop med byrå)
#   vitrin   egen typ, 1,814x en hylla         (gamla slog ihop med hylla)
#   soffbord egen typ, 0,492x ett matbord      (gamla slog ihop med bord)
#
# Priset räknas likadant som förut — median över träffmängden. Det enda som
# ändras är VILKA annonser som hamnar i den mängden.
TYPE_SYSTEM_DRIVES_SEARCH = os.environ.get(
    "PRICE_ENGINE_TYPE_SYSTEM", "1").lower() in ("1", "true", "on", "ja")

# --- Drift: CORS och API-nyckel --------------------------------------------
# BÅDA är avstängda som default, och det är avsiktligt. Motorn har körts utan
# dem hela tiden, och en flagga som ändrar beteendet bara genom att finnas hade
# varit precis den sortens tysta ändring som är svår att felsöka. Utan de här
# variablerna satta beter sig servern EXAKT som förut.
#
# CORS: kommaseparerad lista med origins som får anropa från en webbläsare.
#
#   PRICE_ENGINE_CORS_ORIGINS=https://minapp.se,http://localhost:3000
#
# Tom lista = ingen CORS-middleware alls, alltså dagens läge: en preflight
# svarar 405 och ett svar saknar Access-Control-Allow-Origin. Server-till-
# server-anrop berörs inte — CORS är en regel webbläsaren upprätthåller.
# STATUS: ovaliderad (driftsinställning, påverkar inget prissvar).
CORS_ORIGINS = tuple(
    o.strip() for o in (os.environ.get("PRICE_ENGINE_CORS_ORIGINS") or "").split(",")
    if o.strip()
)

# API-nyckel. Sätts den krävs headern `x-api-key` på allt utom /health, som
# lämnas öppen för att lastbalanserare och uppstartskontroller ska fungera.
# Lämnas den tom krävs ingen nyckel — dagens läge.
# STATUS: ovaliderad (driftsinställning, påverkar inget prissvar).
API_KEY = os.environ.get("PRICE_ENGINE_API_KEY") or None

VISION_EDGE_URL = os.environ.get("VISION_EDGE_URL") or None
VISION_EDGE_TOKEN = os.environ.get("VISION_EDGE_TOKEN") or None
VISION_EDGE_MODEL = os.environ.get("VISION_EDGE_MODEL") or "google/gemini-2.5-flash"

# --- Kolumnmappning --------------------------------------------------------
# Kolumnnamn varierar mellan källor. Första träffen i varje lista vinner.
COLUMN_CANDIDATES: dict[str, tuple[str, ...]] = {
    "name": ("title_norm", "title_raw", "title", "namn", "name", "rubrik", "modell"),
    "brand": ("brand", "varumarke", "varumärke", "marke", "märke", "tillverkare"),
    "price": ("price_sek", "price", "pris", "slutpris", "belopp", "summa"),
    "condition": ("condition_vips", "condition", "skick", "cond"),
    # Två skilda datumkolumner i datan: listed_at_ms finns på 100 % av
    # utropspriserna men 0 % av auktionerna, sold_at tvärtom. De slås ihop
    # till en enda `listed_at` i inläsaren.
    "date": ("sold_at", "date", "datum", "sald_datum"),
    "listed_at": ("listed_at_ms", "created_at", "listed_at"),
    "price_kind": ("price_kind",),
    "dedup_key": ("dedup_key",),
    "source": ("source", "kalla", "källa"),
    # Grupperingsnycklar för skickmultiplikatorerna.
    # cat_rule är regelbaserad; cat_clf utelämnas medvetet eftersom den
    # kommer från category_clf.joblib och motorn ska vara modellfri.
    "category": ("cat_rule", "category", "kategori"),
    "subgroup": ("category_native", "type_word", "subkategori"),
    "image_url": ("image_url", "image", "bild", "bild_url", "image_path"),
}

# Extra textkolumner som vägs in i fritextsökningen när de finns.
# OBS: canonical_text utelämnas medvetet — den är trunkerad i datan
# (innehåller ofta bara "Okej skick" e.d.) och förstör namnmatchningen.
EXTRA_TEXT_COLUMNS = ("ikea_model", "designer", "material", "type_word", "era")

# --- Skicknormalisering ----------------------------------------------------
# Datan har fyra kanoniska skicknivåer. Användare skriver fritext
# ("gott skick" finns t.ex. inte som värde) -> mappa via synonymer.
CANONICAL_CONDITIONS = ("Nyskick", "Mycket bra skick", "Bra skick", "Okej skick")

# --- HUVUDSTRÖMBRYTARE FÖR SKICK -------------------------------------------
# När denna är False är priset HELT oberoende av skick: ingen filtrering,
# ingen multiplikator, ingen bandskalning. Kvar blir bara grundalgoritmen —
# matcha, sortera, ta medianen och fönstret runt den.
#
# Avstängd på begäran tills skickmodellen görs om. Allt maskineri nedan är
# orört och testat, så en återgång är att sätta tillbaka True.
#
# Ett angivet `condition` tas fortfarande emot av API:et och ekas tillbaka i
# svaret, men påverkar ingenting. conditionMethod blir "disabled", så det går
# att se i svaret att skicket ignorerades avsiktligt och inte av databrist.
CONDITION_PRICING = os.environ.get("PRICE_ENGINE_CONDITION", "").lower() in (
    "1", "true", "on", "ja"
)

# --- Skickhantering --------------------------------------------------------
# Skick är märkt på bara 7,8 % av asking-raderna (archive: 0 %, blocket: 99,7 %).
# Strikt filtrering är mest exakt när underlaget räcker, men kollapsar snabbt:
# Landskrona har 624 träffar men bara 1 i Nyskick och 3 i Okej skick.
#
# Kedjan är därför: filtrera strikt -> annars skala ned med prisklassens faktor.
#
# De fyra nivåerna slås ihop till TRE innan de används för prissättning:
# Nyskick och Mycket bra skick har nästan identisk kvot (1,43 mot 1,39) men
# Nyskick spretar 2,5x mer (IQR/median 0,72 mot 0,29). Sammanslagningen kostar
# inget i träffsäkerhet och vinner mycket i stabilitet.
CONDITION_TIERS = {
    "Nyskick": "Toppskick",
    "Mycket bra skick": "Toppskick",
    "Bra skick": "Bra skick",
    "Okej skick": "Okej skick",
}
CONDITION_TIER_ORDER = ("Toppskick", "Bra skick", "Okej skick")

# Samma nivåer sorterade SÄMST FÖRST — ordningen medianskicket räknas i.
CONDITION_TIER_ORDER_WORST_FIRST = ("Okej skick", "Bra skick", "Toppskick")

# Färre märkta träffar än så här -> medianskicket går inte att bestämma,
# och skicket lämnas därhän i stället för att gissas.
CONDITION_ANCHOR_MIN = 10

# Skalans interna ankare. Banden byggs relativt denna nivå, men vilken nivå
# som får faktor 1,0 vid en förfrågan avgörs per sökning — se
# pricing._median_tier. Bra skick är internt ankare för att det är den
# vanligaste nivån i varje mätt sökning och därmed har stabilast underlag.
CONDITION_REFERENCE = "Bra skick"

# Sanitetstak på justeringen. Tidigare var taket 1,0 — medianen fick aldrig
# höjas — eftersom vi inte visste vilket skick den representerade. Nu MÄTS
# ankaret per sökning (medianskicket bland träffarna), så en uppräkning är
# grundad i stället för antagen och taket kan vara generöst.
#
# Det finns kvar som spärr mot den gamla felkällan: per kategori gav bandet
# en gång 2,60x för Nyskick, drivet av tunna celler. Med prisnivågruppering
# och 12-15 grupper per cell ligger de uppmätta faktorerna på 0,50-1,67.
BAND_MAX_FACTOR = 2.0

# Under så här många träffar efter skickfiltrering släpps filtret.
# Måste vara klart högre än MIN_HALF_INTERVAL (5) för att fönstret ska
# bygga på mer än bara ändpunkterna.
CONDITION_STRICT_MIN = 15

# Banden räknas ur datan vid uppstart som percentiler av parvisa kvoter INOM
# samma undergrupp — aldrig som global median per skicknivå. Den naiva
# varianten ger orimligheter (Nyskick billigare än Okej skick) eftersom
# skicknivåerna innehåller olika möbler.
MULTIPLIER_MIN_ROWS = 5  # min rader per (undergrupp, skick)
MULTIPLIER_MIN_GROUPS = 3  # min undergrupper för ett band

# Kvoten beror på prisnivå. Leave-one-out mot ny möbel, medianfel på kvoten:
#
#   global konstant     0,218 / 0,146   (Bra skick / Okej skick)
#   per prisklass       +19 % / +25 %   <- enda dimensionen som bär
#   per möbeltyp        +10 % / +10 %
#   per märke            +1 % / −3 %    <- värdelös
#   prisklass x typ     +16 % / +26 %   (inte bättre än prisklass ensam)
#
# Märke ser lovande ut i råtabellen men bara IKEA, Jysk och Mio har underlag,
# och alla tre är billiga märken som bara reproducerar den låga prisklassen.
# Nivågränserna sätts som kvantiler av datan, inte fast.
PRICE_LEVELS = ("låg", "mellan", "hög")

# Kvantiler som skalar prisintervallets kanter. 0,40/0,60 är mittersta 20 %
# av kvotfördelningen — samma andel som huvudalgoritmens fönster (N x 0,1 åt
# vardera hållet motsvarar exakt p40–p60 av de sorterade priserna). Därmed
# betyder båda intervallen samma sak: marknadens mitt, inte vår osäkerhet.
#
# Osäkerheten har en egen kanal (confidence + note + groups) och ska inte
# blandas in i glidknappens ändlägen — de betyder "säljs snabbt / långsamt".
BAND_LOW_Q = 0.40
BAND_HIGH_Q = 0.60

# Viddmätningen använder DÄREMOT p25/p75, alltså den sanna spridningen.
# Med 0,40/0,60 hamnar alla spridningar på 1,01–1,48 och flaggan hade aldrig
# löst ut. Två olika tal till två olika jobb: skalning och varning.
BAND_WIDE_RATIO = 2.0

# Percentiler beräknade på för få undergrupper är själva osäkra skattningar.
# Ett smalt band från 7 grupper är inte samma sak som ett välbestämt band:
# prisnivån "hög" täcker allt över 1 000 kr och vilar på just 7 grupper, så
# ett band därifrån ska inte redovisas som säkert.
BAND_SOLID_GROUPS = 10

# Skickmultiplikatorer beräknas BARA på utropspriser. På auktionsdatan är
# kvoterna icke-monotona (Mycket bra 0,68 < Okej 0,91) eftersom nivåerna
# Nyskick/Mycket bra bara har ~2 000 rader vardera av 339 065, och klubbpriset
# drivs av objektets åtråvärdhet snarare än av en fyrgradig skala.
MULTIPLIER_PRICE_KIND = "asking"

CONDITION_SYNONYMS: dict[str, str] = {
    # Nyskick
    "nyskick": "Nyskick",
    "ny": "Nyskick",
    "nytt": "Nyskick",
    "helt ny": "Nyskick",
    "helt nytt": "Nyskick",
    "oanvand": "Nyskick",
    "oanvant": "Nyskick",
    "som ny": "Nyskick",
    # Mycket bra skick
    "mycket bra skick": "Mycket bra skick",
    "mycket gott skick": "Mycket bra skick",
    "mkt bra skick": "Mycket bra skick",
    "mycket fint skick": "Mycket bra skick",
    "utmarkt skick": "Mycket bra skick",
    # Bra skick
    "bra skick": "Bra skick",
    "gott skick": "Bra skick",
    "fint skick": "Bra skick",
    "gott": "Bra skick",
    "bra": "Bra skick",
    "fint": "Bra skick",
    # Okej skick
    "okej skick": "Okej skick",
    "ok skick": "Okej skick",
    "okej": "Okej skick",
    "acceptabelt skick": "Okej skick",
    "anvant skick": "Okej skick",
    "bruksslitage": "Okej skick",
    "slitet": "Okej skick",
    "slitage": "Okej skick",
}


# --- Möbeltyp ur bilden med DINOv2 (utan modellanrop) ----------------------
# Typklassningen har gått via OpenAI. Den kostar per förfrågan och kan sluta
# fungera — vilket den gjorde: krediterna tog slut mitt i en utvärdering och
# hela bildvägen föll bort. Samtidigt finns 94 305 embeddade annonsbilder vars
# möbeltyp redan är bestämd av textklassningen, så en frågebild kan i stället
# hitta sina närmaste grannar och läsa av vad DE är.
#
# Varför det spelar roll för priset: Mio Town finns som rak soffa OCH hörnsoffa,
# och bland träffarna ligger hyllor och fotpallar med samma modellnamn.
#   ofiltrerat        p40 6 000 kr   (facit 7 000-12 000)
#   filtrerat soffa   p40 7 500 kr   inom facit
# IKEA Stocksund: 700 -> 800 kr, också in i facit.
VISUAL_VARIANT_K = 40  # antal grannar som röstar

# Grannar under denna likhet röstar inte. 0,45 är samma tröskel som
# bildomsorteringen använder (IMAGE_SIMILARITY_MIN) och av samma skäl: under
# den nivån är likheten inte skild från slumpen.
VISUAL_VARIANT_MIN_SIM = 0.45

# Färre kvalificerade grannar än så här -> svara "vet inte" i stället för att
# gissa. En promptad modell gör sällan det, och det är just därför den kan ge
# ett självsäkert fel svar.
VISUAL_VARIANT_MIN_VOTES = 5

# Tvåan tas med när den når så här stor andel av vinnarens röster. En hörnsoffa
# fotograferad rakt framifrån ÄR en rak soffa i bild, och att tvinga fram ett
# val ger fel svar i halva de fallen. Samma resonemang som VariantGuess.
VISUAL_VARIANT_RUNNERUP = 0.60

# --- Ledord ur grannarnas titlar -------------------------------------------
# Möbeltypen är grov — tretton hinkar. Det som skiljer en stor U-soffa från en
# liten hörnsoffa står i orden: "divan", "schäslong", "sammet", "mörkgrå".
# De behöver ingen språkmodell; grannarnas titlar bär dem redan, och vilka som
# är särskiljande går att räkna mot korpusen.
CUE_CORPUS_SAMPLE = 60_000  # annonser i baslinjen
CUE_RANDOM_SEED = 20260805
CUE_MIN_NEIGHBOURS = 3  # ordet måste finnas hos så här många grannar
CUE_MIN_LIFT = 3.0  # och vara så här mycket vanligare än i korpusen
CUE_MAX_WORDS = 12

# Ledorden används RANGORDNANDE, inte filtrerande. Att stapla hårda filter
# över varandra visade sig beskära för hårt: variantfilter plus bildomsortering
# tog Vimle från 117 träffar till 40 och Santos från 24 till 7, varpå
# shrinkage-mekanismen drog svaret mot märkesnivån. Ledorden får därför bara
# välja VILKA av kandidaterna som räknas, och bara om tillräckligt många blir
# kvar.
CUE_MIN_LISTINGS = 15

# ===========================================================================
# ÅTGÄRD 1 — prisbas vid okänd identitet
# ===========================================================================
# När varken märke eller modellnamn går att fastställa får auktionsdata ALDRIG
# vara prisbas. Auktionspopulationen är designklassiker och skevar systematiskt
# lågt för vardagsmöbler: percentilstudiens kanalgap är −0,42 för low end, och
# "Ekbord med stolar" landade på 300 kr mot facit 2 000–5 000 (−85 %) just för
# att `auto` valde realized.
#
# Regeln är EXPLICIT och testbar, inte en bieffekt av vilken datamängd som råkar
# vara störst — det var precis den bieffekten som orsakade felet.
FORCE_ASKING_WHEN_ANONYMOUS = True

# Ord som inte identifierar en möbel utan bara beskriver den. Har frågan inget
# ord utanför denna lista, och inget märke, är identiteten okänd.
#
# Listan är medvetet bred: att felaktigt kalla en fråga anonym kostar bara att
# utropsbasen används (vilket är rätt marknad ändå), medan motsatsen — att
# missa att frågan är anonym — kostar 85 % fel.
GENERIC_TOKENS = frozenset("""
soffa soffor soffan sits sitsig sitssoffa baddsoffa sovsoffa hornsoffa
divan schaslong schaselong fatolj fatoljer stol stolar karmstol kontorsstol
pinnstol barstol gungstol matstol matgrupp matbord matsalsbord bord soffbord
sidobord skrivbord kokbord koksbord matsalsgrupp sang sangar sangram
dubbelsang enkelsang byra byraer kommod sangbord nattduksbord sideboard
skank hylla hyllor bokhylla hyllsystem skap garderob vitrinskap spegel
speglar fotpall sittpuff puff ottoman pall pallar bankskiva
med och till fran for i pa av den det en ett som ar var samt plus
fin fint fina snygg snygga vacker fraschy frasch nya ny nytt begagnad
gott bra mycket okej skick helt oanvand slitet vintage retro antik gammal
aldre stor stort stora liten litet sma rund rundt runt rak raka
vit vitt vita svart svarta gra gratt bla blatt bla brun brunt bruna
beige rod rott grona gron gul gult rosa lila turkos morkgra ljusgra
tra tramonstrad ek eik bok furu bjork teak valnot mahogny massiv massivt
tyg sammet skinn lader linne bomull plast metall stal glas marmor
kr sek cm mm meter styck stycken set dlr delar bortskankes hamtas
""".split())

# ===========================================================================
# ÅTGÄRD 2 — filtergolv: filter blir viktning under golvet
# ===========================================================================
# Varje filter är rimligt för sig men de MULTIPLICERAS. Variantfilter plus
# bildomsortering tog Vimle från 117 träffar till 40 och Santos från 24 till 7,
# varpå shrinkagen — korrekt enligt sin egen design — drog svaret mot
# märkesnivån. Default-träffen föll från 90,9 % till 72,7 %.
#
# Regeln är arkitektur, inte punktlagning: INGEN filterkedja får ta
# jämförelsemängden under golvet. Det filter som skulle bryta golvet
# konverteras automatiskt från filtrering till VIKTNING — annonserna behålls,
# men de som filtret skulle kastat väger mindre i kvantilberäkningen.
#
# 30 är valt teoretiskt, inte mot testmängderna: det är samma tal som
# MIN_ASKING_PER_MATCH i percentilstudien, och skälet är detsamma — under
# ~30 observationer blir en kvantilskattning dominerad av enskilda annonser.
# Vid n=30 vilar p30 och p60 på tre annonser vardera.
MIN_COMPARISON_SET = 30

# Vikten en annons får när ett filter velat kasta den men golvet stoppade det.
# 0,25 betyder att fyra "fel" annonser tillsammans väger som en rätt. Talet är
# valt för att vara litet nog att signalen syns men stort nog att en enda
# felklassad annons inte försvinner helt — filtren har själva felmarginaler
# (textklassningen av variant, DINOv2-tröskeln), och ett hårt nollställande
# skulle förutsätta att de inte har det.
FILTER_DOWNWEIGHT = 0.25

# Bildlikheten är en gradvis signal, inte binär, så där används likheten själv
# som vikt — skalad så att tröskelvärdet motsvarar FILTER_DOWNWEIGHT och
# perfekt likhet motsvarar 1,0.
IMAGE_WEIGHT_FLOOR = 0.25

# --- Storleksvarning -------------------------------------------------------
# Saknar förfrågan storleksuppgift men jämförelsemängden spretar över storlekar
# breddas intervallet och grupperna redovisas. Tröskeln är förhållandet mellan
# dyraste och billigaste storleksgruppens median. 1,5 är valt så att naturlig
# variation inom en storlek inte löser ut varningen, men Kivik hörnsoffa
# (2-sits 1 250 mot 5-sits 4 900 = 3,9x) gör det.
SIZE_WARN_RATIO = 1.5

# ===========================================================================
# DEL 2 — visuell kohort
# ===========================================================================
# "Ekbord med stolar": orden matchar 226 annonser vars Blocket-utrop ligger på
# 50-250 kr — äkta priser, gammal brun ek är nästan värdelös — men bilden visar
# en tjock massiv ekskiva där facit är 2 000-5 000 kr. Ingen textfix löser det;
# orden säger kategori, bilden bär värdet.
#
# Flödet aktiveras bara när alla tre gäller: förfrågan identifierar ingen
# produkt, det finns en bild, OCH ordkohortens prisspridning är stor. Är orden
# tillräckliga skulle bilden bara krympa underlaget i onödan.
COHORT_MIN = 15  # minsta kohort som alls prissätts
COHORT_MAX = 200  # tak enligt uppdraget

# p90/p10 i logdomän. Över detta anses ordkohorten inte bära värdet.
# 6,0 valt så att normal marknadsspridning (2-4x) inte löser ut flödet, medan
# ekbordsfallet (50-250 kr mot enstaka tusenlappar, p90/p10 ~ 20x) gör det.
COHORT_DISPERSION_TRIGGER = 6.0

# Är ÄVEN den visuella kohorten så spretig märks svaret osäkert och klungornas
# prislägen redovisas. Hellre "osäkert 800-3 500" än ett självsäkert fel svar.
COHORT_DISPERSION_WARN = 4.0

# Klungdelningen kräver att det största glappet i logdomän är så här många
# gånger större än det typiska steget. Utan kravet delar argmax även en helt
# jämn fördelning, och varningen rapporterar två klungor som inte finns.
COHORT_GAP_FACTOR = 3.0

# ===========================================================================
# PRISBAS: utrop först, auktion som KORRIGERAD fallback
# ===========================================================================
# Den gamla `auto`-regeln valde auktionsbas när auktion dominerade underlaget.
# Den var fel om syftet: motorn hjälper någon sälja på Blocket, och då är
# utropspriset rätt marknad även när auktionshusen har fler rader.
#
# Swedese Lamino avslöjade det: 1 834 auktionsrader mot 363 utropspriser gav
# basen `realized` och svaret 4 600 kr mot facit 8 500-12 000. Utropsmedianen
# för samma möbel är 8 000 kr.
#
# Kvoten utrop/auktion är MÄTT parvis inom (modell x möbeltyp) på 99 grupper med
# minst tio rader av varje prissort, senaste 24 månaderna. Ett globalt tal vore
# meningslöst — auktion säljer designklassiker, marknadsplatserna säljer IKEA,
# så en global kvot mäter sortiment och inte kanal.
#
#   median 1,36   p25 1,02   p75 1,65   andel där utrop > auktion: 77 %
#
#   lamino fåtölj      8 000 / 5 000  = 1,60
#   jetson fåtölj     16 900 / 11 000 = 1,54
#   sjuan stol         2 300 / 1 436  = 1,60
#   string hylla       1 800 /   850  = 2,12
#   stockholm bord     1 400 / 2 000  = 0,70   <- auktionerad IKEA-vintage
#
# Låg-klassen ligger nära 1,0 just för att auktionerad IKEA är samlarvintage
# och därför säljs ÖVER vanligt IKEA-utrop. Korrektionen per klass är därför
# mätt, inte antagen.
BASIS_PREFER_ASKING = True

#: Räcker utropspriserna till en jämförelsemängd används de. Samma golv som
#: filterkedjan, av samma skäl.
BASIS_MIN_ASKING = MIN_COMPARISON_SET

#: Multiplikator på auktionspriser när de används som fallback.
#: Uppmätt per märkesklass; None = okänt märke, då används totalmedianen.
AUCTION_CORRECTION = {"budget": 1.04, "mellan": 1.42, "premium": 1.36}
AUCTION_CORRECTION_DEFAULT = 1.36


# ===========================================================================
# SÖKNINGENS STOPPORD
# ===========================================================================
# Sökningen är KONJUNKTIV: varje ord i söknyckeln måste finnas i annonstexten.
# Ett funktionsord som `med` blir därmed ett hårt krav som halverar underlaget
# utan att identifiera någonting.
#
# Uppmätt 2026-08-18: av 632 Mio Madison-annonser innehåller bara 95 ordet
# "med". Följden var att tre formuleringar av samma fråga gav tre olika priser:
#
#   "Mio Madison med divan"     55 textträffar   ->  4 275 kr
#   "Mio Madison divan"        111 textträffar   ->  3 794 kr
#   "Mio Madison divansoffa"    30 textträffar   ->  2 968 kr
#
# Listan är EGEN och inte GENERIC_TOKENS. Den senare avgör om en förfrågan är
# anonym och innehåller därför även möbelord (`soffa`, `divan`, `ek`) — att
# stryka dem ur sökningen vore att kasta bort själva frågan. De två listorna har
# olika jobb och får inte glida ihop.
#
# Bara rena funktionsord: prepositioner, konjunktioner, artiklar. Inget ord som
# kan bära produktinformation.
#
# STATUS: teoretiskt. Urvalet är grammatiskt, inte svept mot data — men att
# orden saknar produktinformation går att läsa direkt ur listan.
SEARCH_STOPWORDS = frozenset("""
med och till fran for i pa av den det en ett som ar var samt plus
inkl inklusive samt vid under over utan om
""".split())


# ===========================================================================
# TERMUPPMJUKNING — släpp ord som svälter sökningen
# ===========================================================================
# Konjunktiv sökning utan reservväg gör att ett enda okänt ord tystar hela
# frågan. Uppmätt 2026-08-18:
#
#   matgrupp              17 386 träffar
#   Matgrupp 5 stolar        231
#   Matgrupp byCrea            0     -> inget svar alls
#
# "byCrea" finns 8 gånger i korpusen men aldrig tillsammans med "matgrupp".
# Rätt beteende är att släppa ordet och svara på "matgrupp" med redovisad
# osäkerhet — tystnad är det sämsta svaret av alla.
#
# Under så här många träffar börjar uppmjukningen. Samma tal som
# RECENCY_MIN_LISTINGS och VARIANT_STRICT_MIN, av samma skäl: under ~15 rader
# bär en kvantil inte.
#
# STATUS: teoretiskt — talet är ärvt från de andra golven, inte svept.
TERM_RELAX_MIN = int(os.environ.get("PRICE_ENGINE_TERM_RELAX_MIN", "15"))


# ===========================================================================
# KOLUMNVITLISTA VID INTAG
# ===========================================================================
# Inläsningen var TILLÅTANDE: den läste varje kolumn i filen och kastade det
# den inte kände igen. Resultatet blev att `description`, `condition_text`,
# `lat` och `lon` lästes in i minnet vid varje uppstart trots att motorn aldrig
# använde dem — och att de fanns kvar i filen på disk utan att någon valt det.
#
# Vitlistan gör inläsningen RESTRIKTIV: bara namngivna kolumner läses. En
# framtida skrapning kan därmed inte dra in fält vi inte bett om, hur många
# kolumner den än råkar innehålla.
#
# Listan byggs av COLUMN_CANDIDATES + EXTRA_TEXT_COLUMNS + de härledda
# skadeflaggorna. Att lägga till ett fält här är ett medvetet beslut med en
# rad i git; att glömma det betyder bara att fältet inte läses.
#
# tests/test_column_whitelist.py failar om en okänd kolumn passerar.
def ingest_columns() -> frozenset:
    """Kolumnnamn inläsaren får läsa. Allt annat lämnas på disk."""
    names = {name for group in COLUMN_CANDIDATES.values() for name in group}
    names.update(EXTRA_TEXT_COLUMNS)
    names.add("title_raw")           # vägs in i search_blob
    names.update(DAMAGE_COLUMNS)     # härledda, ersätter condition_text
    return frozenset(names)


#: Härledda skadeflaggor. Ersätter `condition_text`, som raderas i
#: upphovsrättssaneringen — se type_system/damage.py.
DAMAGE_COLUMNS = ("damage_wear", "damage_scratch", "damage_stain",
                  "damage_damage", "damage_crack", "damage_defect",
                  "damage_count",
                  # Gradkolumner. Tomma för den befintliga korpusen —
                  # gradadjektiven fanns i `condition_text` och försvann med
                  # den. Fylls från och med nästa skrapning; se
                  # type_system/damage.grade_columns.
                  "grade_wear", "grade_scratch", "grade_stain",
                  "grade_damage", "grade_crack", "grade_defect", "grade_max")

#: Fält som ALDRIG får läsas in, ens om någon råkar lägga till dem i
#: COLUMN_CANDIDATES. Dubbel spärr: vitlistan säger vad som släpps in, den här
#: säger vad som aldrig gör det oavsett. Skyddat material och personuppgifter.
FORBIDDEN_COLUMNS = frozenset({
    "description", "condition_text", "canonical_text",   # fritext
    "lat", "lon", "latitude", "longitude",               # GPS
    "seller", "seller_type", "seller_id", "phone", "email",
    "url", "href", "click_id", "ad_url",                 # länk till annonsen
})


# ===========================================================================
# SKADEAVDRAG
# ===========================================================================
# Arbetsdelningen som styr hela designen:
#
#   LLM:en SER och KLASSIFICERAR.  Tabellen VÄRDERAR.
#   Uppskattad lagningskostnad täcker gapet däremellan.
#
# Modellen får aldrig svara på vad en skada gör med priset — den frågan kräver
# marknadsdata den inte har. Den får svara på vad den SER (kategori, grad,
# placering) och, för skador tabellen inte känner, vad det KOSTAR ATT LAGA.
# Omvandlingen från kostnad till avdrag är vår, inte dess.
DAMAGE_PRICING = os.environ.get("PRICE_ENGINE_DAMAGE", "").lower() in (
    "1", "true", "on", "ja")

#: Tabellen som värderar. Byggs separat; tom i dag.
DAMAGE_TABLE_PATH = Path(
    os.environ.get("PRICE_ENGINE_DAMAGE_TABLE")
    or (Path(__file__).resolve().parent.parent / "config"
        / "damage_deductions.json")
)

#: Gäller ENBART den omappade vägen (`estimated_repair`). Kategorier som finns
#: i tabellen värderas alltid som ANDEL av basen — `deduction x bas` — och rör
#: aldrig någon kostnad. Se noten om `repair_cost_sek` i
#: config/damage_deductions.json.
#:
#: Höjt 1,3 -> 2,0 den 2026-08-20. Skälet är riktningen, inte precisionen:
#: kostnadsbaserade avdrag UNDERSKATTAR marknadens straff systematiskt. Köparen
#: prisar in osäkerhet ("vad mer är trasigt som inte syns på bilden?") och
#: stigma ("en möbel med fanerskada") utöver själva lagningen. Ett rent
#: kostnadspåslag på 30 % fångar bara besväret, inte de två andra.
#:
#: STATUS: **ovaliderad**. Både 1,3 och 2,0 är gissningar. 2,0 är den mindre
#: farliga gissningen eftersom felriktningen är känd — men storleken blir mätbar
#: först mot utfallsdata (såldes möbeln, till vilket pris, med vilken deklarerad
#: skada). Ingen mätning finns i dag.
REPAIR_HASSLE_FACTOR = float(os.environ.get("PRICE_ENGINE_HASSLE", "2.0"))

#: INGEN STAPLING. Totalt avdrag = det enskilt STÖRSTA avdraget bland
#: skadeposterna, oavsett kategori.
#:
#:     total = max(d_i)
#:
#: **En köpare prissätter möbelns värsta problem.** Ytterligare skador bekräftar
#: samma intryck utan att flytta priset igen: den som redan avfärdat en soffa
#: för en stor reva bryr sig inte om att det också finns en fläck, och den som
#: accepterar revan har redan gjort avkallet. Det andra felet ändrar varken
#: beslutet eller betalningsviljan.
#:
#: Ersatte den dämpade staplingen den 2026-08-20. Den byggde på att varje skada
#: bidrar med något, bara mindre och mindre — men mätningen som skulle ha visat
#: det kunde aldrig köras, och den dämpade modellen hade två egenskaper som
#: talade emot den: den nådde taket på två grova skador oavsett dämpning, och
#: den gjorde en möbel med tio ytliga repor sämre än en med en enda.
#:
#: `STACK_DECAY` är BORTTAGEN, inte satt till noll. Ett kvarlämnat värde hade
#: inbjudit till att koppla in dämpningen igen utan att beslutet omprövas; se
#: tests/test_damage_dedup.py::test_stack_decay_stays_removed.
#:
#: Taken finns kvar som skyddsnät. Med max() kan de bara lösa ut om en ENSKILD
#: tabellrad överstiger dem, vilket ingen gör i dag — de skyddar mot framtida
#: rader och mot kostnadsuppskattningar som spårar ur.

#: Tak på ett ENSKILT avdrag som kommer ur en uppskattad lagningskostnad.
#: Uppskattningen är en modellgissning om svenska hantverkspriser, och ett
#: fritt tak hade låtit en enda felgissning halvera priset.
#: STATUS: **ovaliderad**.
MAX_UNMAPPED_DEDUCTION = 0.25

#: Tak på det TOTALA avdraget oavsett källa. Under detta är möbeln ett
#: renoveringsobjekt och ska prissättas som ett sådant — inte som "fin möbel
#: minus elva skador". Att en möbel med tolv fel är värd 20 % av en hel är
#: sannolikt sant, men det är en annan prissättningsfråga än den här.
#: STATUS: **ovaliderad**.
MAX_TOTAL_DEDUCTION = 0.50

#: Grader under detta prissätts till noll — de LISTAS men kostar inget.
#: Grad 0 är "knappt synlig". AI:n ser mer än köparen bryr sig om, på samma
#: sätt som biluthyrarnas skadeskannrar hittar repor ingen människa reagerar
#: på. Att prissätta varje sådan iakttagelse gör systemet överkänsligt och
#: säljaren misstrogen.
#: STATUS: **ovaliderad** — men riktningen är ett medvetet produktval.
MATERIALITY_MIN_GRADE = 1

#: Omappade skador loggas hit. Loggen är prioriteringsordningen för vilka
#: kategorier som ska in i tabellen härnäst — taxonomin växer ur verklig
#: användning i stället för ur gissningar.
UNMAPPED_DAMAGE_LOG = Path(
    os.environ.get("PRICE_ENGINE_UNMAPPED_LOG")
    or (Path(__file__).resolve().parent.parent / "type_system"
        / "unmapped_damages.jsonl")
)


# --- Deduplicering av inkommande skador ------------------------------------
# Skadesystemet rapporterar VARJE enskild skada, även små. En normalsliten möbel
# ger därför 8-12 poster, och med staplingen skulle den alltid slå i
# 50-procentstaket — vilket gör taket till normalfallet i stället för ett
# skyddsnät, och gör alla slitna möbler lika mycket värda.
#
# Skadorna grupperas därför per kategori: en post per kategori, med gruppens
# HÖGSTA grad. Antalet redovisas men påverkar inte avdraget.
#
# Undantaget är den här regeln: så här många skador i samma kategori på samma
# möbel höjer graden ETT steg, högst till 2. Tre repor ÄR värre än en, men inte
# tre gånger värre — och skillnaden mellan tre och tio är försumbar för en
# köpare som redan bestämt sig för att möbeln är repig.
#
# STATUS: **ovaliderad**. Både att tre är rätt tröskel och att ett steg är rätt
# höjning är antaganden. Sätt 0 för att stänga av höjningen helt.
COUNT_ESCALATION_AT = int(os.environ.get("PRICE_ENGINE_DAMAGE_ESCALATE", "3"))

#: Skuggloggen: en rad per prissättning med skador. Används för att följa hur
#: ofta taket och dedupliceringen utlöser innan flaggan slås på skarpt.
DAMAGE_SHADOW_LOG = Path(
    os.environ.get("PRICE_ENGINE_DAMAGE_SHADOW")
    or (Path(__file__).resolve().parent.parent / "type_system"
        / "damage_shadow.jsonl")
)


# --- Bilden skriver formord och tillbehör ----------------------------------
# Ingen skriver "u-soffa" eller "+ fotpall" i ett sökfält. Men motorns
# cellfilter, typfilter och buntlogik hänger på just de orden: en Lamino med
# pall värderas som en pall utan dem, och en U-soffa som en vanlig soffa.
#
# Med flaggan PÅ väljer en bild-LLM ur lexikonets EGNA ordlistor
# (`form_words` och `accessory_words` i vocab.yaml) och skriver in dem i frågan.
# Resten av motorn rörs inte — den ser en fråga som råkar innehålla orden.
#
# Två påståenden med olika tillförlitlighet, se type_system/form_layer.py:
#   FORM       vad möbeln ÄR. Uppmätt 92,3 % rätt på `corner` (n=40).
#   TILLBEHÖR  vad som INGÅR. Uppmätt 100 % falskt positivt på `set_items` —
#              men den mätningen gjordes på auktionsbilder av hela rum, inte på
#              en säljares foto av sin egen möbel.
#
# Av som default tills tillbehörssidan mätts på rätt population.
FORM_VISION_ENABLED = os.environ.get("PRICE_ENGINE_FORM_VISION", "").lower() in (
    "1", "true", "on", "ja")
