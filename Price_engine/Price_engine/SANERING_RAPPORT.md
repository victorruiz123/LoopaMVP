# Saneringen genomförd — och percentilbytet

Utfört 2026-08-18/19. **491 tester passerar.** 8 372 MB raderat.

---

## Klartext

Saneringen är genomförd i alla sju steg. **Ingen förändring i motorns svar beror
på raderingen** — varje avvikelse i benchmarken spårar till sökändringarna från
det föregående paketet, och det är verifierat per möbel, inte antaget.

Två saker gick inte som planerat och rapporteras därför särskilt: en regression i
termuppmjukningen som jag hittade under verifieringen och rättade, och att
percentilbytet till p45 **kostar 2,9 procentenheter träffsäkerhet men tar bort
1–2 katastrofmissar**. Det andra är en avvägning du bör känna till, inte ett
misslyckande.

---

## Steg 1 — Skadeflaggor extraherade

`type_system/damage.py`, **23 tester**. Ordlistorna är byggda ur datan: de 40
vanligaste orden i 80 000 skicktexter räknades fram först.

| flagga | rader | andel |
|---|---|---|
| `damage_wear` | 390 054 | 25,6 % |
| `damage_damage` | 202 399 | 13,3 % |
| `damage_scratch` | 112 592 | 7,4 % |
| `damage_stain` | 107 804 | 7,1 % |
| `damage_defect` | 51 636 | 3,4 % |
| `damage_crack` | 42 730 | 2,8 % |

**Täckning: 94,3 %** av de 470 278 ifyllda skicktexterna fick minst en flagga.
De 26 748 oflaggade är i allt väsentligt genuint oskadade — "No remarks", "Bra
skick", "Renoverad och kompletterad".

### Två beslut under vägen

**`marke`/`märken` krävde ordgränsmatchning.** Ordet är det tredje vanligaste
(20 966 förekomster) och är ett äkta skadeord — men som delsträng träffar det
inuti *varumärke*, *markering* och *marknad*. Samma buggklass som `lsoffa` inuti
*hallsoffa*. Med ordgräns steg täckningen 93,3 % → 94,3 % utan falska positiva.

**Negation hanteras inte, och det är dokumenterat.** "Inga märken" flaggas som
skada. Förekomsten är uppmätt till **2,0 %** av de ifyllda raderna (`inga` 709,
`ingen` 1 234, `utan` 374, `ej` 6 982 — och `ej` är oftast "ej signerad"). Jag
valde bort negationshantering medvetet: den skulle själv behöva valideras, och
flaggorna är råmaterial för en framtida skickmodell, inte ett prisavdrag. En
falsk flagga kostar inget i dag; en förlorad signal är oåterkallelig när
fritexten är borta.

---

## Steg 2 — Skyddat material raderat

### master.parquet

1 526 119 rader **oförändrat**. Tre kolumner borta (`description`,
`condition_text`, `canonical_text`), sju skadeflaggor tillagda: 37 → 41
kolumner. Filen skrevs till en ny fil som verifierades på radantal och
kolumninnehåll innan den ersatte originalet — ingen redigering på plats.

### Rå-NDJSON, 20 filer

| fält | förekomster raderade |
|---|---|
| `description` | **3 728 139** |
| `href` | 1 946 018 |
| `click_id` | 1 946 018 |
| `condition_text` | 1 728 658 |
| `url` | 1 602 297 |
| `lat` | **202 539** |
| `lon` | **202 539** |
| `seller_type` | 202 539 |

**Samtliga GPS-koordinater är borta.** De låg på 100 % av blocket-raderna och var
den tyngsta personuppgiften i materialet.

---

## Steg 3 — Bildfilerna raderade

| mål | filer | MB |
|---|---|---|
| `.cache/images` | **94 356** | 5 511 |
| `.cache/vectors/crops` | 30 | 1 |
| `benchmark/bilder_*` | 52 | 141 |
| `image_pairs/*.jpg` | 41 | 6 |
| föråldrade `listings-*.parquet` | 20 | 2 713 |
| **summa** | | **8 372** |

**Behållet:** 93 230 DINOv2-vektorer, färghistogram, FAISS-index, 1 237 855
bild-URL:er, samt sju facit- och analysfiler i `image_pairs/` och alla
`items_*.json` / `images_*.json` i `benchmark/`.

Kvarvarande bildfiler i projektet: **nio matplotlib-diagram** ur egna studier.
Inga annonsbilder.

**Konsekvens att känna till:** benchmarkens lägen B och D (med bild) går inte
längre att köra. `images_*.json` pekar på raderade sökvägar. Bilderna kan
återskapas ur PDF:erna med `extract_benchmark_specs.py --images` om de behövs.

---

## Steg 4 — `marketplace-datasets/` inventerat (inget raderat)

Allt är **ett enda dataset**: `avito/`, 10 GB.

| fil | storlek | innehåll | klass |
|---|---|---|---|
| `train_jpg_0.zip` | **9,9 GB** | annonsbilder i zip | **SKYDDAT** |
| `train.csv.zip` | 318 MB | annonstext | **SKYDDAT** |
| `avito_mobler_full.parquet` | 17 MB | 65 035 rader med **`user_id`**, `description`, `region`, `city` | **BLANDAT + PII** |
| `avito_mobler.parquet` | 1,6 MB | 65 035 rader, utan user_id | BLANDAT |
| `avito_img_emb.npz` | 24 MB | bildvektorer | HÄRLETT |

### Saneringsförslag: radera allt utom eventuellt vektorfilen

Fyra skäl, i fallande styrka:

1. **Används av ingen kod.** `grep` över hela repot ger noll träffar på `avito`
   eller `marketplace-datasets`.
2. **Fel marknad.** Ryska radannonser från 2018 säger ingenting om svenska
   möbelpriser 2026. Datasetet kan inte bidra till motorn.
3. **`user_id` är en direkt personidentifierare** i 65 035 rader, tillsammans
   med `description`, `region` och `city`.
4. **Licensen är sannolikt fel.** Detta är Kaggles Avito Demand Prediction
   Challenge. Tävlingsdata har normalt villkor som begränsar användningen till
   tävlingen — inte kommersiell återanvändning.

`avito_img_emb.npz` (24 MB vektorer) är härlett och kan behållas om du vill, men
utan bilderna och utan användning är även den värdelös. **Mitt förslag: radera
hela katalogen, 10 GB.** Jag har inte gjort det — du bad om förslag först.

---

## Steg 5 — Kolumnvitlistan

`config.ingest_columns()` — 57 tillåtna kolumnnamn — plus `FORBIDDEN_COLUMNS`
med 16 namn som aldrig släpps in oavsett vitlistan. Dubbel spärr, eftersom det är
lättare att glömma varför ett fält är förbjudet än att glömma att man tagit bort
det ur två listor.

Inläsningen är därmed **restriktiv** i stället för tillåtande. `tests/test_column_whitelist.py`
har **6 tester** som failar om en okänd kolumn passerar, inklusive ett som körs
mot den riktiga korpusen.

### En rättelse av min egen inventering

Jag skrev i `UPPHOVSRATT_INVENTERING.md` att "därför följde `description`, `lat`
och `lon` med **in**". Det var oprecist. `_standardize` byggde redan bara de
kanoniska kolumnerna, så fälten nådde aldrig `listings` — de **lästes in i
minnet** vid varje uppstart och kastades sedan. Skillnaden spelar roll för hur
allvarligt läget var: motorn har aldrig haft dem, filen på disk hade dem.

Vitlistans faktiska vinst är alltså (a) de läses inte längre in alls, och (b)
beteendet är låst av test i stället för att vila på att `_standardize` råkar vara
skriven som den är.

---

## Steg 6 — Verifiering

### Testsviten

**491 tester passerar.** Ökningen från 462 är 23 skadetester + 6 vitlistetester.

### Benchmarken: ingen avvikelse beror på saneringen

Fyra möbler ändrade svar mellan `bench6` och den sanerade körningen. Jag körde
var och en med diagnostik för att se orsaken:

| möbel | ändring | orsak |
|---|---|---|
| Kinnarps Capella X | 1 480 → 458 | **Del B** släppte `capella` |
| Bolia soffa med puff | 5 681 → 6 680 | **Del A** strök `med` |
| Matgrupp byCrea | inget svar → 1 000 | **Del B** släppte `bycrea` |
| DUX säng 303 | inget svar → 1 000 | **Del B** släppte `303` |
| IKEA karlstrand | inget svar → inget svar | oförändrad |

**Samtliga spårar till Del A/B från föregående paket, inget till saneringen.**
Baslinjen `bench6` kördes före de ändringarna, vilket är varför den naiva
jämförelsen såg ut som en försämring.

### En regression jag hittade och rättade

Kinnarps-fallet var inte väntat. `capella` har **188 egna träffar**, långt över
uppmjukningens golv på 15 — det släpptes ändå, för att jag sorterade
*sällsyntast först* även bland modellnamn.

Det är bakvänt. Bland identifierande ord är det sällsynta mest värdefullt; det
vanliga ordet ska släppas först. Rättat: nivå 2 sorterar nu på fallande frekvens.

```
före:  Kinnarps Capella X -> släppte 'capella' -> 458 kr
efter: Kinnarps Capella X -> släppte 'x'       -> 2 192 kr
```

Facit är 1 300–1 600, så det är fortfarande en miss — men 2 192 mot 458 är
skillnaden mellan ett dåligt svar och ett katastrofalt.

---

## Steg 7 — README rättad

Tre falska påståenden rättade, inte bara borttagna:

1. **`config.IMAGE_CACHE_DIR`** sa att cachen är temporär och "rensas explicit"
   och att vi "aldrig sparar bilder permanent". Noten står nu kvar med
   rättelsen inskriven — 94 356 filer låg kvar i fyra månader.
2. **`config.VECTOR_DIR`** sa "Vi sparar ALDRIG annonsbilderna". Omformulerat
   till en beskrivning av nuläget i stället för ett processlöfte som inte hölls.
3. **README:s bildjobb** markerar nu steg 3 som obligatoriskt, med en not om
   varför.

Nytt README-avsnitt **"Vad systemet håller — och inte håller"** med exakta
siffror, avsett att kunna citeras rakt av.

---

## Percentilbytet: p40 → p45

### Frikopplingen var nödvändig

`HALF_INTERVAL_RATIO = 0.10` styrde **både** startläget och högerkanten. Att
sänka den till 0,05 hade gett p45 **och** flyttat `high` från p60 till p55 —
alltså ett smalare intervall du inte bett om. Ny konstant
`DEFAULT_OFFSET_RATIO = 0.05` styr bara startläget; `low` och `high` står kvar på
p30 och p60.

En bugg hittades av testsviten på vägen: den **viktade** kvantilvägen räknade
fortfarande p40 medan positionsvägen räknade p45. De hade glidit isär med tre
positioner. Rättat.

### Utfallet

| läge | p40 | p45 | diff | bredd p40 → p45 | katastrofer p40 → p45 |
|---|---|---|---|---|---|
| A | 54,3 % | 54,3 % | ±0 | 130 % → 122 % | **8 → 6** |
| B | 54,3 % | 51,4 % | −2,9 | 128 % → 119 % | **8 → 6** |
| C | 54,3 % | 51,4 % | −2,9 | 115 % → 107 % | **7 → 5** |
| D | 57,1 % | 54,3 % | −2,9 | 123 % → 115 % | **7 → 6** |

Bara **en** möbel bytte träffstatus i läge D: IKEA Ektorp 900 → 1 000 mot facit
400–900, alltså en kantmiss.

Felbalansen förbättrades: 13 för lågt / 1 för högt → **12 / 3**.

### Vad du bör veta om avvägningen

p45 **kostar 2,9 procentenheter träffsäkerhet och tar bort 1–2 katastrofmissar**
per läge, samtidigt som intervallen blir 8 procentenheter smalare.

Ditt eget tidigare direktiv säger att en katastrofmiss skadar förtroendet mer än
tio små missar. Mätt mot det är bytet en förbättring, inte en försämring — men
den siffra som rapporteras utåt går ned.

Konstanten är märkt **"beslutat, inte mätt"** i konfigurationen, med en not om
att den befintliga mätningen pekar åt andra hållet (p40 gav 57,1 % mot p50:s
51,4 % i den isolerade jämförelsen). Det är ett produktbeslut om vad `default`
ska LOVA — "pris som säljer" mot "marknadens mitt" — inte en optimering mot
facit, och det ska stå så.

---

## Vad som återstår

- **`marketplace-datasets/` (10 GB)** — förslag lämnat, inget raderat.
- **Time Machine och iCloud** ligger utanför min räckvidd. Att radera lokalt
  medan en backup bevarar `.cache/images` är ingen radering. **Verifiera själv.**
- **Benchmarkens bildlägen** kan inte köras förrän bilderna återskapats ur
  PDF:erna.
- **PDF:erna** (193 MB med skärmbilder av verkliga annonser) ligger kvar i
  `/Users/test/Price_engine/`. De är källan till facit och togs inte med i
  raderingen — flytta dem ur repot när du vill.
