"""Konfiguration för percentilstudien — ALLA trösklar bor här.

Studien mäter vilken percentil av utropsfördelningen som motsvarar priser
där affärer faktiskt sker. Den är en KUND till prismotorns sökkod: matchning,
städning och inläsning återanvänds oförändrade, aldrig återimplementerade.

Redigera fritt. Varje tröskel har sitt skäl utskrivet — ändrar du en, ändra
kommentaren också, annars tappar nästa läsare varför den ser ut som den gör.
"""

from __future__ import annotations

from pathlib import Path

# ===========================================================================
# MÄRKESKLASSER — low / mid / high end
# ===========================================================================
# Ersätter märkesnivån helt: percentiler skattas per KLASS, aldrig per
# enskilt märke. Skälet är underlag — 45 märken över 13 möbeltyper ger celler
# på en handfull försäljningar, och då mäter man bruset.
#
# Klassningen är en BEDÖMNING, inte en mätning, och det är därför den ligger
# här och inte i koden. Kriteriet är ungefärlig nyprisnivå för en soffa eller
# fåtölj i sortimentet:
#
#   low     under ~8 000 kr      volymtillverkat, säljs på pris
#   mid     ~8 000–25 000 kr     designprofil men industriell skala
#   high    över ~25 000 kr      arkitektritat, upphovsmannen är säljargumentet
#
# Designernamn ingår medvetet i `high`. Auctionet är studiens största källa och
# där står upphovsmannen ofta i titeln utan att något märke anges — utan dem
# skulle merparten av auktionsraderna falla till `price_inferred` och studien
# tappa just det segment auktionsmarknaden faktiskt bär.
#
# Gränsfall jag vägt och var de hamnade:
#   string      Designikon men lågt andrahandspris (median 550 kr) -> mid
#   muuto       Samtida dansk design, dyrare än mid-snittet -> mid, gränsfall
#   hay         Volymdesign, billigare än klassikerna -> mid, flyttad från
#               motorns "premium"
#   tempur      Teknikprodukt utan designvärde på andrahand -> mid
#   kartell     Massproducerad plast, men designsignerad -> mid, flyttad ned
#   ikea        Egen klass i praktiken, men hör hemma i low
BRAND_TIERS: dict[str, tuple[str, ...]] = {
    "low": (
        "ikea", "jysk", "mio", "ellos", "jotex", "granit", "h&m home",
        "hm home", "ahlens home", "venture home", "kungsangen", "hilding",
        "rusta", "em home", "chilli", "trademax", "furniturebox",
        "bygghemma", "coop home", "ikea of sweden",
    ),
    "mid": (
        "bolia", "boconcept", "ilva", "sweef", "string", "sofacompany",
        "muuto", "house doctor", "tempur", "sits", "broderna anderssons",
        "mavis", "furninova", "englesson", "hay", "kartell", "normann",
        "ferm living", "menu", "woud", "nordal", "hubsch", "broste",
        "mio home", "em möbler", "skeppshult",
    ),
    "high": (
        # Märken
        "fritz hansen", "&tradition", "tradition", "vitra", "gubi", "dux",
        "swedese", "carl hansen", "artek", "louis poulsen", "montana",
        "fredericia", "norrgavel", "garsnas", "lammhults", "kallemo",
        "bla station", "offecct", "skandiform", "svenskt tenn", "asplund",
        "nordiska kompaniet", "knoll", "cassina", "herman miller", "usm",
        "erik jorgensen", "getama", "pp mobler", "onecollection",
        # Upphovsmän — står ofta i titeln i stället för ett märke
        "bruno mathsson", "wegner", "arne jacobsen", "borge mogensen",
        "finn juhl", "poul kjaerholm", "alvar aalto", "josef frank",
        "yngve ekstrom", "carl malmsten", "axel einar hjorth",
        "greta grossman", "verner panton", "poul henningsen", "kaare klint",
        "nanna ditzel", "ilmari tapiovaara", "gio ponti", "charlotte perriand",
        "le corbusier", "mies van der rohe", "eames", "jean prouve",
        "alvar alto", "sigurd lewerentz", "gunnar asplund",
    ),
}

#: Ordning från billigast till dyrast — används för terciler och rapportering.
TIER_ORDER = ("low", "mid", "high")

# ===========================================================================
# BUDSPÄRR
# ===========================================================================
# Bara försäljningar med budkonkurrens räknas. Ett ensamt bud betyder att
# någon fick objektet till utropspriset — det är en likvidation, inte
# prisupptäckt, och priset säger då mer om säljarens otålighet än om marknaden.
#
# Tröskeln trappas ned PER GRUPP när underlaget inte räcker, aldrig globalt,
# och den valda tröskeln loggas i output så att en grupp på 3 bud aldrig kan
# förväxlas med en på 5.
BID_THRESHOLDS = (5, 4, 3)

#: Under så här många kvalificerade försäljningar trappas budspärren ned.
BID_STEPDOWN_BELOW = 50

# ===========================================================================
# UNDERLAGSKRAV
# ===========================================================================
#: Minsta antal försäljningar för att en grupp ska exporteras alls.
MIN_SALES_PER_GROUP = 50

#: Minsta antal matchade utropsannonser för att en percentilrang ska betyda
#: något. Under detta breddas sökningen enligt motorns egen hierarki.
MIN_ASKING_PER_MATCH = 30

#: Tradera vinner i varje grupp där den har minst så här många kvalificerade
#: försäljningar. Under det korrigeras Auctionet med kanalgapet i stället.
MIN_TRADERA_SALES = 30

# ===========================================================================
# TIDSMATCHNING
# ===========================================================================
# Marknaden föll mätbart under datans tidsspann — medianen gick från 1 167 kr
# (2024-07) till 700–750 kr (2026). En försäljning 2024 får därför ALDRIG
# jämföras med utropspriser från 2026. Fönstret är symmetriskt runt
# auktionsdatumet; försäljningar utan samtida utropsdata exkluderas helt.
TIME_WINDOW_MONTHS = 3

# ===========================================================================
# STATISTIK
# ===========================================================================
BOOTSTRAP_ITERATIONS = 1000
BOOTSTRAP_CI = 0.95
RANDOM_SEED = 20260805

#: Prisnivå inom möbeltypen: terciler.
PRICE_TIER_QUANTILES = (1 / 3, 2 / 3)
PRICE_TIER_NAMES = ("låg", "mellan", "hög")

# ===========================================================================
# UTDATA
# ===========================================================================
STUDY_DIR = Path(__file__).resolve().parent / "percentile_study"
OUTPUT_JSON = STUDY_DIR / "sell_percentiles.json"
REPORT_MD = STUDY_DIR / "RAPPORT.md"
FIGURE_DIR = STUDY_DIR / "figurer"


# ===========================================================================
# DEL A — MODELLNAMN PER MÄRKE (bryggmätningen)
# ===========================================================================
# Bryggmätningen kräver att BÅDE märke och modellnamn går att fastställa, för
# att jämförelsemängden ska bli "IKEA Landskrona" och inte "IKEA soffa".
# Kravet är hårt: en försäljning utan igenkänt modellnamn exkluderas hellre än
# späder ut mätningen.
#
# Listan är med avsikt tung på designklassiker. Det är där modellnamn faktiskt
# står i auktionstitlarna — en IKEA-soffa på Blocket heter "soffa", en Lamino
# heter Lamino. Konsekvensen är att Del A lutar mot design och premium, och
# att low end knappt finns här. Låg-endens sanning kommer från Del B.
#
# Namnen normaliseras (gemener, utan diakriter) innan matchning, precis som
# motorns egen textmatchning gör.
MODEL_NAMES: dict[str, tuple[str, ...]] = {
    # --- Volymmärken -------------------------------------------------------
    "ikea": (
        "besta", "billy", "brimnes", "ektorp", "expedit", "friheten",
        "gronlid", "hemnes", "ivar", "kallax", "karlstad", "kivik", "klippan",
        "liatorp", "lidhult", "malm", "nordli", "norsborg", "pax", "poang",
        "songesand", "stocksund", "strandmon", "soderhamn", "tarva", "vimle",
        "landskrona", "stockholm", "farlov", "vallentuna", "applaryd",
    ),
    "mio": ("madison", "kalmar"),
    # --- Svensk design -----------------------------------------------------
    "swedese": ("lamino", "laminett", "happy", "spin", "melano", "arka"),
    "yngve ekstrom": ("lamino", "laminett", "melano", "arka", "mingo"),
    "bruno mathsson": ("pernilla", "jetson", "mimat", "superellips", "karin",
                       "maria", "annika"),
    "dux": ("jetson", "kroken", "fusion", "sam", "ambassador"),
    "string": ("string", "stringhylla", "string pocket", "plex"),
    "kallemo": ("concrete", "non", "vilda"),
    "lammhults": ("sunset", "cinema", "campus", "s70"),
    "garsnas": ("chairman", "bespoke", "nanna"),
    "norell": ("ari", "merkur", "ilona", "sirocco", "safari", "pilot"),
    "carl malmsten": ("berg", "samsas", "lilla aland", "vardags", "widemar",
                      "jattepaddan", "sekelskifte"),
    "josef frank": ("liljevalch", "sallskapet"),
    # --- Dansk och finsk design -------------------------------------------
    "fritz hansen": ("sjuan", "series 7", "3107", "myran", "3100", "agget",
                     "egg", "svanen", "swan", "oxford", "grand prix",
                     "superellips", "pk22", "pk31", "pk61", "pk80"),
    "arne jacobsen": ("sjuan", "series 7", "3107", "myran", "agget", "svanen",
                      "oxford", "grand prix"),
    "carl hansen": ("ch24", "wishbone", "y-stol", "ch25", "ch07", "ch88",
                    "ch23", "shell"),
    "wegner": ("ch24", "wishbone", "y-stol", "ch25", "ge290", "papa bear",
               "valet", "ox chair", "flag halyard"),
    "borge mogensen": ("j39", "spanish chair", "hunting chair", "2213", "2209"),
    "poul kjaerholm": ("pk22", "pk31", "pk61", "pk80", "pk9", "pk24"),
    "artek": ("stool 60", "pall 60", "domus", "paimio", "402", "406", "611",
              "tank", "aalto"),
    "alvar aalto": ("stool 60", "pall 60", "paimio", "402", "406", "41", "611"),
    "fredericia": ("j39", "spanish chair", "spanine", "mogensen"),
    "getama": ("ge290", "ge258", "ge375"),
    "erik jorgensen": ("corona", "ox chair", "delphi"),
    # --- Internationell design --------------------------------------------
    "vitra": ("lounge chair", "dsw", "dsr", "lcw", "rar", "panton chair",
              "standard", "eames"),
    "eames": ("lounge chair", "dsw", "dsr", "lcw", "rar", "aluminium group"),
    "verner panton": ("panton chair", "flowerpot", "cone", "heart cone"),
    "gubi": ("beetle", "bestlite", "grasshopper", "pedrera"),
    "&tradition": ("flowerpot", "mayor", "fly", "in between", "little petra"),
    "tradition": ("flowerpot", "mayor", "fly", "in between", "little petra"),
    "hay": ("about a chair", "aac", "aal", "j77", "result", "palissade"),
    "muuto": ("fiber", "oslo", "rest", "outline", "nerd", "visu"),
    "kartell": ("louis ghost", "masters", "componibili", "bourgie"),
    "knoll": ("barcelona", "wassily", "tulip", "womb", "brno"),
    "cassina": ("lc2", "lc3", "lc4", "utrecht", "maralunga"),
    "herman miller": ("aeron", "eames lounge", "noguchi"),
    "montana": ("montana", "panton wire"),
    "louis poulsen": ("ph5", "ph 5", "artichoke", "aj", "panthella", "ph80"),
    "bolia": ("scandinavia", "sepia", "hannah", "orlando"),
}

#: Minsta antal modellmatchade utropsannonser för att en försäljning ska räknas
#: i Del A. Under detta exkluderas den — fallback-breddning får INTE användas,
#: eftersom hela poängen är att mäta mot rätt jämförelsemängd.
BRIDGE_MIN_ASKING = 20

#: Målstorlek på jämförelsemängden, motsvarande produktionens storleksordning.
BRIDGE_TARGET_RANGE = (50, 200)

BRIDGE_DIR = STUDY_DIR.parent / "bridge_study"
RELIST_DIR = STUDY_DIR.parent / "relist_study"

# ===========================================================================
# DEL B — OMLISTNINGSKEDJOR
# ===========================================================================
#: Bildlikhet för att två annonser ska anses visa samma objekt.
#: KALIBRERAD, inte gissad. Fördelningen av lägsta parvisa likhet inom
#: titelmatchade kedjor har median 0,45 — de flesta titelmatchningar är alltså
#: OLIKA möbler som råkar ha samma rubrik. 0,85 valdes för att det är där
#: utfallet vänder: under tröskeln är sänkt/höjt-kvoten ~0,9 (brus), över den
#: stiger den mot 1,3 och uppåt.
RELIST_IMAGE_SIM = 0.85

#: Titeln får förekomma på HÖGST så här många annonser i hela utropsdatan.
#: Den enskilt starkaste precisionshävstången: vid frekvens 2 är sänkt/höjt
#: 52/33, vid frekvens 11-50 är den 34/59 — alltså tvärtom, vilket betyder att
#: vanliga rubriker fångar olika möbler och inte omlistningar.
RELIST_MAX_TITLE_FREQ = 2

#: Titeln måste vara så här lång för att duga som identifierare. En kort
#: rubrik ("soffa ikea") beskriver en modell; en lång ("vitt klaffbord ikea
#: norden med tva fina vita trastolar") beskriver ett exemplar.
#: 40 tecken ger sänkt/höjt-kvot 4,2 mot 1,6 utan längdkrav.
RELIST_MIN_TITLE_LEN = 40

#: Prisändring utanför detta spann betyder sannolikt två olika objekt.
RELIST_PRICE_RATIO = (0.2, 5.0)

#: Titellikhet (Jaccard på ordmängder) när bild saknas.
RELIST_TITLE_SIM = 0.80

#: Minsta antal dagar mellan två länkar för att räknas som OMLISTNING och inte
#: som masspublicering av samma annons.
RELIST_MIN_DAYS = 3

#: Maximalt antal dagar mellan länkar — längre än så är det troligen en annan
#: möbel som råkar likna.
RELIST_MAX_DAYS = 270

#: Prisändring under detta i relativa tal räknas som oförändrat pris.
RELIST_PRICE_EPS = 0.02
