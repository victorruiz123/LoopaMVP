# Facebook-distributionen

Loopa distribuerar varje möbel som blir live i butiken till Facebook Marketplace och till Stockholms
köp/sälj-grupper. Facebook är en **kanal**; Loopa är sanningen och köpet sker på produktsidan
`/butik/objekt/<loopaId>`, som varje inlägg länkar till. Koden ligger i
`server/src/integrations/facebook/` och panelen i fliken **Facebook** i adminpanelen.

## Läge (2026-09-26, första skarpa publiceringen)

| Del | Läge |
|---|---|
| Konto | Profilen `server/data/facebook/profile` bär nu det etablerade kontot **100090024781765** (c_user, verifierat 2026-09-26). Den gamla profilen (fel konto 61575203535562) ligger kvar som `profile-wrong-account-20260926-085339/`. Nytt kontoräcke: `FACEBOOK_ACCOUNT_ID` — webbläsaren vägrar köra med något annat konto. |
| Session | CONNECTED. |
| Marketplace | **Publicerad 2026-09-26 10:00Z** efter selektorfixen: https://www.facebook.com/marketplace/item/1515213387034704/ — "SoffaDirekt Bergholm", 1 000 kr, Stockholm, skick Använd – i gott skick, en bild, beskrivning med https://loopa.nu/butik/objekt/LP-9X20-66BZ (som ren text medan annonsen granskas). Facebook: "Säljinlägget granskas", "Publicerad på 1 plats: Marketplace", ännu inte sökbar. Första försöket 09:12Z träffade fel element (fixat, se nedan). |
| Gruppmedlemskap | Kontot är medlem i 82 grupper enligt "Dina grupper". Målgrupperna **Köp & Sälj Huddinge och Botkyrka** (privat, 23,5 tn, `kopsaljhuddingebotkyrka`) och **Köp/sälj Retro möbler och inredning Stockholm** (offentlig, 3,8 tn, `842625553735603`) är MEMBER, LIKELY_ALLOWED (köp/sälj-grupper utan administratörsregler; beskrivningarna nämner inte företag eller reklam), skrivruta "Sälj något". |
| Säljinlägget ("Sälj något") | **Stött och skarpt verifierat 2026-09-26** (publisher.ts `driveGroupListing`, forms.ts). Två riktiga säljinlägg för LP-9X20-66BZ 09:16Z/09:19Z: Huddinge/Botkyrka `commerce/listing/1438420238164962`, Retro `commerce/listing/1645250693697438` — bara målgruppen vald, Marketplace av, "1 000 KR · Stockholm", Loopa-adressen klickbar. Båda låg i Facebooks standardgranskning. **10:04Z var båda borta**: tom sida, saknas i flödet, Mitt publicerade innehåll, Dina varor och Dina säljinlägg, utan avisering. Orsak okänd (granskning, gruppadmin eller manuell borttagning). Manuella åtgärder öppnade; publicera inte om förrän orsaken är känd. |
| Gruppinlägg | Se raden ovan. Lagret: PUBLISHED (verified) med uppföljningssteg "borta 10:04Z". |
| Skrivningar | **2026-09-26: 4 Publicera-klick (ett per försök), 2 säljinlägg skapade (nu borta), 1 Marketplace-annons (granskas), 0 ansökningar.** Growth var stoppat under körningarna. |
| Skarp publicering | Avstängd. `FACEBOOK_ENABLED` är inte satt i server/.env. Den kontrollerade körningen görs med `scripts/facebook-kontrollerad-publicering.mts`, som vägrar om Growth kan skriva eller kön innehåller något annat. |

### Verifierat mot "Sälj något" i grupper 2026-09-26 (svensk UI)

- Knappen "Sälj något" öppnar dialogen **"Skapa nytt säljinlägg"** med typvalet "Vara till salu" (samt Fordon, Bostad, Säljevenemang).
- "Vara till salu" är Marketplace-formuläret i en dialog: filfält (upp till 42 foton; "1 foto bifogat"), **Titel**, **Pris** (formateras med kontots valuta), **Skick** (`label[role=combobox]`, samma fyra alternativ som Marketplace). Ingen kategori.
- "Mer information" fäller ut **Beskrivning** (textarea), Produkttaggar, **Plats** (kombinationsruta, förifylld med kontots ort) och tre träffalternativ (kryssrutor).
- **Nästa** ger steget **"Dela på fler platser"**: en kryssruta per grupp kontot är medlem i (målgruppen förbockad, upp till 20 kan väljas), en **Marketplace**-rad och **Publicera**. Marketplace-raden är en knapp med ikryssningsikon utan aria-checked; när den slås på dyker en `role=switch` upp (Marketplace-alternativ). Föraren läser den signalen och stänger av.
- "Stäng" stänger dialogen direkt utan fråga. Messenger-panelen är också en `role=dialog` och får aldrig räknas som vår (selektorn `FB.dialog` utesluter den).
- Loopa-adressen står som ren text i beskrivningsfältet; i det publicerade säljinlägget renderas den som **klickbar länk** (via l.facebook.com) med adressen som länktext. Kortet i flödet länkar till `/commerce/listing/<id>/`.
- Skript som inte går via cli.ts måste själva läsa server/.env (`process.loadEnvFile`) före dynamiska importer, annars blir den kanoniska adressen app.loopa.nu (301 → loopa.nu). Så blev det i den första skarpa körningen; körskriptet gör det nu och vägrar utan `LOOPA_PUBLIC_URL`.

### Verifierat mot Marketplace-formuläret 2026-09-25 (svensk UI)

- Adress `/marketplace/create/item`. Första besöket i EU ger samtyckesdialogen
  `/privacy/consent/?flow=fb_dma_marketplace` ("Du måste göra ett val angående Marketplace") — kontoägarens
  val, görs för hand med `npm run facebook -- open <adress>`.
- Obligatoriskt (Nästa är inaktiv utan dem): minst ett foto, Titel, Pris, Kategori, Skick. Upp till 10 foton.
- Titel och Pris: `<label>` + `<input>`; `getByLabel(/^Titel$/)` fungerar. Prisfältet formateras med
  kontots valuta — här "$1 000" — och platsen ändrar inte det.
- Kategori: `label[role=combobox]` öppnar en dialog med en knapp per kategori under rubriker
  (Hem och trädgård → Verktyg, **Möbler**, Hushåll, Trädgård, Vitvaror …). "Möbler" är ett löv; inga
  möbelunderkategorier finns.
- Skick: `label[role=combobox][aria-haspopup=listbox]` med `role=option`: "Nytt", "Använd – nyskick",
  "Använd – i gott skick", "Använd – i använt skick".
- "Mer information" (`role=button`, `aria-expanded`) döljer Beskrivning (textarea), Tillgänglighet
  ("Publicera som endast en vara"), Produkttaggar och Plats (`input[role=combobox]`, förslag som
  "Stockholm Ort"). Kontots förvalda plats var Stocksund.
- Nästa leder till `?step=audience`: "Publicera offentligt" (här spärrad), "Publicera i dina grupper — upp
  till 20 grupper", knapparna Föregående och Publicera.
- Loopa-adressen i beskrivningen: ren text i formuläret och förhandsgranskningen (0 länkankare). Hur den
  renderas i en publicerad annons är inte observerat — ingen annons kunde publiceras.
- Formuläret säger: "När du publicerar bekräftar du att du förstår att det bara är konsumenter som får sälja
  produkter eller tjänster på Facebook." Det är ett villkor att ta ställning till innan Loopa publicerar
  som företag.

## I Loopas livscykel (2026-09-26)

**"Godkänn och lägg ut"** (`adminAnnonser.ts` `godkann`): planen `planAutoPublish` bär nu tre rader — Tradera, Blocket och **Facebook** (`integrations/facebook/queue.ts` `facebookChannelPlan`). Facebook är `configured` när `FACEBOOK_ENABLED=1`, `ready` när annonsen går att bygga (`facebookListingFor`), sessionen inte står i CHECKPOINT/RESTRICTED och någon del inte är pausad i panelen, och `alreadyRunning` när Marketplace-posten och alla valda grupper redan finns. Trycket avvisas bara när ingen av de tre kan ta emot. Efter godkännandet: stämpel → butiken live (`publish`) → `onPublished` (server.ts) → `onListingLive` → `enqueueForListing`; godkännandet knuffar dessutom `onListingLive` själv för fallet att möbeln redan låg live. `runAutoPublish` rör ALDRIG Facebook — kön och arbetarna gör det, asynkront, bakom sin egen catch. Ett Facebook-fel kan inte nå adminens svar, Tradera eller Blocket.

**Urvalet av grupper per möbel** (`membership.ts` `selectGroupsForListing`): poolen är medlem + postbar + påslagen; per möbel hoppas över: olöst manuell åtgärd på gruppen, länkförbud i reglerna (`rules.ts`, våra inlägg bär alltid adressen), annan stad, märkesgrupp för annat märke, och paus per grupp (gruppens egen takt ur reglerna, minst `FACEBOOK_GROUP_COOLDOWN_HOURS`). Poäng = relevans + möbelspecifik grupp + märke i namnet + Storstockholm. Taket är panelens **Grupper per annons** (Inställningar) eller `FACEBOOK_MAX_GROUPS_PER_LISTING` (förval 3). Skälen står i händelseloggen ("KÖAD GRUPPER") och i `EnqueueResult.groupsSkipped`. Idempotensen ligger i lagret: en post per möbel, en per möbel × grupp.

**Priset.** Kedjan är: prismotorns förslag → säljarens spann/prissteg (`priceLadder.currentPrice`, sänks 15 %/vecka) → adminens `prisNu` (flyttar stegen) → `butik/normalize.ts priceOf` = **produktsidans pris** (möbeln). Loopas kassa lägger hemleveransen (600 kr, `butik/delivery.ts`) som en egen rad. Tradera och Blocket bär i stället `prisMedHemleverans` = möbeln + 600 i ETT tal (`hemleverans.ts`). Facebook läser `product.priceSek` — samma tal som produktsidan den länkar till — och skriver leveransen som en rad ("Hemleverans i Stockholm: 600 kr (läggs till i kassan på Loopa)"). Facebook räknar aldrig själv. Buggen som hittades: adminens `prisNu` skickade möbelkronor utan 600 till Tradera (rättat i `sattPris`).

**"Köp nu".** Svenska Marketplace har ingen kassa: köparknapparna på en annons är "Skicka meddelande till säljaren", "Meddelande", "Spara", "Dela" (läst 2026-09-26). Formuläret erbjuder bara träffalternativ (offentlig plats / upphämtning / leverans vid dörren) och synlighetsbrytare — ingen frakt- eller betalfunktion. Vår annons är den vanliga lokala annonstypen; ingenting att stänga av.

**Granskningsläget.** Efter Publicera läser förarna "Säljinlägget granskas" → `moderation: FACEBOOK_REVIEW` på posten (Marketplace och säljinlägg); gruppens admin-godkännande → `ADMIN_APPROVAL`. Panelen skriver "Publicerad — granskas av Facebook".

**Såld.** Produktsidan lever (200, noindex enligt SEO-regeln) och säger "Den här möbeln har redan hittat ett nytt hem — men vi har fler alternativ för dig", utan köpknapp, med `butik/similar.ts` (bara köpbara Loopa-möbler, aldrig den själv). Gamla Facebook-inlägg städas inte (V1).

## Kommandon

```bash
npm run facebook:login                        # engångsinloggning, synligt Chromium
npm run facebook -- session                   # CONNECTED / DISCONNECTED / CHECKPOINT / RESTRICTED
npm run facebook -- discover                  # nästa handfull sökfrågor på riktiga Facebook
npm run facebook -- validate --max 6          # regler, medlemskap, skrivruta, poäng
npm run facebook -- group-dry-run <LP> <id>   # textinlägg ELLER säljinlägg, beroende på gruppens ruta
npx tsx scripts/facebook-preflight.mts "<gruppnamn>" …   # identitet, Dina grupper, målgruppernas läge (läser bara)
npx tsx scripts/facebook-kontrollerad-publicering.mts <LP> [--skarpt]   # kontrollerad körning genom kön med räcken
npm run facebook -- join --group <id>         # EN riktig ansökan, uttryckligt utpekad
npm run facebook -- recheck                   # vakten: väntande ansökningar
npm run facebook -- marketplace-dry-run <LP>  # fyll Marketplace, stanna före Publicera
npm run facebook -- group-dry-run <LP> <id>   # fyll skrivrutan, stanna före Publicera
npm run facebook -- queue                     # svep live-möbler in i kön och kör den
npm run facebook -- status
```

## Utlösaren

`butik/store.ts` → `publish()` (övergången `draft → live`) kallar lyssnarna i `onPublished`.
`server.ts` registrerar `onListingLive`, som köar Marketplace och varje grupp som är
MEMBER + postbar + påslagen. Kön drivs av `startFacebookWorkers()` i samma process, med en svepning var
minut som ställer varje live-möbel utan Facebook-post i kö (tappade händelser läker sig). Facebook kan
aldrig hindra att möbeln blir live: allt är fire-and-forget bakom try/catch.

## Idempotens och krascher

- En Marketplace-post per Loopa-ID, en grupp-post per Loopa-ID + grupp (`store.ts`, låskedja).
- `phase` skrivs till disk **före** Publicera trycks. Vid omstart: `before_publish` → köas om (högst tre
  gånger), `publish_clicked` → `NEEDS_MANUAL_ACTION` + åtgärd i panelen. Aldrig ett blint omförsök.
- Ett avbrott (inloggning, CAPTCHA, kontrollpunkt, spärr) stoppar arbetaren, skriver sessionsläget och
  en åtgärd med tid, adress, skäl, skärmbild och sista steg. Kön står stilla tills en människa markerat
  åtgärden som klar.

## Rangordning

Grund = kategori × geografi (FURNITURE_BUY_SELL 100, LOCAL_BUY_SELL 75, SECONDHAND 70,
BRAND_COMMUNITY 65, GENERAL 40; Stockholm ×1, stadsdel ×0,9, riks ×0,3, okänd ×0,2, annan stad ×0),
+ medlemsbonus (log, tak 15), + aktivitet (tak 10), + regler (ALLOWED +10, UNCLEAR −10,
PROHIBITED −50), − skrivruta (ingen −20, bara Sälj något −5). Skälen sparas per grupp och visas i
panelen.

## Regler

Förbud vinner alltid (`ingen reklam`, `inga företag`, `endast privatpersoner`, …) → PROHIBITED.
Uttryckligt tillstånd → ALLOWED. Köp/sälj-grupp med lästa regler som tiger → LIKELY_ALLOWED. Allt annat
UNCLEAR, och UNCLEAR publiceras aldrig till. Regler äldre än `FACEBOOK_RULES_MAX_AGE_HOURS` läses om
före publicering.

## Vägen till skarp drift

1. `npm run facebook:login` på servern (eller peka `FACEBOOK_PROFILE_DIR` på en befintlig profil).
2. `FACEBOOK_ENABLED=1`, behåll `FACEBOOK_DRY_RUN=true`. Fyll operatörsprofilen i panelen.
3. Kör `discover` och `validate`; granska rangordningen och reglerna i panelen.
4. Ansök i högst tre grupper (`join --group`), läs frågorna som dök upp, invänta godkännande.
5. `marketplace-dry-run <LP>` mot ett testjobb: läs stegloggen — vilka fält Facebook krävde, hur
   adressen renderades, vilken kategori som valdes. Rätta `MARKETPLACE_CATEGORY_CANDIDATES` om trädet
   ser annorlunda ut.
6. `group-dry-run <LP> <id>` i en medlemsgrupp som är postbar.
7. Först då: `FACEBOOK_DRY_RUN=false`, med gränserna kvar. Slå på `FACEBOOK_AUTO_JOIN=1` när
   ansökningarna ska gå av sig själva.
