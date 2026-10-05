# Uppladdningsflödet: alla lägen och animationer

Kartlagt 2026-10-03 mot arbetsträdet vid commit ca7535b (radnummer gäller den versionen). Syftet är att varje vänteläge,
övergång och animation säljaren möter från märkesvalet till "Möbeln är till salu" ska gå att slå upp
på sekunder, så att text och annat som ska höja konverteringen kan läggas på rätt ställe.

## Hitta allt på tio sekunder

- **Flödet ÄR switchen i `web/src/App.tsx`** (`FlowApp` rad 236, switchen rad 351). Skärmnamnen är stegen:
  `home → capture → signup → starting → identify → specs → price → analysis → result → listing`.
  Samma namn används av flödesmätningen (`web/src/lib/flode.ts`, `stegIn(screen.name)`), så
  avhopp per steg går att läsa i adminpanelens datablad (`AdminDataScreen.tsx` rad 256, "Flödet").
- **Alla väntetexter** står som svenska strängar i `t("…")`. Sök på texten ordagrant:
  `grep -rn "Bygger annonsen" web/src`.
- **Alla CSS-animationer**: `grep -n "@keyframes\|animation:" web/src/styles.css`.
- **Se väntorna utan att filma**: `npm run web:dev` och öppna
  `https://localhost:5190/wait.html` (båda laddarna sida vid sida), `/annons.html` (annonskortet +
  "Sälj med Loopa" med påhittad data) och `/dim.html` (3D-möbeln på måttsteget).
  Källorna ligger i `web/src/__dev/`. `/mobil.html` visar valfri sida i en telefonram (390 × 844),
  byt sida med knapparna eller `?sida=/vägen`.
- **Översättningar**: nyckeln är den svenska meningen. Engelska/franska läggs i
  `web/src/lib/translations/flow.ts` (vägen fram till annonsen), `listing.ts` (annonsen och
  försäljningen) och `common.ts`. En oöversatt mening visas på svenska, aldrig tom.

## Flödet steg för steg

Tabellerna listar varje läge säljaren kan hamna i, i den ordning de kommer. "Text idag" är det som
står på skärmen just nu. "Animation" pekar på CSS-regeln eller koden som rör sig.

### 0. Startsidan — `web/src/screens/HomeScreen.tsx`

| Läge | Syns när | Var | Text idag | Animation |
|---|---|---|---|---|
| Märkeslistan | alltid | HomeScreen.tsx | "Vilket märke har din möbel?" | Ingen. `MobelParad` (tre 3D-möbler, bara dator) står STILLA med flit — se kommentaren i `MobelParad.tsx`. |
| "Hur fungerar det?"-arket | tryck på länken | `components/HurFungerarDet.tsx` rad 254 | Öppningsrepliken + chatt | `hur-in`/`hur-upp` (ark glider upp), `hur-andas` (prick), `hur-puls` vid "Tänker…" — styles.css 777–912 |
| Skärmbyte (dator) | varje skärm utom kameran | styles.css 3733–3737 | — | `screen-in` 320 ms (tona in + 10 px upp) |

### 1. Inloggningsgrinden — `web/src/screens/AuthScreen.tsx`

Grinden ligger INUTI flödet (App.tsx `case "signup"`). Två varianter, styrda av `intent`:

| Läge | Syns när | Var | Text idag |
|---|---|---|---|
| `sale` — före filmningen | utloggad tryckte på ett märke | AuthScreen.tsx 204–205 | "Skapa ett konto, så filmar du ett varv runt möbeln — sedan gör vi annonsen och säljer den." / "Logga in, så fortsätter vi till filmningen av din möbel." |
| `flow` — efter filmningen | utloggad tryckte "Starta AI-analys" | AuthScreen.tsx 208–209 | "Skapa ett konto, så sätter vi igång på en gång. Du behöver inte filma om." / "Logga in, så fortsätter vi där du var. Bilderna ligger kvar." |
| `resume` — sessionen tog slut | token dog under uppladdningen | App.tsx `onNeedsLogin` | öppnar på "Logga in"-fliken |
| Knappen arbetar | efter tryck | AuthScreen.tsx 371–372 | "Skapar konto…" / "Loggar in…" |

Obs: `components/HowLoopaWorks.tsx` är en färdig, ritad fem-scens-prototyp av hela affären
(`proto-*`-animationerna, styles.css 4439–4688) som **inte är monterad någonstans** i dag. Den var
tänkt för låsskärmen. Går att sätta in på grinden utan att bygga något nytt.

### 2. Kameran — `web/src/screens/CaptureScreen.tsx`

Sju lägen (`type Mode`, rad 79): `choose | photo | guided | video | processing | cover | review`.

| Läge | Syns när | Var | Text idag | Animation / tid |
|---|---|---|---|---|
| `choose` (bara dator) | öppnas på dator | 799–935 | "Visa möbeln", "Två saker behövs: en film runt möbeln och en bild som blir annonsens ansikte…", fack 1 "Video runt möbeln", fack 2 "En omslagsbild" | `spinner-small` + "Läser bildrutor…" medan filmen läses (834, 849); `dator-ruta-over` vid drag |
| `video`, före inspelning | mobil, kameran igång | 1102–1125, overlay i `components/WalkaroundGuide.tsx` | "Gå ett varv runt möbeln", tre punkter, "Tryck på den röda knappen för att börja", väggnoten | Overlay tonar in `guide-in` 0,32 s (1371). `GuideScene lap`: telefonen går ett varv på 8,2 s (`LAP_MS`), pilarna blinkar `guide-chevron` 1,8 s (1419). Röda knappen pulserar `record-hint` 2,2 s (1431). |
| `video`, spelar in | efter tryck | 1126–1148 | "SPELAR IN {sek}s"; vägledning ur `GUIDANCE_STEPS` (50–56): "Stå framför möbeln" → "Rör dig sakta mot höger sida" → … ; "Gå långsammare — annars blir bilderna suddiga"; "{steg} — kommer du inte runt? Tryck för att avsluta" (efter 10 s) | `rec-dot` (1285). `LapRing` (1276–1350): ringen fylls med gyro-graderna, `lap-ring-lead` blinkar 1,6 s (1340), gult vid för fort. `DirectionPill` (1243) utan sensor. Max 60 s. |
| `processing` | filmen stoppad | 1162–1180 | "Bearbetar video…", "Väljer de bästa vyerna · {s} s", efter 5 s: "Lång film eller långsam avkodning — det tar aldrig mer än 20 sekunder." | `spinner` 0,8 s (1559). Vanligtvis 2–5 s, tak 20 s. |
| `cover` | efter varvet | 979–1045 | "Varvet är klart · sista bilden", "Jag är redo" / "Hoppa över", "Ta en omslagsbild", "Blev den bra?", "Ta om" / "Använd bilden" | Samma `capture-guide`-overlay som varvet. |
| `guided` (fotoguide, sex vinklar) | "Ta dem nu" / datorvalet | 1046–1101, kort i `components/PhotoGuide.tsx` | "Bild {nr} av {antal}", stationens titel + instruktion, "Välj bild", "Nästa"/"Hoppa över", "Klar ({antal})" | `GuideScene at`: telefonen GLIDER till nästa station på 560 ms (`MOVE_MS`). |
| `photo` (manuellt) | "Ta fler bilder" | 937–978 | "Ta bild", "Klar ({antal})" | Ingen. |
| `review` | efter bearbetningen | 1192–1240 | "Dessa vyer kommer att inspekteras", "{antal} av högst {max} bilder valda.", "Saknas: {vyer}…", **"Starta AI-analys"** | Ingen. Sista skärmen före grinden/uppladdningen. |

### 3. Uppladdningen — `App.tsx` `StartingJob` (604–685)

| Läge | Var | Text idag | Animation / tid |
|---|---|---|---|
| Laddar upp | 677–684 | "Laddar upp bilder…", "Analysen startar av sig själv när de är uppe" | `spinner`. Sex bilder à ≤1280 px; några sekunder. |
| Fel | 657–673 | "Bilderna kom inte fram", felet, "Försök igen", "Tillbaka till bilderna" | — |

### 4. Modelletningen — `App.tsx` `IdentifyGate` (687–827)

| Läge | Var | Text idag | Animation / tid |
|---|---|---|---|
| Letar | App.tsx 758–764 → `components/ModelSearchWait.tsx` | "Letar upp modellen…" / "Jämför med {märke}-modeller som matchar bilderna", rubriken "Det svåra är redan gjort. Du har tagit bilderna." och jämförelsen "Sälja själv / Med Loopa". Vid omval: "Letar efter andra modeller…" / "Söker vidare bland … — de du sagt nej till räknas bort" | Bågen går runt plattan på 1,6 s (`vanta-dash`), paren växlar var 2,6 s med intoning (`jamfor-in`). Se element-för-element-avsnittet sist i filen. **10–20 s — den längsta väntan i flödet.** |
| Välj modell | `screens/ModelSelectScreen.tsx` | "Vilken modell är det?", "Vi hittade {antal} modeller som stämmer med bilderna. Välj den som är din.", "Ingen av dem?" "Hitta nya" / "Skriv manuellt" | `FlowSteps` steg 1/4. Kandidatbilder utan URL skimrar `is-searching` (`price-shimmer` 1,4 s, 2442) tills bilden landar. |
| Fallet | 769–780 | "Vi fick inget svar från servern." / "Analysen avbröts." / "Vi kunde inte söka fram några modeller just nu." + manuell inmatning | — |

### 5. Annonsbygget — `App.tsx` `BuildingListing` (584–593)

Samma skärm visas av FYRA grindar i rad, direkt efter modellvalet. Ser ut som en vänta för säljaren:

| Grind | Var | Visar `BuildingListing` när | Tak |
|---|---|---|---|
| `IdentifyGate` | 745 | modellen just valdes (`sent`) | tills nästa skärm ritas |
| `DisclosuresGate` | 894–942 | jobbet inte lästs än (`!loaded`) | en hämtning, < 1 s |
| `VariantGate` | 829–892 | variantlistan inte kommit (`!klar`) | 12 s |
| `SpecsGate` | 944–989 | `listing.status === "pending"` | 300 s (`CLIENT_GIVE_UP_MS`) |

| Läge | Text idag | Animation / tid |
|---|---|---|
| Bygger | Byggd om 2026-10-04: `components/ListingBuildWait.tsx`. Verbet Mäter / Slår upp / Synar / Prissätter, "Bygger annonsen för {märke} {modell}…" (eller "Bygger annonsen…" när grinden inte läst jobbet än), "När den är publicerad kan du luta dig tillbaka." med fyra numrerade steg där det aktiva lyser upp | Platta med soffa och lupp som rör sig (7 s), linjal vars linje fylls på 2,6 s (`bygg-prog`), stegen byts var 2,6 s. Se element-för-element-avsnittet sist i filen. **~10–20 s totalt**, men frågorna nedan läggs FRAMFÖR väntan så den ofta inte syns. |
| Fel | App.tsx 959–986 | "Annonsen blev inte klar" / "Annonsen kunde inte skapas", "Fortsätt ändå" / "Fortsätt till priset ändå", "Byt modell" | — |

Mellan grindarna, utan animation (formulär):

- `screens/DisclosuresScreen.tsx`: "Två/Tre frågor om möbeln", "Har du pälsdjur i hemmet?", "Luktar möbeln något?", "Hur många stolar säljer du?", hint rad 120: **"Annonsen byggs medan du svarar."**
- `screens/VariantScreen.tsx`: "Vilken variant är det?", "Måtten i annonsen hämtas för den variant du väljer." Visas bara vid ≥ 2 varianter.

### 6. Mått och specifikationer — `web/src/screens/SpecsScreen.tsx`

| Läge | Var | Text idag | Animation |
|---|---|---|---|
| Kortet | 140–280 | "Måtten", "Måtten är uppmätta av andra säljare av samma modell. Stämmer de på din?", "Specifikationer", "Annonstext", knappen **"Se prisförslaget"** | `FlowSteps` 2/4. `components/FurnitureRender.tsx` 94–110: 3D-möbeln svänger in och vaggar sedan (`INTRO_MS` + `SWAY_MS`, requestAnimationFrame); stannar när säljaren drar i den och pausar utanför bild. |

### 7. Prisförslaget — `web/src/screens/PriceScreen.tsx`

| Läge | Var | Text idag | Animation / tid |
|---|---|---|---|
| Räknar | 84–94 | "Prisförslag", sedan EN av: "Bedömer skicket…" (inget resultat än) → "Väger in skadorna…" (`reviewPending`) → "Räknar fram priset…"; "Priset räknas när besiktningen är klar — skadorna påverkar det." | `price-skeleton` skimrar `price-shimmer` 1,3 s (2015–2020). Prismotorn ~15 s EFTER skadelistan. |
| Klart | 102–144 | "Uppskattat värde", spannet "säljs snabbt / säljs långsamt", "Bygger på {antal} liknande annonser", "Skadorna vi hittade drar ner priset {andel} %." + `PriceLadderPicker` | — |
| Inget/fel | 76–81, 96–101 | "Priset kunde inte hämtas" / "Inget prisförslag den här gången" + `ManuellPrisplan` | — |
| Knappen | 151–167 | "Se skickbedömningen" med metatext **"arbetar…"** → "klar"; hint "Besiktning, prissättning och annons kör parallellt." → "Skadelistan och annonsen är klara." | Ingen rörelse — bara textbytet. |

### 8. Analysen — `web/src/screens/AnalysisScreen.tsx`

Mörk skärm. Oftast kort eller osynlig: besiktningen körde parallellt sedan modellvalet.

| Läge | Var | Text idag | Animation |
|---|---|---|---|
| Checklistan | 143–165 | Märke + modell, första bilden, "Bilder förberedda" → "Inspekterar möbeln" → ("Kontrollerar osäkra fynd") → "Sammanställer skicket" → "Hämtar prisförslag" | Aktivt stegs prick pulserar `pulse` 1,2 s (1719); klara steg får grön bock. Pollar var 0,5 s. |
| Tyst server | 160–163 | "Ingen kontakt med servern just nu — vi fortsätter försöka." | efter 5 missade svar |
| Fel | 102–128 | `explainError`-titel + text, "Försök igen", "Tillbaka till start", "Tekniska detaljer" | `failure-card` |

### 9. Skickbedömningen — `web/src/screens/ResultScreen.tsx`

| Läge | Var | Text idag | Animation |
|---|---|---|---|
| Laddar | 77–82 | "Laddar resultat…" | `spinner` |
| Andrabesiktning | 183–188 | "Andrabesiktningen pågår — listan kan ändras när den är klar." | `review-spinner` 0,8 s (1846) i gul banderoll |
| Kortet | 190–260 | betyg + motivering, "Vi hittade {antal} synliga skador", "Lägg till skada med närbild" | — |
| Knappen | 271–280 | **"Se annonsen"** med metatext "skapas…" → "klart"; hint "Sista steget före försäljningen. Annonsen är det köparen ser — skadorna du rättat här följer med dit." | textbyte |

### 10. Annonsen och försäljningen — `web/src/screens/ListingScreen.tsx` + `components/SellWithLoopa.tsx`

| Läge | Var | Text idag | Animation / tid |
|---|---|---|---|
| Annons väntar | ListingScreen 171–176 | "Annons", "Letar upp modell och specifikationer…" | `price-skeleton` |
| Annonskortet | `components/ListingView.tsx` | bilder, text, specar, chatt | Chattens "skriver"-prickar `card-chat-dot` (3067) |
| Sälj-rutan, vila | SellWithLoopa 250–285 | "Sälj med Loopa", "Vi lägger ut möbeln, sköter annonsen och hör av oss så fort den är såld.", knappen **"Sälj med loopa"** | — |
| Bekräftelsen | `SellConfirm` 410–675 | "Det här läggs ut", "{pris} för möbeln + {frakt} hemleverans", gratisförsäljningen, "Du får", villkoren, **"Ja, sälj den"** | Modal: `sell-modal-fade`, `sell-modal-rise` 380 ms (2273–2280), `sell-modal-pop` 260 ms (4197) |
| Lägger ut | 226–231 | "Lägger ut möbeln till salu…", "Annonsen köas och bilderna laddas upp. Det tar oftast under en minut." | `spinner-small`. Pollar servern; vanligen < 60 s. |
| Kvittot | `KvittoVagar` 344–408 | "Vi tar över försäljningen", "Till mina annonser", "Sälj en till möbel" | `sell-kvitto` helsida |
| Feedback | `components/ProcessFeedback.tsx` | "Vad tyckte du om processen?", skala 1–5 "Krångligt … Väldigt enkelt", "Hoppa över" | Samma modalanimation; tacket stänger sig efter 1,6 s |
| Klart | 174–185 | "Möbeln är till salu", `LadderStatus` ("Ligger på …", "Nästa sänkning …"), "Se annonsen" | — |
| Fel | 255–281 | "Annonsen kunde inte läggas ut: {fel}", "Försök igen" | — |

## Globalt, ovanpå alla steg

| Vad | Var | Animation |
|---|---|---|
| Cookierutan | `components/CookieConsent.tsx` | `consent-in` 340 ms (4331) |
| "Din nästa försäljning är gratis!" | `components/GratisPopup.tsx` | `sell-modal-fade` + `sell-modal-rise` (5113–5118). Dyker upp var som helst i flödet när vännens annons är uppe. |
| Språkmenyn | `components/LanguagePicker.tsx` | `lang-menu-in` 140 ms (460) |

## Reducerad rörelse

Allt ovan stängs av eller saktas ner vid `prefers-reduced-motion: reduce`. Reglerna ligger på fem
ställen i `styles.css`: 979 (arket), 1437–1440 (kameran), 2493–2508 (väntorna och skeletten),
4251–4252 (skärmbytet), 4686–4688 (prototypen). Ny animation ska få en rad i rätt block.

## Var text naturligt får plats

Varje vänteskärm har samma tre slottar, i den här ordningen: `.wait-title` (fet rad),
`.muted.small` (en eller två underrader) och i laddarna `.wait-word` (ordet som växlar). Knapparna
vidare har `.next-step-meta` (status i knappen) och `.form-hint` under. Att lägga en rad till är
alltså ett `<p className="muted small">` i rätt block — ingen ny CSS behövs.

De längsta pauserna, där en mening hinner läsas:

1. Modelletningen (steg 4): 10–20 s. Har sedan 2026-10-03 rubriken och jämförelsen "Sälja själv / Med Loopa".
2. Prisskelettet (steg 7): ~15 s efter skadelistan.
3. "Lägger ut möbeln till salu…" (steg 10): upp till en minut.
4. Annonsbygget (steg 5): 10–20 s, men oftast täckt av frågorna. Har sedan 2026-10-04 möbelns namn och stegen "När den är publicerad kan du luta dig tillbaka".
5. Bearbetar video (steg 2): 2–5 s.

## De två prioriterade skärmarna, element för element

### "Letar upp modellen…" (väntan efter uppladdningen)

Byggd om 2026-10-03 efter skissen "Granskar 2a". Hela skärmen är en komponent,
`web/src/components/ModelSearchWait.tsx`, som `IdentifyGate` i `App.tsx` ritar med märket och om det
är ett omval. Uppifrån och ned:

| Det man ser | Element | Kod | Rörelse |
|---|---|---|---|
| Rundad ram med orange båge | `.vanta-ring-track` / `.vanta-ring-arc` | `ModelSearchLoader.tsx`, CSS `.vanta-loader` | bågen går runt på 1,6 s (`vanta-dash`) |
| Vit platta med soffa | `.vanta-tile` | samma | stilla |
| "Letar upp modellen…" + "Jämför med IKEA-modeller som matchar bilderna" | `.vanta-status` (role=status) | `ModelSearchWait.tsx` | — |
| "Det svåra är redan gjort. Du har tagit bilderna." + "Resten av försäljningen sköter Loopa." | `.vanta-head` | `ModelSearchWait.tsx` | — |
| Två rutor "SÄLJA SJÄLV" (överstruket) / "MED LOOPA" (bock) | `.jamfor` med `.jamfor-sjalv` / `.jamfor-loopa` | paren i `PAR` överst i `ModelSearchWait.tsx` | nytt par var 2,6 s, tonar in 0,45 s (`jamfor-in`) |
| Fem prickar | `.vanta-dots` | samma | den aktiva blir en orange stapel |

Omvalet ("Hitta nya") använder samma skärm med "Letar efter andra modeller…" och "Söker vidare bland …
— de du sagt nej till räknas bort". Paren ändras i listan `PAR`; nya meningar får en rad i
`translations/flow.ts`. Allt står centrerat lodrätt och vågrätt (`.vanta-inner` med auto-marginal); under 480 px staplas
de två rutorna med samma minsta höjd. Reducerad rörelse stänger av bågen och intoningen (styles.css,
blocket `prefers-reduced-motion`). Förhandsvisning utan att filma: `https://localhost:5190/wait.html`.

### "Bygger annonsen…" (väntan efter modellvalet)

Byggd om 2026-10-04 efter skissen "Fördelar 3b + skanning". Hela skärmen är
`web/src/components/ListingBuildWait.tsx`; `BuildingListing` i `App.tsx` ritar den med möbelns identitet
från den grind som visar den. Den gamla laddaren med lupp och måttband (ListingBuildLoader) är borttagen,
men luppens rörelse lever vidare på den nya plattan.

| Det man ser | Element | Kod | Rörelse |
|---|---|---|---|
| Vit platta med soffa, lupp och två fynd | `.bygg-tile`, `.bygg-loupe`, `.bygg-mark-a/b`, `.bygg-tile-sofa` | SVG inline i `ListingBuildWait.tsx`, CSS `bygg-loupe` / `bygg-mark-*` / `bygg-flinch` | luppen glider från vilopunkten till två fynd och tillbaka på 7 s, märkena poppar när den stannar, soffan rycker till |
| Linjal med orange linje | `.bygg-ruler` / `.bygg-fill` | CSS `bygg-prog` | linjen fylls på 2,6 s och börjar om; mäter ingen progress |
| "Mäter…" / "Slår upp…" / "Synar…" / "Prissätter…" | `.bygg-verb` | listan `VERB` i `ListingBuildWait.tsx` | byts var 2,6 s, dekor |
| "Bygger annonsen för IKEA Söderhamn…" | `.bygg-status` (role=status) | modellen från valet (`vald` i IdentifyGate) eller `job.identity` | — |
| "När den är publicerad kan du luta dig tillbaka." + fyra numrerade steg i ett vitt kort | `.bygg-why`, `.bygg-list`, `.bygg-item`, `.bygg-n`, `.bygg-t`, `.bygg-b` | listan `STEG` i `ListingBuildWait.tsx` | det aktiva steget lyser upp (`.on`) var 2,6 s med mjuk övergång; listan går runt, inget bockas av |

Stegen: Annonsen publiceras · Loopa sköter köparna · Köparen betalar till Loopa · Hämtas — du får
betalt. Varje rad är ett löfte som redan står i HowLoopaWorks eller säljbekräftelsen. Nya rader får
en översättning i `translations/flow.ts`. Reducerad rörelse låter linjen och luppen stå still och stegen
byta utan övergång. Förhandsvisning: `https://localhost:5190/wait.html#bygger`, i telefonram via `/mobil.html`.

### "Sälj med Loopa" (sista sidan, annonsen)

Sidan är `web/src/screens/ListingScreen.tsx`. Kortet ritas av `ListingView` (hopfällda sektioner så
att säljrutan ryms på första skärmen), och säljrutan monteras SIST på kortet på rad 216–221.

Rutan är `web/src/components/SellWithLoopa.tsx`, vilolaget rad 276–347:

| Det man ser | Element | Rad |
|---|---|---|
| Rubriken "SÄLJ MED LOOPA" | `.card-block h3` | 282 |
| "Vi lägger ut möbeln, sköter annonsen och hör av oss så fort den är såld." | `.muted.small` | 293–295 |
| "Du får 7 400 kr" + "av 8 400 kr — Loopa tar 1 000 kr" (tillagt 2026-10-03, serverns `villkor`) | `.sell-utfall` | 305–317 |
| Knappen "Sälj med loopa" | `.btn.btn-primary` med `.ordmark` | 320–333 |
| "Läggs ut på" + märke och namn per kanal: Loopa Butik (utan märke), Tradera, Blocket, Marketplace (tillagt 2026-10-03, ur `state.channels`; loggorna i `web/src/assets/kanaler/`) | `.sell-kanaler` | 349–357, kanaltabellen rad 23–30 |
| Fel ovanför | `.sell-error` | 284 |
| Spärrad ("Möbeln går inte att lägga ut till salu än.") | `.muted.small` i stället för knappen | 246–254, 287 |

CSS för rutan: `.sell-block` styles.css 2198–2228 (`.sell-utfall` och `.sell-kanaler` ligger där). Knappen öppnar `SellConfirm` (rad 410–675),
därefter "Lägger ut möbeln till salu…" (226–231), kvittot `KvittoVagar` (344–408), feedbackrutan
och "Möbeln är till salu" (174–185). Hela sidan går att titta på utan att filma:
`npm run web:dev` och öppna `https://localhost:5190/annons.html`.
