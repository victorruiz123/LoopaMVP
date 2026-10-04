# Prisstegen över alla kanaler — planen

*Skriven 2026-10-02. Fas A (koden) och fas B (skarpt verifierad prisändring på Blocket) är gjorda
och testade samma dag; kvar är utrullningen (fas C).*

Uppdraget: priserna på Blocket och Tradera ska sänkas automatiskt med en viss procent varje vecka,
av en robot, utan att någon gör det för hand. Det här dokumentet är tre saker: vad som redan fanns i
koden och varför det inte räckte, besluten som togs, och vägen från "koden finns" till "det går i
drift".

---

## 1. Nuläget före arbetet — vad koden redan gjorde

### Prisstegen fanns, för Tradera

`server/src/priceLadder.ts` har sedan tidigare hela mekaniken: säljaren väljer **startpris, golv och
procent per vecka** (förval 15 %, `PriceLadderPicker` när prismotorn har ett förslag, `ManuellPrisplan`
när den inte har det). Servern räknar nästa steg i jämna tior, tar igen missade veckor om den legat
nere, försöker igen efter sex timmar när Tradera avvisar, och kör ett varv var 15:e minut i samma
process som servern. Panelen kan ändra spannet (`ladder`) och sätta ett pris direkt (`prisNu`).

Verkställandet gick genom **Traderas REST-API**: `PUT /listings/items/{id}/price` i
`integrations/tradera/tradera.ts` (`updateTraderaPrice`), Köp Nu-pris för fastpris och utropspris för
auktion. Frakten (hemleveransen, 600/700 kr) läggs på vid gränsen — stegen räknar i möbelkronor.
**Tradera är alltså automatiskt sedan tidigare**, genom deras officiella API.

### Blocket hade bara en väg in, ingen väg att ändra

`integrations/blocket/` är en Playwright-robot som fyller i Blockets Torget-formulär (Blocket har
inget skriv-API). Den kan **publicera**; den kunde inte **redigera**. Därför fanns
`ladderFrozenByBlocket`: så fort Blocket-annonsen låg uppe stod hela stegen stilla, för annars hade
Tradera sjunkit medan Blocket stod kvar och samma möbel legat ute till två priser.

### Fyra tysta fel som följde av det

1. **Frysningen.** Varje möbel som gick ut på Blocket (vilket "Godkänn och lägg ut" gör automatiskt
   när Blocket är konfigurerat) slutade sjunka — överallt, även i butiken och på Tradera.
2. **Schemaläggaren startade bara med Tradera-nycklar.** På en server utan dem sjönk ingenting.
3. **Bara Tradera-publicerade annonser räknades som "igång".** En möbel som bara låg i butiken
   eller på Blocket hade en steg som aldrig gick.
4. **Priset flyttades först när Tradera sa ja.** Ett avslag (t.ex. en auktion med bud) höll kvar
   möbeln på det gamla priset i butiken också. Och adminens `prisNu` skrevs bara till Tradera —
   Blocket gled isär i tysthet.

---

## 2. Besluten

**D1. Priset är möbelns, inte kanalens.** `priceLadder.currentPrice` är sanningen om vad möbeln
kostar den här veckan. Stegen flyttar det på schema, oavsett vad marknadsplatserna svarar. Butiken
läser det direkt (`butik/normalize.ts priceOf`), kanalerna ska följa.

**D2. Varje kanal har ett kvitto.** `TraderaPublication.pris` och `BlocketPublication.pris`
(`KanalPris` i types.ts): vilket möbelpris kanalen senast *bekräftats* ligga på, hur (publicering /
API / robot / för hand / antaget), senaste fel, nästa försök, och om en människa krävs. En kanal vars
kvitto inte stämmer med stegen är **ur fas** — ett tillstånd som syns i panelen och försöks rätta
varje varv, inte ett skäl att stoppa sänkningen.

**D3. Blocket ändras av en robot, direkt i Blockets redigeringsformulär.** Ny modul
`integrations/blocket/pris.ts`. Uppmätt 2026-10-02 på riktiga Blocket: "Ändra annonsen" leder till
`/recommerce/create/<annons-id>` — samma formulär som vid skapandet, förifyllt, med **Spara** direkt
på sidan. Roboten går dit direkt (id:t står i den annonsadress publiceringen sparade), **vaktar
rubriken** (ett okänt id ger ett tomt skapandeformulär, och ett Spara där hade skapat en ny annons),
fyller i Pris och sparar. Egen brytare `BLOCKET_PRIS_ROBOT`: 1 = på även när publiceringen torrkör
(en prisändring går att ångra, en publicering går inte att ta ner), 0 = av, osatt = följer
`BLOCKET_PUBLICERA`. När roboten är av svarar den "manuell": panelen visar *"Blocket ligger på X kr,
ska vara Y kr"* med knappen **Ändrat för hand**, och ett brev går till `ADMIN_EMAILS` — ett per gång
kanalen hamnar ur fas. Ingen veckovis torrkörning.

**D4. Frysningen är borta.** `ladderFrozenByBlocket` finns inte längre. Övergången hanteras en gång
per annons: en steg som stod frusen av Blocket (Blocket uppe, inget kvitto) startar om klockan från
i dag i stället för att ta igen veckorna — frysningen var ett beslut då, inte ett driftstopp.

**D5. Klockan startar vid godkännandet.** `godkann` i adminAnnonser.ts armerar stegen när möbeln
går ut i butiken. Tradera- och Blocket-publiceringarna armerar också, men `armPriceLadder` startar
klockan bara en gång: en Blocket-publicering en vecka efter Tradera flyttar inte nästa sänkning.
En annons som redan ligger ute med en klocka som aldrig startats får den startad vid nästa varv.

**D6. Schemaläggaren är alltid på.** Tradera utan nycklar bokförs som "för hand" på just den kanalen.

**D7. Adminens "Sätt priset" går genom samma synk** som den veckovisa sänkningen (`synkaKanaler`
med `tvinga`), till alla kanaler. Ett pris på golvet stänger klockan; ett pris över golvet startar
den igen.

---

## 3. Designen i korthet

```
var 15:e minut (tickPriceLadders)
  för varje jobb med prissteg:
    lever annonsen? (ej borttagen, ej såld i huvudboken, uppe på Tradera/Blocket eller live i butiken)
    ärv kvitto åt kanaler från före fältet (= stegens pris)      ← FÖRE sänkningen
      · stod stegen frusen av Blocket → klockan startar om från i dag
    klockan aldrig startad men annonsen ute → starta den
    förfallen? → sänk MÖBELNS pris (currentPrice), bokför droppen
    någon kanal ur fas? → synkaKanaler:
        Tradera  → updateTraderaPrice(annonspris)   PUT /listings/items/{id}/price   ok → kvitto "api"
        Blocket  → flyttaBlocketPris(job, annonspris)
                     /recommerce/create/<id> → rubrikvakt → Pris → Spara → verifiera   → kvitto "robot"
                     brytaren av / ingen session / ingen adress  → "manuell": kraverManuell + brev (en gång)
                     en publicering pågår                        → "senare": nytt försök om 20 min
        fel      → fel på kanalen, nytt försök om 6 h
    ladder.lastError = "Blocket ligger kvar på 3 000 kr." (säljarens vy) eller null
```

Annonspris = möbelpris + den frakt annonsen gick ut med (`hemleverans.ts annonsensFrakt`).

**Så ser Blocket ut (uppmätt 2026-10-02, inloggad session, bara läsning):**

| Vad | Uppmätt |
|---|---|
| Mina annonser | `/mina-annonser` → `/my-items`; filter Alla/Utkast/Nekad/Aktiva/Utlöpt |
| Kortet | rubrik → `/my-items/details/<id>`; w-button "Markera som såld"; w-button **"Meny till genvägar för annonsen"** med DOLD meny: "Ändra annonsen" → `/recommerce/create/<id>`, "Visa annonsen" → `/<id>`, "Se statistik" |
| Redigeringen | `/recommerce/create/<id>`, sidtitel "Skapa annons", förifyllt: `w-textfield[name=title]` "Annonsrubrik", Beskrivning, **Pris** (`<label for>` → `<input type=number>`, `getByLabel("Pris", exact)` träffar inputen direkt), Postnummer, Höjd/Bredd/Djup, Skick, kategorier, bilder |
| Knapparna | `w-button[type=submit]` **Spara**, w-button Avbryt — ingen frakt-/paketsida |
| Torrkörning skarpt | öppnade `/recommerce/create/21946768`, rubrikvakten läste "Svart IKEA NORDVIKEN barstol (62 cm)", fyllde i 390, sparade inte |

**Filer som ändrats (fas A):**

| Fil | Vad |
|---|---|
| `server/src/types.ts` | `KanalPris`; `pris` på Tradera- och Blocket-publiceringen; `prisSteg` på Blocket |
| `server/src/priceLadder.ts` | beslutet och synken åtskilda; `synkaKanaler`, `kanalPrisLagen`, `bekraftaKanalPris`, `arvKanalPris`, `annonsenLever`; schemaläggaren alltid på; frysningen borta; övergången |
| `server/src/integrations/blocket/pris.ts` | **ny**: prisroboten (`driveBlocketPriceChange`, `flyttaBlocketPris`, `blocketPrisRobotPa`, `rubrikStammer`) |
| `server/src/integrations/blocket/pris-prov.ts` | **ny**: `npm run blocket:pris -- <jobId> [--skarpt]`, eller `--annons <url> --pris <kr>` för vilken annons som helst på kontot |
| `server/src/integrations/tradera/pris-prov.ts` | **ny**: `npm run tradera:pris -- --item <id> [--pris <kr> --skarpt]` — läser/sätter priset via API:t |
| `server/src/integrations/blocket/vakt.ts` | `arUpptagen()` så prisroboten inte startar bredvid en publicering |
| `server/src/integrations/tradera/publish.ts`, `blocket/publish.ts` | skriver kanalens kvitto vid publiceringen; Blocket armerar också klockan |
| `server/src/adminAnnonser.ts` | `prisKanaler` på detaljen, `prisUrFas` på raden, patch `kanalPris` ("Ändrat för hand"), `sattPris` via synken, `godkann` armerar klockan |
| `server/src/server.ts` | säljarens prisplan låses när någon kanal är uppe |
| `server/.env.example` | `BLOCKET_PRIS_ROBOT`, ny text om stegen |
| `web/src/types.ts`, `screens/AdminAdScreen.tsx`, `screens/AdminAdsScreen.tsx` | rutan "kanalerna mot stegen" med knappen, "pris ur fas" i listan |
| `web/src/components/SellWithLoopa.tsx`, `lib/translations/listing.ts` | säljarens rad: "Prisändringen har inte nått alla kanaler än: …" |
| `tests/priceLadder.test.ts` | 29 tester: räkningen (oförändrade) + synken, arvet, larmet, klockan, övergången |
| `tests/blocketAttrapp.ts`, `tests/blocketPris.test.ts` | attrappen speglar det uppmätta (Mina annonser med dold meny, `/recommerce/create/<id>` förifyllt med Spara, fällan "Lägsta pris", tomt formulär för okänt id); 11 tester mot den |

---

## 4. Fas B — det skarpa sparandet: GJORT 2026-10-02

Tre skarpa rundor på en egen annons (21946768, 400 → 390 → 400 kr, med ägarens ok), headless från
den sparade sessionen. Den sista rundan gick genom HELA produktionsvägen (`synkaKanaler` →
`flyttaBlocketPris` → `driveBlocketPriceChange` → kanalkvittot) med ögonblicksbilder av alla 23
formulärfält, bilderna, leveransvalet, ägarsidan, publika sidan och filterräknarna före och efter:

| Steg | Uppmätt |
|---|---|
| Formulärets **Spara** | SPARAR PRISET och går vidare till `/recommerce/delivery/<id>?editMode=true` (leveranssidan i redigeringsläge, med egen Spara/Avbryt för leveransvalet). Roboten rör den inte. |
| BankID | Begärdes inte. |
| Vad som ändras | **Bara prisfältet.** Rubrik, beskrivning, mått, skick, kategorier, postnummer, 6 bilder och leveransvalet identiska före/efter; inga nya utkast; slutläget identiskt med utgångsläget. |
| Hela vägen | 12–13 s per ändring; kvittot skrivs som `via: "robot"`, `lastError` null. |
| Ägarsidan `/my-items/details/<id>` | Visar det sparade priset direkt: "Torget säljes 390,−". Det är den verifieringen läser. |
| Publika sidan efter en ändring | **404 i 2–5 minuter efter VARJE ändring**, sänkning som höjning (sänkningen 17:42:56 → tillbaka 17:48:16; höjningen 17:48:56 → tillbaka efter 125 s). Sedan visar den det nya priset. |
| **Sänkning** (400 → 390) | Ägarsidan sa **Aktiv** hela tiden. |
| **Höjning** (390 → 400) | Ägarsidan bytte till **Granskas** några minuter efter sparandet (efter att publika sidan redan kommit tillbaka) och var Aktiv igen inom kvarten. |

För prisstegen betyder det: varje veckosänkning gör Blocket-annonsen osynlig i några minuter, inget
mer. Inget BankID, ingen granskning som stoppar, inga sidoeffekter. Det är därför verifieringen inte
får hänga på den publika sidan.

Provkörning för hand finns kvar för framtida ändringar hos Blocket:

```
BLOCKET_SYNLIG=1 npm run blocket:pris -- <jobId>            # torrkörning: öppnar, vaktar rubriken, fyller i, sparar inte
BLOCKET_SYNLIG=1 npm run blocket:pris -- <jobId> --skarpt   # sparar; markera sedan "Ändrat för hand" i panelen

# Vilken annons som helst på kontot (utan jobb), t.ex. en egen testannons — rubriken läses från Blocket:
BLOCKET_SYNLIG=1 npm run blocket:pris -- --annons https://www.blocket.se/<annons-id> --pris 390 --skarpt
```

Kört 2026-10-03 på barstolen 21946768 (400 → 390 kr) på användarens begäran, för att kunna se
ändringen själv på Blocket. Ägarsidan visade 390 direkt, publika sidan efter ~1 minut. Priset
lämnades på 390 kr.

**Att slå på i drift:** `BLOCKET_PRIS_ROBOT=1` i serverns `.env`. Behöver INTE `BLOCKET_PUBLICERA=1` —
publiceringen kan fortsätta torrköra medan priserna går skarpt. (Servern hade 2026-10-03 redan
`BLOCKET_PUBLICERA=1` satt; då följer prisroboten med av sig själv när koden rullas ut.)

### Tradera — verifierat skarpt 2026-10-03

Tradera har ett API, så här finns ingen robot: prisbytet är ETT anrop, `PUT /listings/items/{id}/price`
(`updateTraderaPrice`), samma som stegen gör varje vecka. Kört från servern (nycklarna finns bara där)
på Mio-fåtöljen, Tradera-artikel 752969544, en riktig Loopa-annons:

| Steg | Uppmätt |
|---|---|
| `PUT …/price {binPrice: 1490}` | http 200, `{"isSuccessful":true}`, 69 ms |
| `GET …/items/752969544` efteråt | `buyItNowPrice` 1490 (var 1500), inga bud, slutar 2026-11-28 |
| Publika sidan tradera.com/item/752969544 | visade 1 490 kr direkt, ingen granskning, ingen osynlighet |

Priset lämnades på 1 490 kr på användarens begäran. Jobbets steg (1a3f5d99) säger fortfarande
900 kr möbel = 1 500 kr i annonsen; vid nästa veckovarv (6 oktober) sänker stegen till 770 kr
möbel = 1 370 kr och kvittot kommer i fas av sig självt.

**Vad Traderas egen bild av de fem annonserna visade** (`GET /listings/items/{id}`):

| Jobb | Artikel | Tradera säger |
|---|---|---|
| 1a3f5d99 Mio-fåtölj | 752969544 | aktiv, Köp nu 1 500 → 1 490 kr |
| 85dc3dcb Jysk resårbotten | 753539258 | aktiv, Köp nu 1 850 kr (stegen på golvet) |
| 3146ad51 Bergholm-soffa | 751514068 | **såld** på Tradera 26/9 (gotWinner) |
| 35d112ba Ektorp-fåtölj | 751535643 | **gått ut** 29/9, osåld, inte omlagd |
| 506fba7b Rosentorp-stol | 751378929 | **gått ut** 20/9, osåld, inte omlagd |

De två utgångna hade fått ett avvisat prisanrop var sjätte timme i evighet. Därför läser synken
annonsens läge först (`getTraderaLage`): en utgången annons bokförs som "för hand" med skälet
*"Annonsen har gått ut på Tradera (2026-09-29) — priset går inte att ändra förrän den lagts om"*
och ett brev går till admin. Att lägga om är ett beslut (ny annonstid, ev. avgift), inte något
stegen gör själv. Ett läsfel (null) stoppar inte: då försöks ändringen som vanligt.

Provskript, körs på servern där nycklarna finns:

```
cd /opt/loopa && ./server/node_modules/.bin/tsx server/src/integrations/tradera/pris-prov.ts --item 752969544
cd /opt/loopa && ./server/node_modules/.bin/tsx server/src/integrations/tradera/pris-prov.ts --item 752969544 --pris 1490 --skarpt
cd /opt/loopa && ./server/node_modules/.bin/tsx server/src/integrations/tradera/pris-prov.ts <jobId> --skarpt   # stegens pris
```
(lokalt: `npm run tradera:pris -- …`, om TRADERA_* finns i server/.env)

**Blocket-kontot är fortfarande den öppna frågan** (BLOCKET-PLAN.md, 2026-09-19: Blocket nekade
företagsliknande annonser på privatkontot). Prisroboten ändrar inget i den frågan — den redigerar
samma annons på samma konto. Men den är oberoende av den: dagen det finns en Loopa-annons uppe på
Blocket, på vilket konto det än blir, sänker roboten den.

---

## 4b. Takten är säljarens — gjort 2026-10-03

Frågan var om säljaren i dag kan välja hur många procent annonsen sänks per vecka. Svaret var
*delvis*: servern räknade sedan länge med varje annons egen `weeklyDropPct` (1–50 % i
`ManuellPrisplan`, fritt i panelen), men i HUVUDFLÖDET — prisvyn när prismotorn har ett förslag,
`PriceLadderPicker` — var takten låst till 15 % och skickades inte ens med. Den som hade bråttom
kunde sänka startpriset men inte farten.

Nu:
- `PriceLadderPicker` har ett tredje reglage, **Sänkning per vecka** (1–50 %, förvalt 15 %), med
  samma utseende som pris-reglagen. Stegen nedanför, intro-texten och "golvet nås efter N veckor"
  räknas om direkt, och takten sparas tillsammans med spannet (`weeklyDropPct` i `POST
  /api/jobs/:id/price-plan`). Ett redan sparat spann visar sin egen takt.
- Gränserna är gemensamma: `WEEKLY_DROP_MIN_PCT`/`MAX_PCT` i `web/src/lib/priceLadder.ts` (som
  `ManuellPrisplan` nu också använder) och `MIN_WEEKLY_DROP`/`MAX_WEEKLY_DROP` i
  `server/src/priceLadder.ts` (`makePriceLadder` avvisade förut bara 0 och 100 %). Servern avvisar
  alltså aldrig något reglaget tillät, och ett ras på 90 % i veckan går inte att skicka in.
- Villkorstexten (TermsText) sa "15 % i veckan" som ett faktum; den säger nu "den takt du valt,
  förvalt 15 % i veckan". Säljarens bekräftelse och annonsvy läste redan annonsens egen takt.
- Sänkningen själv ändras inte: `plannedDrop`/`nextRung` har alltid använt `ladder.weeklyDropPct`,
  och kanalsynken bryr sig bara om `currentPrice`. Tradera och Blocket får alltså den takt säljaren
  valde, utan något mer.

Oförändrat: prisspannet (och takten) låses i säljarvyn när annonsen ligger uppe; panelen kan ändra.

## 5. Fas C — drift

### Generalrepetitionen på servern (2026-10-03, utan att röra /opt/loopa)

Koden hämtades till en tillfällig kopia på servern (`/tmp/loopa-prov`, via git-bundle, med serverns
egna node_modules och Chromium) och provkördes där — samma Node (v24.18.0), samma webbläsare:

| Prov | Utfall |
|---|---|
| `tsc` för servern | rent |
| Webbygget (`npm --prefix web run build`) | föll FÖRSTA gången: en commit hade råkat få med någon annans pågående `SellWithLoopa.tsx` med bilder som inte var incheckade. Commitarna skrevs om så att bara prisarbetet ingår; bygget går sedan |
| 62 tester på servern (stegen, Blocket-roboten mot attrappen med serverns Chromium, publiceringen, vakten, autopubliceringen) | 62 gröna |
| Första varvet mot en KOPIA av serverns 40 jobb, med butikens huvudbok och marknadsplatserna frånkopplade | **inga prisändringar.** 5 annonser lever (Jysk, Mio, Rosentorp, Bergholm, Ektorp); kvitton ärvs; Rosentorp och Ektorp stod frusna sedan 26–27/9 och fick klockan omstartad till 10/10. 9 ms. |
| Samma kopia, +7 dagar | Mio 900 → 770 kr (Tradera 1 370 kr via API); Rosentorp 280 → 240 och Ektorp 1 950 → 1 660 kr — båda har gått ut på Tradera → "för hand" + ett brev vardera; Blocket-roboten hade ändrat deras Blocket-annonser |
| Samma kopia, +14 dagar | Mio 770 → 650 kr; de andra ett steg till; inga nya brev (ett per behov) |

Butikens huvudbok ligger i FILER på servern (`LOOPA_LAGRING` osatt), inte i Supabase. Repetitionen
missade det först (alla stod som `null`) — med filerna kopierade läses lägena rätt: Bergholm är såld
och hoppas över.

Två saker repetitionen avslöjade, och som rättades innan utrullning:
- **Rosentorps Blocket-annons är inte längre aktiv** (står inte bland de aktiva på Mina annonser).
  Blockets redigeringsadress öppnar formuläret ÄNDÅ, och ett Spara hade publicerat om annonsen.
  Roboten kontrollerar nu först att annonsen står bland de aktiva; annars "för hand" med brev
  (`BlocketAnnonsInteAktiv`). Två tester i attrappen.
- **Bergholm-soffan är såld på Tradera men dess Blocket-annons ligger kvar** (26755765). Inget
  stegen gör något åt — men någon bör ta ner den.

### Utrullningen

```
# lokalt
git push origin main

# på servern
ssh loopa-oracle
cd /opt/loopa && ./deploy/rulla-ut.sh          # pull, webbygge, omstart, kontroller
journalctl -u loopa-server -n 200 --no-pager | grep pris-steg
```

Förväntade loggrader direkt efter omstarten:

```
[pris-steg] schemaläggaren igång, ett varv var 15 min
[pris-steg] 506fba7b stod frusen av Blocket — klockan startar om från i dag, inga veckor tas igen
[pris-steg] 35d112ba stod frusen av Blocket — klockan startar om från i dag, inga veckor tas igen
```
Inga prisändringar första dagen. Mio-fåtöljen är den första som sänks, **måndag 6 oktober**
(900 → 770 kr möbel, 1 370 kr på Tradera); Rosentorp och Ektorp **fredag 10 oktober**.

Brytarna på servern: `BLOCKET_PUBLICERA=1` är satt → Blocket-prisroboten är PÅ från start.
`BLOCKET_PRIS_ROBOT=0` i `.env` + omstart stänger av den ensam. `ADMIN_EMAILS` är osatt → breven
går till de inbyggda adminadresserna (admin.ts).

### Återställning

Rollback är `git reset --hard <förra commit>` i /opt/loopa och `sudo systemctl restart loopa-server`.
De nya fälten på jobben (`pris` på publiceringarna, `prisSteg`) är tillägg; den gamla koden ignorerar
dem, och frysningen återinträder.

### Efter utrullningen

1. **Gå igenom de Blocket-annonser som ligger uppe EN gång** och jämför mot panelens "Pris nu":
   arvet antar att de står på stegens pris, och ser inte en `prisNu`-ändring gjord medan annonsen låg
   uppe. Mio-fåtöljen på Tradera står t.ex. på 1 490 kr (testet 3/10) medan stegen säger 1 500 —
   det rättar sig 6 oktober.
2. **Lägg om eller ta bort** Ektorp (751535643) och Rosentorp (751378929) på Tradera — breven
   kommer 10 oktober annars. Ta ner Bergholms Blocket-annons.
3. Brev: `outbox/` lokalt, riktig avsändare på servern (samma väg som Blocket-vakten). Varje brev
   slutar i panelen med knappen **Ändrat för hand**.
4. Säljarens vy visar *"Prisändringen har inte nått alla kanaler än: …"* när en kanal släpar. Raden
   försvinner när kvittot bekräftats.

---

## 6. Fas D — det som inte ingår, men som synken gör synligt

- **Facebook-inläggen bär priset i texten** (`integrations/facebook/mapping.ts`). En sänkning
  uppdaterar inte ett publicerat inlägg; produktsidan de länkar till visar rätt pris. Antingen
  skrivs priset ur inläggen ("se aktuellt pris på Loopa") eller så får Facebook ett eget kanalkvitto
  och en omposteringsregel. Beslut saknas.
- **Blockets granskning efter redigering.** Om varje prisändring lägger annonsen i "Granskas" ett
  dygn är en veckovis sänkning en veckovis osynlighet. Mäts i fas B.
- **Tradera-auktioner med bud** avvisar prisändringar (rätt så). Kvittot visar det som fel med nytt
  försök. **Utgångna annonser** känns igen före anropet och blir "för hand" med brev (se §4); att
  lägga om dem (`restartTraderaItem`) är ett beslut, och när det gjorts följer priset med nästa varv.
- **Mätning.** `drops` och kanalkvittona räcker för att svara på "hur många veckor tar en soffa att
  sälja, och på vilket steg". Ingen vy för det än.

---

## 7. Risker

| Risk | Hantering |
|---|---|
| Blocket bygger om redigeringsflödet | Rubrikvakten stoppar hellre än gissar; `BLOCKET_PRIS_ROBOT=0` stänger av bara prisändringarna; provskriptet visar var det stannar |
| Publika sidan är borta en stund efter varje ändring | Mätt till 2–5 min per ändring, oavsett riktning. En veckosänkning = några minuters osynlighet. Verifieringen läser ägarsidan, inte den publika |
| Roboten sparar på fel annons, eller skapar en ny | Direktadress med id ur sparad URL + rubrikvakt (tom rubrik = tomt skapandeformulär = avbryt); attrapptester för båda fallen |
| Två Chromium samtidigt | `arUpptagen()` — prisroboten väntar 20 min om en publicering kör, och tvärtom |
| Brev-spam | Ett brev per gång kanalen hamnar ur fas (`larmatAt`), nollas när kvittot bekräftas |
| Catch-up sänker flera steg på en gång vid utrullningen | Bara för annonser som legat nere, som förut; frusna startar om från i dag |
| Säljaren ändrar spannet efter publicering | Låst i säljarvyn när någon kanal är uppe (var bara Tradera); panelen kan |
| Blockets villkor om automatisering | Oförändrat läge sedan publiceringsroboten (BLOCKET-PLAN.md); prisroboten gör färre och mindre handlingar än den |
