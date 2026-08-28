"""Ordlistor för attributextraktion — härledda ur korpusen, inte påhittade.

Varje form nedan är hämtad ur en frekvensräkning över `search_blob` i
`master.parquet` (1 525 135 annonser, 92 460 unika tokens). Frekvensen står som
kommentar där den är beslutsgrundande. Former under ~25 förekomster är utelämnade
om de inte täcks av ett prefix ändå.

**Korpusen är ASCII-vikt.** `_normalize_series` i data_loader kör NFKD och
kastar kombinerande tecken, så å/ä/ö är redan a/a/o i datan: `byra`, `baddsoffa`,
`schaslong`, `hornsoffa`. Allt här är därför skrivet i vikt form, och all
frågetext måste gå genom `data_loader.normalize_text` innan den matchas.

**Falska vänner är mätta, inte gissade.** `skankes` (524) och `bortskankes` (586)
betyder "ges bort" och får aldrig träffa förvaringsmöbeln *skänk*. `dagbadd`
(10 300) är en dagbädd, inte en bäddsoffa. `baddmadrass` (8 596) är en madrass.
`hornskap` (15 898), `hornbord`, `hornhylla`, `hornstol` visar att *horn* inte
implicerar soffa — hörnattributet måste tolkas i sin bastyps sammanhang.
"""

from __future__ import annotations

#: Talord -> siffra, för "tresits", "bord och fyra stolar".
NUMBER_WORDS = {
    "en": 1, "ett": 1, "tva": 2, "tre": 3, "fyra": 4, "fem": 5,
    "sex": 6, "sju": 7, "atta": 8,
}

#: Rimlighetstak. "212-sits" (38 förekomster) är ett artikelnummer, inte en soffa.
MAX_SEATS = 8
MAX_SET_ITEMS = 12

# --------------------------------------------------------------------------
# base — grov möbelfamilj. Bilden är mätt pålitlig på just denna nivå (87 %).
# --------------------------------------------------------------------------
BASE_WORDS = {
    "soffa": ("soffa", "soffor", "sofa", "divansoffa", "baddsoffa", "hornsoffa",
              "modulsoffa", "vinkelsoffa", "sittgrupp", "soffgrupp"),
    "stol": ("stol", "stolar", "fatolj", "fatoljer", "karmstol", "pinnstol",
             "barstol", "matstol", "kontorsstol", "snurrstol", "vilstol"),
    "bord": ("bord", "matbord", "soffbord", "sidobord", "skrivbord", "avlastningsbord",
             "matgrupp", "matsalsgrupp", "konsolbord", "brickbord", "spelbord"),
    "forvaring": ("byra", "hylla", "hyllor", "bokhylla", "skank", "sideboard",
                  "vitrin", "vitrinskap", "kommod", "skap", "garderob", "dragkista",
                  "buffe", "stringhylla", "vagghylla", "skohylla", "hatthylla"),
    "sang": ("sang", "sangar", "dagbadd", "sangram", "sangstomme", "vaggsang"),
    "sanggavel": ("sanggavel", "sanggavlar", "gavel"),
    "spegel": ("spegel", "speglar", "helkroppsspegel", "vaggspegel"),
    "fotpall": ("fotpall", "puff", "sittpuff", "ottoman"),
}

# --------------------------------------------------------------------------
# chaise / corner — soffans utskjutande liggdel respektive 90-gradershörn.
# Frekvenser: schaslong 24 336, divan 20 454, divansoffa 13 018, hornsoffa 19 966.
# --------------------------------------------------------------------------
CHAISE_WORDS = (
    "schaslong", "schaslonger", "schaslongsoffa", "schaslongdel", "schaslongsektion",
    "schaslongen", "schaslang", "shaslong",          # 50 resp. 50 förekomster
    "chaise", "chaiselong", "chaiselongue", "chaselong",
    "divan", "divaner", "divansoffa", "divansoffan", "divan-soffa", "divandel",
    "dubbeldivan",
)
#: Ord som ser ut som divan men är annan möbel. divanbord 42, divanfatolj 68.
CHAISE_EXCLUDE = ("divanbord", "divanfatolj", "divani")

#: Måste hållas synkad med `hornsoffa` i config/vocab.yaml. De två lexikonen
#: divergerade 2026-08-20: `u-soffa` fanns här men inte där, så samma fråga gav
#: `typer=[]` i cellfiltret och `hornsoffa` i attributkedjan. Två lexikon oense
#: om samma ord ger fel som inte syns i något enskilt test.
#: tests/test_lexicon_sync.py låser dem.
CORNER_WORDS = (
    "hornsoffa", "hornsoffan", "hornsektion", "horndel", "hornmodul",
    "hornbaddsoffa", "horngrupp", "vinkelsoffa", "l-soffa", "lsoffa", "u-soffa", "usoffa", "u-formad", "dubbeldivan")
#: Ord som bara får matcha från tokenets BÖRJAN, aldrig som delsträng inuti det.
#:
#: `lsoffa` finns för att fånga "L-soffa" utan bindestreck. Som delsträng matchar
#: den i stället inuti haLSOFFA, moduLSOFFA och paneLSOFFA — **1 286 annonser i
#: korpusen mot 103 äkta L-soffor**. Facit blev därmed fel tolv gånger oftare än
#: det blev rätt, och en vision-mätning tillskrev modellen fyra fel som var mina.
#:
#: Samma buggklass som `ej` inuti *v-ej-lby* i negationsspärren. Svensk
#: sammansättning kräver delsträngsmatchning för de flesta ord, men korta former
#: som råkar vara ändelser i andra ord måste ankras.
PREFIX_ONLY = frozenset({"lsoffa", "u-soffa"})

#: Ord som betecknar TVÅ hörn, inte ett. En U-soffa har divan i båda ändar och
#: ligger indikativt 1,43x en enkelhörnad — men `corner` var en boolean, så U
#: och L kollapsade till samma typ och premien var osynlig även när annonsen
#: skrev ut ordet. Se `corner_count` i attributes.py.
#:
#: STATUS: premien är **indikativ**, mätt MELLAN modeller (noll modellgrupper
#: har >=3 av varje sort). Nivån ska inte användas för prissättning förrän ny
#: data finns — attributet styr bara jämförelsemängden.
DOUBLE_CORNER_WORDS = ("u-soffa", "usoffa", "u soffa", "u-formad", "u formad",
                       "dubbeldivan", "dubbel divan")

#: "horn" ensamt är tvetydigt — hornskap 15 898 är ett skåp. Kräver soffkontext.
CORNER_AMBIGUOUS = ("horn",)
CORNER_NOT_SOFA = ("hornskap", "hornbord", "hornhylla", "hornstol", "hornstolar",
                   "hornvitrinskap", "hornvitrin", "horngarderob", "hornbokhylla",
                   "hornskrivbord", "hornhangskap", "hornvaggskap", "hornhyllor",
                   "hornhyllplan", "hornfatolj", "horndusch", "hornfleuroner")

# --------------------------------------------------------------------------
# chair_kind — fåtölj mot stol. MÄTT 2,60x (160 % skillnad, 1 973 modellgrupper,
# KI [2,50, 2,67]) — den största enskilda prisskillnaden i hela systemet.
#
# Den gamla taxonomin skiljde dem; den nya gjorde det inte, eftersom
# prisrelevansen aldrig prövats. Mätningen visade att sammanslagningen hade
# underprissatt varje fåtölj med 61 %.
# --------------------------------------------------------------------------
CHAIR_KINDS = {
    "fatolj": ("fatolj", "fatoljer", "lansstol", "vilstol", "oronlappsfatolj",
               "snurrfatolj", "laselfatolj"),
    "stol": ("stol", "stolar", "matstol", "koksstol", "pinnstol", "karmstol",
             "matsalsstol"),
}
#: Sittmöbler som varken är fåtölj eller matstol i prismening.
CHAIR_EXCLUDE = ("barnstol", "barstol", "kontorsstol", "skrivbordsstol",
                 "stolsdyna", "stolkladsel", "stolsben")

# --------------------------------------------------------------------------
# convertible — bäddfunktion. baddsoffa 44 402.
# Bilden kan aldrig avgöra detta; en ihopfälld bäddsoffa ser ut som en soffa.
# --------------------------------------------------------------------------
CONVERTIBLE_WORDS = (
    "baddsoffa", "baddsoffan", "baddsoffor", "baddsofa", "hornbaddsoffa",
    "u-baddsoffa", "baddbar", "baddfunktion", "utfallbar", "utfallbart",
    "utfallbara", "sovsoffa", "gastsoffa", "baddmodul", "baddfatolj",
)
#: Bädd-ord som INTE betyder bäddsoffa. dagbadd 10 300, baddmadrass 8 596.
CONVERTIBLE_EXCLUDE = (
    "dagbadd", "dagbaddar", "dagbaddstomme", "dagsbadd", "daggbadd",
    "baddmadrass", "baddmadrasser", "baddmadras", "baddmadra", "baddmadr",
    "baddset", "baddmatt", "solbadd", "hundbadd", "skotbadd", "extrabadd",
    "dubbelbadd", "baddsang", "baddpall", "stjarnbadden", "kinnabadden",
    "framatbaddad", "langsbaddad",
)

# --------------------------------------------------------------------------
# storage_kind — byra 194 679, vitrinskap 90 945, bokhylla 80 076,
# sideboard 66 405, hylla 63 716, skank 58 365, kommod 14 710.
# --------------------------------------------------------------------------
STORAGE_KINDS = {
    "byra": ("byra", "byraer", "byraar", "byran", "kommod", "dragkista",
             "spegelbyra", "hallbyra", "herrbyra", "teakbyra", "klaffbyra",
             "skrivbyra", "malmbyra"),
    "hylla": ("hylla", "hyllor", "bokhylla", "bokhyllor", "vagghylla", "vagghyllor",
              "stringhylla", "skohylla", "hatthylla", "tidningshylla", "kryddhylla",
              "forvaringshylla", "hornhylla", "glashylla", "teakhylla", "overhylla"),
    "skank": ("skank", "sideboard", "buffe", "skankskap", "spegelskank"),
    "vitrin": ("vitrin", "vitrinskap", "vitrindel", "vitrinoverdel", "hornvitrinskap",
               "hornvitrin", "vitrindorrar"),
}
#: "skänkes"/"bortskänkes" = ges bort. 524 + 586 förekomster. Aldrig möbeln.
STORAGE_EXCLUDE = ("skankes", "bortskankes", "skanker", "skankt", "skankas")

# --------------------------------------------------------------------------
# sub — bordets undertyp.
# --------------------------------------------------------------------------
TABLE_SUBS = {
    "matbord": ("matbord", "matsalsbord", "koksbord"),
    "soffbord": ("soffbord", "salongsbord"),
    "sidobord": ("sidobord", "avlastningsbord", "lampbord", "brickbord", "hallbord"),
    "skrivbord": ("skrivbord", "sekretar", "datorbord"),
    "matgrupp": ("matgrupp", "matgruppen", "matgrupper", "matsalsgrupp",
                 "matbordsgrupp", "utematgrupp"),
}

# --------------------------------------------------------------------------
# Negationer. "passar till divan", "säljes utan schäslongdel".
# Fönstret är litet med flit: svenska negationer står tätt intill sitt huvudord.
# --------------------------------------------------------------------------
NEGATION_CUES = ("utan", "ej", "inte", "ingen", "inget", "saknar", "passar till",
                 "till en", "sokes", "onskas", "kopes")
NEGATION_WINDOW = 3
