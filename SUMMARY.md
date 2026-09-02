# Köpsidan — vad som byggts

Nio steg, körda i följd på grenen `kopsidan`. Ett commit per steg; varje steg verifierat med tester,
skarp körning mot riktig data och riktiga API:er, och skärmbilder där något syns.

**649 tester passerar** (från 543 vid start av uppdraget). Typkontroll ren i server och webb.

---

## 1. Vad som byggts, steg för steg

### Steg 1 — Efterlysningsmodellen `a2ba92f`

`server/src/efterlysning/{types,store,match,migrate}.ts`

Efterlysningen ersätter butikens `bevakningar`. Skälet att slå ihop dem är inte städning: en
efterlysning är ett **påstående om efterfrågan**, och två register över samma efterfrågan hade betytt
att efterfrågeväggen, säljarkroken och annonsutkasten alla räknar olika.

Specen är ett `ProductFilter` **plus fyra fält** — stil, deadline, brådska, anteckning — och inte en
egen vokabulär. Filtret kan redan kategori, märken, maxpris, max B/D/H, färger, material och betyg,
med samma ord som rutnätet, AI-sökningen och Tradera-poolen talar.

Matchningen skiljer **hårda gränser** (kategori, pris, mått — bryts aldrig) från **mjuka önskemål**
(stil, färg, märke — får ge en ärlig nära-träff).

*Verifiering:* 26 tester i `tests/efterlysning-{match,store}.test.ts`.

### Steg 2 — Direktsvepet `907923e`

`server/src/efterlysning/sweep.ts`, pristak nedskjutet i `integrations/tradera/search.ts`

Fyra källor i värdeordning, upp till sex kandidater, aldrig noll. Pristaket skjuts ned i SOAP-anropet
i stället för att filtreras efteråt — fälten fanns redan i kroppen men stod som `xsi:nil`.

*Verifiering:* `docs/verify/steg2-direktsvep.txt` — fyra skarpa svep mot riktigt lager och riktiga
Tradera-anrop. Noll tomma svep, inga hårda gränser brutna.

### Steg 3 — Chattintaget `d039d23`

`server/src/efterlysning/{parse,backstop}.ts`, utökad `butik/aiSearch.ts`

`interpretQuery` är **utökad, inte kopierad**: samma anrop, samma validering mot katalogen, samma
reservväg — plus fyra fält i schemat. Följdfrågorna är bestämda i kod, kostar inga modellanrop, och
ställs bara för fält som ändrar matchningen.

*Verifiering:* `docs/verify/steg3-tolkning.txt` — fem riktiga meningar genom modellen.

### Steg 4 — Köpsidan `8729f84`

`web/src/kop/**`, `server/src/efterlysning/routes.ts`, `server/src/affar/fees.ts`

`/kop` med efterlysningen som hero och Trygg affär som förstklassig ingång direkt under. Intaget är
fyra bestämda lägen: skriv → högst tre frågor → ett redigerbart kort man bekräftar → träffarna. Först
därefter erbjuds sparandet.

Trygg affärs avgifter: säljaren får sitt fulla pris, köparen ser hela uppdelningen på sanningskortet
**innan** säljaren bjuds in. Leveransen prissätts av butikens zoner — en enda fraktlogik i produkten.

`/butik` roten 301:as till `/kop`; katalogen ligger kvar. Ramen delas via `Chrome.tsx`.

*Verifiering:* `docs/verify/steg4-kopsidan.txt`, `kop-1-hero.png`, `kop-2-spec.png`, `kop-3-traffar.png`.

### Steg 5 — Notiser, puls och deadline-ventil `ee8323c`

`server/src/efterlysning/{notify,pulse,matcher}.ts`, `server/src/notify/outbox.ts`

Fyra regler: strikt matchning väcker, vårt eget direkt men Tradera högst en gång per dygn, samma
möbel aldrig två gånger, och varje notis bär sin efterlysning i länken. Märkningen sker när notisen
**skapas**, inte när brevet går.

In-app-inkorgen är primär kanal; brevet är en påminnelse om den. Fil-adaptern skriver färdiga brev
till `/outbox`.

*Verifiering:* `docs/verify/steg5-notiser.txt` — riktiga brev med riktiga siffror.

### Steg 6 — Förturen `b57c76f`

`server/src/efterlysning/fortur.ts`, grind i `butik/inventory.ts`

Utanför tillståndsmaskinen, med flit. Frågan "gäller förturen?" räknas om vid **varje läsning** —
en utgången förtur kan inte hålla kvar en möbel ens när städjobbet aldrig kört.

*Verifiering:* `docs/verify/steg6-fortur.txt`. Ett test låser att `ALLOWED_TRANSITIONS.draft` är
oförändrat.

### Steg 7 — Väggen, panelen och säljarkroken `3dc9a09`

`server/src/efterlysning/wall.ts`, `web/src/kop/screens/DemandWall.tsx`, SEO i `butik/seo.ts`

`/efterlyses` är publik, vänd mot säljare och SEO-renderad per kategori. Tre regler håller köparen
oidentifierbar; testerna letar aktivt efter e-post, id och anteckning i det som lämnar systemet.
Panelen rankar på **omättad** efterfrågan.

*Verifiering:* `docs/verify/steg7-vagg.txt` med läckagekontroll, `efterlyses.png`.

### Steg 8 — Efterfrågeannonser `2d1ec86`

`server/src/efterlysning/demandAds.ts`

Utkast i en godkännandekö. **Två grindar**: publicering bakom `DEMAND_ADS_PUBLISH` (av), och även
påslagen krävs ett godkännande först. Texten skrivs i kod, inte av en modell.

*Verifiering:* `docs/verify/steg8-annonser.txt` med läckagekontroll.

### Steg 9 — Tömningsmatchning `7a48859`

`server/src/efterlysning/clearance.ts`

Breven lovar ett **besked**, inte en möbel. Matchningen är grov med flit — före besiktningen finns
inga mått att pröva mot.

*Verifiering:* `docs/verify/steg9-tomning.txt`.

### Analysen

`server/src/efterlysning/analytics.ts` — händelser som uppstår på servern (brev, förtur, köp, puls,
ventil, tömning, annonsutkast) skrivs som en rad JSON per händelse. Klienthändelserna går via
befintlig `track()`. Utan serverhalvan går norra stjärnan — köp per sparad efterlysning — inte att
räkna alls.

---

## 2. Höjdpunkter ur DECISIONS.md

Åtta beslut loggade. De fyra som ändrade produkten:

**#1 Okänt mått är inte samma sak som för stort.** Skarp körning gav *noll* kandidater på "matbord,
max 160 cm" — nästan ingen annons anger bredd. Ett mått har nu tre utfall. Strikt läge (notiser)
behandlar okänt som över; det generösa svepet visar det med en ärlig etikett.

**#2 "Inte String" om en String-hylla.** Tradera-varor får `brand: null` när igenkänningen missar, och
koden läste frånvaro som fel. Ett mjukt villkor kan nu vara ok, fel eller **okänt** — och etiketten
skiljer på "blå, inte grön" (vi vet) och "färg framgår inte" (vi vet inte).

**#3 Deterministiskt skyddsnät.** Tolkningen tappade pris, mått och färg ur meningar där den fick
kategorin rätt. Ett nät i kod fyller luckorna och kan aldrig överpröva modellen. Tre buggar hittades
i själva nätet, alla i skarp körning.

**#6 Väggen får aldrig överdriva en köpares budget.** Prisbandet la 4 000 kr i spannet "upp till
6 000" — en förhandlingsposition given bort gratis. Band avrundas nu nedåt, och gruppen bär det
lägsta taket i sig.

Genomgående: **inga påhittade siffror.** Prognosen, bevisremsan och pulsens tal kommer ur riktiga
räknare eller så visas de inte. Dag ett är bevisremsan tom, och det är avsett (#0).

---

## 3. Tre saker som kräver ett mänskligt beslut

### E-postleverantör och avsändaradress

`EMAIL_PROVIDER` är `file` och skriver till `/outbox`. Inget går till en riktig mottagare.
Inkorgen fungerar utan detta, men puls, deadline-ventil, förnyelse och tömningsbesked når bara den
som öppnar appen. **Behövs:** leverantör, nyckel, avsändaradress — sedan en adapter i
`server/src/notify/outbox.ts` bredvid de två som finns.

### Publiceringsflaggan för efterfrågeannonser

`DEMAND_ADS_PUBLISH=0`. Godkända kampanjer exporteras som CSV och klistras in för hand. Att slå på
flaggan kräver ett API att publicera mot och ett beslut om att en godkänd text får gå ut utan att
någon tittar en gång till. **Rekommendation:** låt den vara av tills texterna körts manuellt några
omgångar — bromsen är hela poängen så länge de är nya.

### Lansering av 301:an för /butik

`/butik` → `/kop` är aktiv i koden. Adressen står i delade länkar, bokmärken och sökresultat, och en
301 flyttar sökmotorvärdet permanent. **Innan lansering:** bekräfta att inga externa kampanjer eller
QR-koder pekar på `/butik` med parametrar som inte överlever redirecten. `/butik/kategori/…` och
`/butik/objekt/…` är orörda.

---

## Att köra det

```
npm --prefix server run start     # servern, med sveparen och migreringen
npm --prefix web run build
npm test                          # 649 tester
```

Miljövariabler som styr beteendet, alla med förval:

| Variabel | Förval | Vad den gör |
|---|---|---|
| `EMAIL_PROVIDER` | `file` | `file` skriver till `/outbox`, `none` skickar inget |
| `DEMAND_ADS_PUBLISH` | av | API-publicering av annonser |
| `EFTERLYSNING_FORTUR_HOURS` | 24 | Förturens längd |
| `EFTERLYSNING_SWEEP_MS` | 3600000 | Takt för den löpande matchningen |
| `EFTERLYSNING_PROOF_MIN` | 3 | Under detta döljer sig bevisremsan |
| `EFTERLYSNING_FORECAST_MIN` | 5 | Under detta säger prognosen ingenting |
| `AFFAR_SERVICE_FEE_SEK` | 200 | Serviceavgiften i Trygg affär |
