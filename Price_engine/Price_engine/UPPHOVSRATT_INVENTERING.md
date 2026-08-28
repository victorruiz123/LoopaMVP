# Upphovsrättsinventering

Inventerat 2026-08-18. **Ingen radering utförd.** Motorn orörd, 462 tester
passerar oförändrat.

---

## Klartext: vad vi håller och var det skyddade ligger

**Systemet håller cirka 34 GB.** Motorn i drift läser 18 av 37 kolumner i
`master.parquet`, och samtliga 18 är fakta eller strukturerade fält. Det
skyddade materialet ligger utanför driftvägen — men det ligger kvar.

### Det allvarligaste fyndet

**`.cache/images` innehåller 94 356 riktiga JPEG-filer, 5,3 GB.**

Både README och `config.py` påstår att bildcachen är temporär och "rensas
explicit". **Det har inte skett.** Filerna är från 2026-08-04 och ligger kvar.
Det är en pågående exemplarframställning av 94 356 fotografier, och det är den
enskilt största exponeringen i hela inventeringen.

Ytterligare 30 beskurna JPEG i `.cache/vectors/crops` (1 MB) och 52 bildfiler i
`benchmark/` (utdrag ur PDF:erna, foton av möbler i privata hem).

### Det näst allvarligaste

**GPS-koordinater på 100 % av raderna** i
`blocket-harvester/blocket_listings.ndjson`. Fältet `lat`/`lon` finns i varje
rad, tillsammans med `seller_type` och `url` till annonsen. Ingen av dem läses
av motorn. Koordinater till en privatpersons bostad är en tyngre
personuppgift än allt annat i inventeringen.

### Det som är försvarbart

| kategori | omfattning | status |
|---|---|---|
| Faktafält (pris, datum, märke, modell, typ, mått) | 18 kolumner, 1,5 M rader | **behålls** |
| Rubriker (`title_norm`, `title_raw`) | 100 %, median **27 tecken** | behålls — korta produktbeteckningar, svagt verkshöjd |
| DINOv2-vektorer + färghistogram | 94 305 vektorer, 315 MB | **behålls** — inte en kopia av bilden |
| Härledda aggregat (multiplikatorer, percentiler, priori, vitlista) | ~5 MB JSON | behålls |

### Det som kan raderas — och vad det kostar

| artefakt | storlek | kostnad att radera |
|---|---|---|
| `.cache/images` (94 356 JPEG) | **5,3 GB** | **Ingen för dagens motor.** Vektorerna är redan utvunna. Kostnad: SigLIP-märkning och ArcFace-träning blir omöjliga utan att hämta om. |
| `.cache/vectors/crops` | 1 MB | ingen — mellansteg |
| `lat`/`lon`, `seller_type`, `url`, `href` i rå-NDJSON | del av 2,2 GB | ingen — läses av inget |
| `description` (master, 4,9 %, kapad vid 160 tecken) | ~11 MB | ingen — är återförsäljarnas marknadstext, inte säljartext |
| `condition_text` (30,8 %, 470 278 rader) | ~16 MB | **STOR — se nedan.** |
| 17 föråldrade `listings-*.parquet`-cachar | 2,2 GB | ingen — varje fil är en fullständig textkopia av korpusen |

### Den enda verkliga extraktionsskulden

**`condition_text` är helt outnyttjad och innehåller skadeinformation som inte
finns någon annanstans:**

```
slitage   372 274 rader        repor    111 103
fläck      94 470              skadad    67 410
spricka     8 302              nagg       5 252
defekt      1 973              trasig     1 744
```

Raderas fältet innan detta extraheras förlorar en framtida skickmodell sitt
enda underlag. **Extraktionen måste köras före radering** — den är en
ordlisteskanning över 470 278 korta strängar, alltså minuter, inte timmar.

---

## Del 1 — Inventering

### Rådata

| sökväg | storlek | rader/filer | klass | används av |
|---|---|---|---|---|
| `vips-fas0/master.parquet` | 156 MB | 1 526 119 rader, 37 kol | **BLANDAT** | **motorn i drift** (18 kol) |
| `vips-fas0/prod_full/auctionet_sold_full.ndjson` | **7,3 GB** | 22 nycklar | HÄRLETT + BLANDAT | inget |
| `vips-fas0/ml/*.ndjson` (4 filer) | 1,3 GB | | BLANDAT | inget |
| `vips-fas0/prod_auctionet_sold.ndjson` | 292 MB | | BLANDAT | inget |
| `vips-fas0/features_full.parquet` | 348 MB | | HÄRLETT | inget |
| `vips-fas0/vips_new_corpus.hnsw` | **6,9 GB** | | HÄRLETT (index) | inget |
| `vips-fas0/clip_vitb32.bin` | 605 MB | | HÄRLETT | inget |
| `vips-fas0/*.joblib` (11 filer) | 700 MB | | HÄRLETT (ML) | inget — "glöm ML-modellerna" |
| `allaannonser-harvester/*.ndjson` | 1,3 GB | | **BLANDAT** (description) | inget |
| `blocket-harvester/*.ndjson` | 226 MB | | **BLANDAT + GPS** | inget |
| `auctionet-harvester/`, `tradera-harvester/` | 132 MB | | BLANDAT | inget |
| `marketplace-datasets/` | **10 GB** | | okänt — ej inventerat i detalj | inget |

`prod_full`-filens 7,3 GB är till största delen fältet `embedding` (19 216
tecken per rad, alltså en JSON-serialiserad vektor) — HÄRLETT, inte skyddat.

### Cache och arbetskataloger

| sökväg | storlek | innehåll | klass | används |
|---|---|---|---|---|
| **`.cache/images`** | **5,3 GB** | **94 356 JPEG** | **SKYDDAT** | **inget — skulle vara rensad** |
| `.cache/listings-*.parquet` | 2,3 GB | 18 filer, 1 aktuell | BLANDAT | 1 av 18 |
| `.cache/vectors/embeddings.npy` | 72 MB | 94 305 × 384 | HÄRLETT | motorn |
| `.cache/vectors/index.faiss` | 145 MB | ANN-index | HÄRLETT | motorn |
| `.cache/vectors/colors.npy` | 18 MB | färghistogram | HÄRLETT | motorn |
| `.cache/vectors/crops` | 1 MB | **30 JPEG** | **SKYDDAT** | inget |
| `.cache/vision` | 696 KB | 174 LLM-svar | HÄRLETT | mätskript |
| `benchmark/` | 134 MB | **52 bildfiler** + specar | **SKYDDAT** | benchmark |
| `image_pairs/` | 9,4 MB | **34 JPEG** | **SKYDDAT** | mätskript |
| `bridge_study/`, `relist_study/` figurer | ~1 MB | 5 diagram | HÄRLETT | rapporter |
| `Price_engine/*.pdf` (3 st) | **193 MB** | facit + skärmbilder av annonser | **SKYDDAT** | benchmark |

### Svar på de fem frågorna

**1. Finns faktiska bildfiler?** **Ja — 94 356 JPEG i `.cache/images` (5,3 GB),
30 i `crops`, 52 i `benchmark/`, 34 i `image_pairs/`.** Totalt cirka 94 472
bildfiler. Påståendet att cachen rensas explicit har inte verkställts.

**2. Beskrivningstexter.** Fyra fritextfält i master:

| kolumn | ifylld | median | max | läses av motorn |
|---|---|---|---|---|
| `title_raw` / `title_norm` | 100 % | 27 | 288 | **ja** |
| `canonical_text` | 100 % | 13 | 80 | nej |
| `condition_text` | 30,8 % | 34 | 513 | **nej** |
| `description` | 4,9 % | 147 | **160 (kapad)** | nej |
| `dims_text` | 1,9 % | 26 | 66 | nej |

Ingen av dem är löpande beskrivningar. **`description` är kapad vid 160 tecken
och stickproven är återförsäljarnas marknadstext** ("Copenhagen Premium är
soffan för dig som vill ha det lilla extra…"), inte säljarskriven text. I
`allaannonser`-rådatan är `description` kapad vid ~85 tecken. Verkshöjden är
därmed låg i hela materialet — men marknadstext är ändå skyddad, och
återförsäljare är mer benägna än privatpersoner att hävda rätten.

**3. `search_blob`.** Byggd av `title_norm` + `brand` + `title_raw` +
`ikea_model`, `designer`, `material`, `type_word`, `era`. **Ingen
beskrivningstext, ingen `condition_text`, ingen `canonical_text`** — den senare
är uttryckligen utesluten med kommentar i koden. `search_blob` är alltså
rubriker plus strukturerade fält: **FAKTA**.

**4. Personuppgifter.** Urval 10 000 rader, frö 20260818:

| fält | ifyllda | telefon | e-post | URL | gatuadress | persnr-mönster |
|---|---|---|---|---|---|---|
| `title_raw` | 10 000 | 0 | 0 | 0 | 1 | 0 |
| `description` | 493 | **5** | 0 | **3** | 0 | **4** |
| `condition_text` | 3 057 | 0 | **9** | 0 | 0 | 0 |
| `canonical_text` | 10 000 | 0 | 0 | 0 | 0 | 0 |
| `location` | 5 351 | 0 | 0 | 0 | 0 | 0 |

Mönstret "Förnamn Efternamn" gav 1 708 träffar i `title_raw`, men granskning
visar att de i praktiken är **formgivare och modellnamn** — "Folke Pålsson J77
pinnstol", "Organic Chair Eames", "Yoko Soffbord". Ingen verklig
säljaridentitet. Samma för `condition_text`, där träffarna är "Key/keys
included" och "Nikotinlukt Key".

**Verklig PII är koncentrerad till två fält motorn inte läser:** `description`
(≈2,4 % av de ifyllda raderna bär telefon, URL eller persnr-liknande siffror)
och `condition_text` (0,3 % e-post). `location` är ortnamn (Osby, Floda,
Huddinge), inte adresser.

**Den tyngsta personuppgiften ligger dock i rådatan, inte i master:**
`blocket_listings.ndjson` har `lat`/`lon` på **100 %** av raderna.

**5. Benchmarkmaterialet.** 3 PDF:er på 193 MB med skärmbilder av verkliga
annonser (foton tagna i privata hem), samt 52 bildfiler extraherade ur dem i
`benchmark/`. Specarna (`items_*.json`) innehåller bara fakta: märke, modell,
variant, mått, facitintervall.

---

## Del 2 — Extraktionskompletthet

| behov | extraherat idag? | ur vilken källa | kvarstående värde i originalet |
|---|---|---|---|
| typ/variant (`derived_type`) | **ja, 86,6 %** | `title_norm`/`title_raw` | inget — rubriken behålls |
| storlek (`size`) | ja, 5,2 % | rubriken | inget — rubriken behålls |
| sitsantal, hörn, bädd (attribut) | ja | rubriken | inget |
| skick (`condition_tier`) | **ja, 27,6 %** | `condition_vips` (strukturerad) | inget |
| **skadeord** (fläck, repa, defekt) | **NEJ — 0 %** | `condition_text` **oanvänd** | **STORT: 470 278 rader** |
| kvantitet ("6 st", "par") | detektor byggd, **ej applicerad** | rubriken | inget — rubriken behålls |
| märke/modellord | ja | rubriken → `model_names.json` | inget |
| cellflaggor (bunt/tillbehör/sektion) | **ja, 100 %** | rubriken | inget |
| bildinnehåll | **ja, men bara 7,6 %** | 94 305 av 1 237 855 URL:er | **STORT vid bildradering** |

### Planerade funktioner som behöver råmaterial

| funktion | behöver | finns extraherat? | kan köras NU? |
|---|---|---|---|
| **Skadeavdrag i skickmodellen** | `condition_text` | **nej** | **JA — ordlisteskanning, minuter** |
| Antalsdetektering (Del 6) | rubriken | rubriken behålls | ja, ingen brådska |
| `corner_count` (U-soffa) | rubriken | rubriken behålls | ja, ingen brådska |
| **SigLIP-attributmärkning** | **råbilder** | 7,6 % embeddade | **kräver bilderna — se beslut nedan** |
| **ArcFace modellidentitet** | **råbilder, många per modell** | 7,6 % | **kräver bilderna** |
| Termuppmjukning, stoppord | rubriken | behålls | ja |

**Slutsatsen är obehaglig men tydlig:** allt textbaserat kan extraheras nu och
kostar minuter. Bildberoendet kan inte lösas genom extraktion — SigLIP och
ArcFace kräver pixlarna. Valet står mellan att behålla 5,3 GB skyddade
fotografier för funktioner som ännu inte är byggda, eller att radera dem och
acceptera att båda vägarna stängs.

**Min bedömning:** radera. DINOv2 mätte AUC 0,513 för hörnsoffa — nära slumpen —
och bildvägen är avstängd i produktion av det skälet. Att hålla 94 356
fotografier för att kanske en dag träna ArcFace är svag grund. URL:erna behålls
(de är fakta), så en framtida hämtning är möjlig för de bilder som finns kvar
hos källan.

---

## Del 3 — Saneringsplan (förslag, ej genomförd)

### Fas 1 — extrahera först (uppskattad tid: under en timme)

| steg | vad | tid |
|---|---|---|
| 1 | **Skadeord ur `condition_text`** → nya kolumner (`damage_scratch`, `damage_stain`, `damage_crack`, `damage_wear`, `damage_broken`, `damage_smell`) + räknare | ~5 min |
| 2 | Kvantitet ur rubriken (`quantity.units`) → kolumn `unit_count` | ~10 min |
| 3 | `dims_text` → strukturerade mått där de går att tolka | ~5 min |
| 4 | Bygg om korpusen, höj `CACHE_VERSION`, verifiera radantal oförändrat | ~15 min |
| 5 | **Kör benchmarken i fyra lägen på rättad harness (v6)** och jämför mot `bench6` — måste vara identisk | ~50 min |

Steg 5 är kravet: extraktionen lägger bara till kolumner och får inte flytta ett
enda pris.

### Fas 2 — radera

| ordning | vad | storlek |
|---|---|---|
| 1 | `.cache/images` (94 356 JPEG) | 5,3 GB |
| 2 | `.cache/vectors/crops` (30 JPEG) | 1 MB |
| 3 | 17 föråldrade `listings-*.parquet` | 2,2 GB |
| 4 | Kolumnerna `description`, `condition_text`, `canonical_text` ur `master.parquet` (skriv om filen) | ~30 MB |
| 5 | `lat`, `lon`, `seller_type`, `url`, `href` ur rå-NDJSON (skriv om) | del av 2,2 GB |
| 6 | Rå-NDJSON i sin helhet **om** master.parquet räcker som källa — kräver eget beslut | 2,2 GB + 7,3 GB |
| 7 | `benchmark/bilder_*`, `image_pairs/*.jpg` när mätningarna är klara | 143 MB |
| 8 | PDF:erna — flytta ut ur repot till personlig förvaring, behåll `items_*.json` | 193 MB |

### Var kopior kan gömma sig

- **Git:** rent. `git ls-files` = 0 filer, inga commits, `.gitignore` täcker
  `data/`, `*.parquet`, `*.ndjson`, `.cache/`. **Ingen historik att rensa.**
- **`CACHE_VERSION`-artefakter:** 18 `listings-*.parquet`, varav 17 föråldrade.
  Var och en är en **fullständig textkopia** av korpusen inklusive `search_blob`.
  Måste raderas, inte bara den aktuella bytas.
- **`.cache/vision`:** 174 LLM-svar. Innehåller modellens attributsvar, inte
  bilder — men kan bära citerad annonstext. Bör granskas.
- **Scratchpad:** `/private/tmp/claude-501/.../scratchpad` innehöll tidigare
  extraherade benchmarkbilder. Kontrollera vid sanering.
- **macOS Time Machine / iCloud:** utanför min räckvidd. **Du måste själv
  verifiera** att backuper inte bevarar `.cache/images`. Att radera lokalt medan
  Time Machine håller en kopia är ingen radering.
- **`marketplace-datasets/` (10 GB):** inte inventerad i detalj. Kan innehålla
  bilder eller fritext. **Bör inventeras före sanering.**

### Efterläge — svarspositionen för README

Förslag till formulering:

> Systemet håller strukturerade fakta om historiska möbelannonser: pris,
> datum, källa, märke, modellbeteckning, möbeltyp, mått och skicknivå. Det
> håller annonsrubriker (median 27 tecken) som produktbeteckningar för
> sökmatchning. Det håller härledda numeriska representationer — 94 305
> bildvektorer om 384 dimensioner, prismultiplikatorer och percentiltabeller.
>
> Systemet håller **inga annonsbilder**, **inga beskrivningstexter**, **inga
> kontaktuppgifter** och **inga geografiska koordinater**. Bildvektorer är
> irreversibla representationer, inte kopior. Bild-URL:er sparas som referens
> till källan.

### Framtida intag — så att städningen aldrig behöver göras om

1. **Extrahera vid intag, inte efteråt.** Ett `ingest.py` som läser en rå
   skrapning, extraherar allt (typ, skick, skadeord, kvantitet, cellflaggor,
   bildvektorer) och skriver **enbart** det extraherade till `extra/`.
2. **Rå fritext och råbilder till en karantänkatalog** med
   `RAW_RETENTION_DAYS = 7`, som `ingest.py` städar vid varje körning.
   Fönstret finns bara för att extraktionen ska kunna köras om vid en bugg.
3. **Vitlista kolumner vid intag.** I dag läser inläsaren allt som finns och
   ignorerar det den inte känner igen — därför följde `description`, `lat` och
   `lon` med in. En vitlista gör att okända fält aldrig landar på disk.
4. **`corpus_health.py` rapporterar även efterlevnad:** finns filer i
   karantänen äldre än fönstret, finns bildfiler i cachen, finns
   icke-vitlistade kolumner. Då upptäcks glidningen automatiskt.

Punkt 3 är den viktiga. Hela den här inventeringen beskriver konsekvensen av
att inläsningen var tillåtande i stället för restriktiv.
