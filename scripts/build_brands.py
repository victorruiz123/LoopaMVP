"""Bygger märkeslistan till väljaren ur prismotorns egen korpus.

Två källor, i den ordningen:
  1. Kolumnen `brand` — 116 märken korpusen redan är taggad med. De tas ALLA med,
     oavsett antal: de är taggade, alltså verkliga.
  2. En kandidatlista över kända möbelmärken, MÄTT mot annonstexten. Bara de som
     faktiskt har underlag följer med — ett märke i väljaren som prismotorn inte
     hittar en enda annons för är ett löfte vi inte kan hålla.

Räkningen sker på ordgräns, inte delsträng. Prismotorn själv matchar delsträng,
men som MÄTMETOD är det värdelöst här: "sits" är både ett märke och ordet i
"3-sits", och delsträngsräkning hade gett det hundratusen träffar. Ordgräns
underskattar sammansättningar ("stringhylla") och det är rätt håll att fela åt.
"""
import json, re, sys, unicodedata
from collections import Counter
import pandas as pd

sys.path.insert(0, "/Users/test/loopa-condition/Price_engine/Price_engine")
from price_engine.data_loader import normalize_text

MIN_LISTINGS = 15

CANDIDATES = """
IKEA|Mio|Jysk|Ellos|Jotex|Granit|Rusta|Åhléns Home|H&M Home|Hemtex|DesignTorget
Svenskt Tenn|Norrgavel|Stolab|Swedese|Källemo|Gärsnäs|Lammhults|Blå Station|Offecct
Materia|Kinnarps|EFG|Edsbyn|String|String Furniture|Maze|Essem Design|Asplund
Design House Stockholm|Zweed|Sweef|Sofacompany|Bolia|BoConcept|Ilva|Furninova
Bröderna Anderssons|Englesson|Engelsson|Mavis|Ire Möbel|Dux|Hästens|Carpe Diem Beds
Viking Beds|Jensen|Tempur|Hilding|Kungssängen|Sängfabriken|Ekornes|Stressless
Fogia|Massproductions|Nola|Skandiform|Karl Andersson & Söner|Johanson Design|Mitab
Ekens|Layered|Chhatwal & Jonsson|Venture Home|EM Home|Furniturebox|Chilli|Trademax
Nordiska Galleriet|Artilleriet|Olsson & Jensen|Confident Living|Rowico|Torkelson
Brdr Krüger|Fritz Hansen|&Tradition|Hay|Gubi|Muuto|Normann Copenhagen|Ferm Living
Menu|Audo Copenhagen|Montana|Fredericia|Carl Hansen|Erik Jørgensen|Eilersen|Getama
Skagerak|Woud|House Doctor|Bloomingville|Nordal|Broste Copenhagen|By Lassen|Verpan
Louis Poulsen|Le Klint|Artek|Iittala|Marimekko|Vitra|Kartell|Alessi|Magis|Flos
Foscarini|Cassina|B&B Italia|Poliform|Molteni|Minotti|Zanotta|Arper|Pedrali|Knoll
Herman Miller|Fatboy|Hem|Vipp|Frama|New Works|Umage|Eva Solo|Stelton|Georg Jensen
Bruno Mathsson|Bruksbo|Dansk Møbelkunst|Duxiana|Elfa|Mimou|Mille Notti|Newport
Slettvoll|Rivièra Maison|Flexform|Ligne Roset|Roche Bobois|Natuzzi|Himolla|Rolf Benz
Walter Knoll|Thonet|Wilkhahn|USM|Interstil|Interface|Martela|Isku|Piiroinen|Nikari
Vaarnii|Hakola|Adea|Made By Choice|Nikari|Lundbergs Möbler|Bruno Mathsson International
Garsnas|Voice|Trybe|Almedahls|Klippan Yllefabrik|Ljungbergs|Kasthall|Dixie|Sika Design
Gotessons|Abstracta|Glimakra|Horreds|Blastation|Nc Nordic Care|Swedish Fur|Zeitraum
Bruunmunch|Bolia Home|Hans J Wegner|Arne Jacobsen|Alvar Aalto|Verner Panton|Yngve Ekström
Josef Frank|Carl Malmsten|Bruno Mathsson|Nirvan Richter|Note Design|Front|Claesson Koivisto Rune
"""

def fold(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()

df = pd.read_parquet(
    "/Users/test/loopa-condition/Price_engine/Price_engine/.cache/listings-05c12a0edc75a368.parquet",
    columns=["brand", "search_blob"],
)

# --- källa 1: korpusens egna taggade märken -------------------------------
raw = df["brand"].fillna("").astype(str).str.strip()
tagged = raw[raw != ""].value_counts()

# --- källa 2: kandidaterna, mätta mot annonstexten -------------------------
# Mätt på ett stickprov och skalat upp. En exakt räkning per märke krävde ett
# eget svep över 1,5 miljoner rader per kandidat och tog längre tid än den var
# värd — det som avgör om ett märke hör hemma i väljaren är storleksordningen,
# inte sista siffran.
SAMPLE = 400_000
sample = df["search_blob"].fillna("").astype(str)
if len(sample) > SAMPLE:
    sample = sample.sample(SAMPLE, random_state=7)
scale = len(df) / len(sample)
text = "\n".join(sample.tolist())
tokens = Counter(re.findall(r"[a-z0-9&]+", text))

candidates = [c.strip() for line in CANDIDATES.strip().splitlines() for c in line.split("|") if c.strip()]

#: Märken som stavas precis som ett vanligt möbelord, där textmätningen därför räknar
#: något helt annat än märket. Bara ett fall i dagens korpus: "Sits" mäts till 62 568
#: annonser mot 104 taggade — kvoten 0,07 mot en taggningsgrad på 2,3 %, alltså räknar
#: mätningen "3-sits". För dem används kolumnräkningen, som är liten men verklig.
#:
#: Designer- och arvsnamn som Bruno Mathsson och Svenskt Tenn har liknande låga kvoter
#: men står KVAR på sin textmätning: de nämns oftare i annonstext än korpusen bryr sig
#: om att tagga dem, och det är riktig signal, inte en krock.
WORD_COLLISIONS = {"sits"}


def support(display: str) -> int:
    """Hur många annonser MÄRKET nämns i, mätt på annonstexten."""
    if fold(display) in WORD_COLLISIONS:
        return int(tagged.get(display, 0))
    needle = normalize_text(display)
    if not needle:
        return 0
    parts = needle.split()
    if len(parts) == 1:
        return int(tokens.get(parts[0], 0) * scale)
    # Flerordsmärken är specifika nog att räknas som delsträng.
    return int(text.count(needle) * scale)


# Antalet mäts på SAMMA sätt för alla, taggade som kandidater. Att i stället låta de
# taggade bära sin kolumnräkning gjorde sorteringen obrukbar: kolumnen är ifylld på
# 2,3 % av korpusen, så IKEA:s 19 783 taggade rader hamnade under en designer med
# 33 000 textomnämnanden. Två olika skalor i samma sortering är ingen sortering.
out: dict[str, dict] = {}
for display in tagged.index:
    # Taggade märken följer alltid med, oavsett antal — de är taggade, alltså verkliga.
    out[fold(display)] = {"name": display, "listings": support(display), "source": "tagged"}

for display in candidates:
    key = fold(display)
    if key in out:
        continue
    n = support(display)
    if n >= MIN_LISTINGS:
        out[key] = {"name": display, "listings": n, "source": "measured"}
    else:
        print(f"  utelamnat (n={n}): {display}", file=sys.stderr)

# Ord som ÄR märken men vars räkning domineras av det vanliga svenska ordet.
# Kvar i väljaren blir de bara förvirrande: en säljare som väljer "Hem" får en
# textsökning på "hem" och därmed skräp tillbaka.
AMBIGUOUS = {"hem", "voice", "front", "interface"}
# Samma märke två gånger, en gång per stavning. Korpusens tagg vinner INTE här:
# "Engelsson" är korpusens felstavning av Englesson, och "Kungssängen" är vår
# felstavning av korpusens KungSängen.
DUPLICATES = {"engelsson", "kungssangen", "bruno mathsson international"}

rows = [r for r in out.values() if fold(r["name"]) not in AMBIGUOUS | DUPLICATES]
rows.sort(key=lambda r: (-r["listings"], r["name"].lower()))

lines = [
    "// GENERERAD FIL — ändra inte för hand. Byggs om med:",
    "//   Price_engine/Price_engine/.venv/bin/python scripts/build_brands.py > web/src/lib/brands.ts",
    "//",
    "// Märken prismotorn faktiskt har underlag för. Medlemskapet har två källor: korpusens egen",
    "// `brand`-kolumn (116 märken, tas alla med) och en kandidatlista över kända möbel- och",
    "// designnamn, som utelämnas när de saknar träffar. Ett märke i väljaren som motorn inte",
    "// hittar en enda annons för vore ett löfte vi inte kan hålla.",
    "//",
    "// `listings` är MÄTT PÅ ANNONSTEXTEN för alla, aldrig ur `brand`-kolumnen: kolumnen är ifylld",
    "// på 2,3 % av korpusen, och en sortering som blandade de två skalorna la IKEA under en",
    "// designer med färre annonser. Talet är ett stickprov uppskalat — en storleksordning, inte",
    "// en exakt räkning.",
    "//",
    "// Designernamn (Carl Malmsten, Arne Jacobsen, ...) står med flit i samma lista: prismotorn",
    "// söker i en textklump som innehåller designerkolumnen, och på vintagemöbler ÄR designern",
    "// det annonsen säljs under.",
    "",
    "export interface KnownBrand {",
    "  name: string;",
    "  /** ungefärligt antal annonser i prismotorns korpus — styr sorteringen i väljaren */",
    "  listings: number;",
    "}",
    "",
    "export const KNOWN_BRANDS: KnownBrand[] = [",
]
for r in rows:
    lines.append(f'  {{ name: {json.dumps(r["name"], ensure_ascii=False)}, listings: {r["listings"]} }},')
lines.append("];")
lines.append("")
print("\n".join(lines))
print(f"{len(rows)} märken skrivna", file=sys.stderr)
