# Beslut under bygget av köpsidan

Loggen är kronologisk. Varje post säger vad som var oväntat, vilket val som gjordes, och varför det
är det säkraste reversibla alternativet. Ordningen är byggordningen.

---

## 0. Ingen produktionsdata att migrera

**Upptäckt:** `server/data/butik/bevakningar.json` finns inte. Noll sparade sökningar, noll loggade
matchningar.

**Beslut:** Migreringsvägen byggs och testas ändå, mot en syntetisk fil. Den körs vid uppstart och är
idempotent.

**Varför:** Vägen behövs den dag en miljö *har* filen — utveckling här är inte den enda miljön. Att
hoppa över den för att den här maskinen råkar sakna data hade gjort produktionsdata till en
överraskning i stället för ett testfall.

**Följd:** Bevisremsan och prognosen på köpsidan har ingen data att visa och döljer sig själva enligt
regeln om påhittade siffror. Det är avsett och inte ett fel.

---

## 1. Okänt mått är inte samma sak som för stort

**Upptäckt:** Skarp körning av direktsvepet, fallet "Matbord, max 3 000 kr, max 160 cm", gav **noll
kandidater** — vilket bryter mot aldrig-noll-kravet. Orsaken är att nästan ingen Tradera-annons anger
bredd, och regeln "ett saknat mått fäller möbeln när köparen satt en gräns" fällde därmed allt.

**Beslut:** Tre utfall i stället för två. Ett mått kan vara `inom`, `över` eller `okänt`.

- **Notiser och strikt matchning:** okänt behandlas som över. Oförändrat — vi väcker aldrig någon
  för en möbel vi inte vet får plats.
- **Direktsvep och digest (generöst):** okänt blir en nära-träff med en ärlig etikett — "måtten står
  inte i annonsen". Vi påstår inte att den passar; vi säger att vi inte vet.

**Varför det är det säkraste alternativet:** motsatserna är sämre åt varsitt håll. Att behandla okänt
som inom hade betytt att vi visar en soffa som *påstås* passa och kanske inte gör det. Att behålla
noll hade betytt att den vanligaste efterlysningen — möbel med måttgräns — alltid möts av en tom
skärm, eftersom de flesta annonser saknar mått. Den tredje vägen säger sanningen: vi vet inte, du
får avgöra.

**Reversibelt:** en flagga i `evaluate` (`generous`) styr det. Slås generositeten av beter sig
matchningen exakt som förut.

---

## 2. "Inte String" om en String-hylla

**Upptäckt:** Samma körning. Efterlysningen "String-hylla i valnöt" fick fyra Tradera-träffar vars
etikett löd *"Inom pris och mått — men inte String och inte valnöt"* — om annonser som heter
"STRING vägghylla" och "Stringgavlar (String)".

Orsaken: Tradera-varor får `brand: null` när märkesigenkänningen inte träffar, och koden läste
frånvaro av märke som fel märke.

**Beslut:** Ett mjukt villkor kan nu vara `ok`, `fel` eller `okänt`, och etiketten skiljer på dem:

- fel → "blå, inte grön"  (vi vet, och det stämmer inte)
- okänt → "färgen framgår inte" (vi vet inte)

Märket prövas dessutom mot rubriken när fältet är tomt, eftersom "STRING vägghylla" bär märket i
titeln.

**Varför:** en mening om varför vi visar något får inte påstå mer än vi kan belägga. "Inte String" är
ett påstående om möbeln; "märket framgår inte" är ett påstående om annonsen — och bara det andra är
sant här.

**Effekt på rangordningen:** ett känt fel väger tyngre än ett okänt. Den som vet vad den vill ha ska
få de belagda träffarna först.

---

## 3. Deterministiskt skyddsnät för de hårda fälten

**Upptäckt:** Skarp körning av tolkningen. Meningen *"grön sammetssoffa, 3-sits, max 6000 kr och
högst 220 cm bred"* gav bara `{categorySlug: "soffor-fatoljer"}` — pris, bredd, färg och material
föll bort. Samma modell fick däremot både pris och bredd rätt på *"matbord innan jul, max 160 cm,
budget 3000"*. Det är den variation `cacheMaxAgeMs`-kommentaren i aiSearch.ts redan beskriver.

**Beslut:** Ett skyddsnät i kod som fyller i **pris och mått** när tolkningen lämnat dem tomma, läst
med snäva mönster ur samma mening. Det får bara LÄGGA TILL — ett fält modellen fyllt i rörs aldrig.

**Varför bara pris och mått:** de är efterlysningens hårda gränser, de som aldrig får brytas. Att
tappa dem betyder att svepet visar möbler köparen inte kan köpa eller inte får plats med — precis
det fel hela matchningen är byggd för att undvika. Färg och stil är mjuka: tappas de blir träffarna
sämre rankade, inte fel.

**Varför inte bara skärpa prompten:** en prompt kan bli bättre men aldrig garanterad, och det här är
fält där ett bortfall ger fel produkt. Nätet kostar noll modellanrop och går att läsa och testa.

**Reversibelt:** en ren funktion (`backstop.ts`) som anropas på ett ställe i `parse()`.

**Tillägg till #3 (färg och material):** Skarp körning genom den nya API-vägen visade att "grön" föll
bort ur *"grön sammetssoffa max 6000 kr"* — sammanfattningen förblev ärlig (den nämnde ingen färg),
men köparen som skrev "grön" och fick sex soffor utan färgkrav hade ändå inte blivit hörd. Nätet
täcker därför även färg och material, ur slutna ordlistor.

Tre fel hittades och rättades i den utvidgningen, alla i skarp körning:

- `"ekbord max 160 cm"` → pristak 160 kr. Ett tal följt av en längdenhet är ett mått, inte ett pris.
- `"grön sammetssoffa"` → inget material. Långa materialord måste få sitta i sammansättningar.
- `"vitrinskåp"` → vit, och `"bokhylla"` → bok. Färgord tar böjningsändelser (t, tt, a, e), inte
  fogar; korta träslag måste stå som eget ord eller före en möbeldel. "bok" och "al" ströks helt.

Stil och epok lämnas åt modellen: "60-tal", "funkis", "lantligt" är en öppen mängd, och en ordlista
över dem hade varit en gissning om vad folk säger snarare än en avläsning av vad de sa.

---

## 4. Notiser utan e-postleverantör: inkorgen är primär kanal

**Läge:** Projektet har ingen e-postavsändare — varken paket, nyckel eller avsändaradress.

**Beslut:** In-app-inkorgen är den primära kanalen, inte ett komplement till brevet. Brevet är en
påminnelse om inkorgen. Två adaptrar bakom samma gränssnitt: `file` (förval) skriver färdigrenderade
brev till `/outbox`, `none` gör ingenting och säger det.

**Varför inkorgen först:** den når mottagaren oavsett vilket beslut som fattas om leverantör, den
ligger kvar, går att läsa om, och kan peka rakt in i den efterlysning som orsakade den. Ett system
byggt kring brevet hade stått stilla tills någon valt leverantör.

**En okänd `EMAIL_PROVIDER` faller till `file` och loggar det.** Att kasta hade stoppat en hel
pulskörning för en felstavad miljövariabel; att tyst falla till `none` hade tappat breven.

---

## 5. Två textfel funna genom att läsa breven i /outbox

Verifieringen är att mappen går att läsa. Den läsningen hittade två fel som inga tester fångade:

**Deadline-brevet motsade sig själv.** Det skrev *"Inget stämmer helt, men de här är närmast"* ovanför
en lista där varje rad löd *"Uppfyller allt du bad om"* — och köparen hade redan fått en träffnotis om
exakt samma möbler. Ventilen tiger nu när de exakta träffarna redan är notifierade om, och byter
rubrik när det ändå finns exakta.

**Förnyelsebrevet skrev "bevakat den i 0 dagar".** Sant men läser som ett fel. Under ett dygn säger
brevet vad vi gjort i stället för hur länge vi gjort det.

---

## 6. Väggen får aldrig överdriva en köpares budget

**Upptäckt:** Två fel, båda i samma mekanism, båda funna genom att köra väggen på riktig data.

**Först:** prisbandet la 4 000 kr i spannet *"upp till 6 000 kr"*. Det överdriver köparens budget för
varje säljare som läser väggen — en förhandlingsposition given bort gratis, av precis det system som
finns för att inte ge bort något om köparen. Banden avrundas nu **nedåt**, alltid: 500 kr upp till
tretusen, tusen däröver. En köpare får hellre framstå som snålare än de är; det kostar dem ingenting,
medan motsatsen kostar pengar.

**Sedan:** med bandet i grupperingsnyckeln hamnade två köpare av samma gröna soffa på **skilda rader**
— den ena 5 500 kr, den andra 6 000 — med var sin stadsdel. Två sådana rader pekar ut mer än en rad
med två. Priset ingår därför inte längre i nyckeln, och gruppen bär det **lägsta** taket i sig:
varken det högsta eller ett snitt, eftersom båda hade överdrivit någons budget.

**Effekt:** samma ändring förbättrar både integriteten och säljargumentet. "2 köpare söker detta" är
starkare än två rader med en var.

---

## 7. Annonstexten skrivs i kod, inte av en modell

**Beslut:** Efterfrågeannonsernas rubrik och brödtext byggs ur mallar i `demandAds.ts`.

**Varför:** en annons är Loopas ord i offentligheten, körd med budget mot en publik som aldrig hört
talas om oss. En genererad mening blir bra nio gånger av tio och pinsam den tionde — och den tionde
är den som kostar pengar. Mallarna är tråkiga och sanna, vilket är rätt ordning på de två.

Detsamma gäller `fitNote` i matchningen (se #2): meningar som förklarar ett systembeslut får inte
kunna hitta på ett skäl.

**Tre fel funna i skarp körning av generatorn:**

- Panelen grupperade fortfarande på prisband, så två köpare av samma String-hylla (4 000 och 4 500 kr)
  fick `unmet: 1` var — under tröskeln för ett utkast. Efterfrågan fanns men delades sönder av en
  indelning som inte handlar om vad folk söker. Samma rättelse som på väggen (#6).
- `utm_campaign` bar `%C2%A0` mitt i sig, från prisbandets hårda mellanslag. Giltigt, oläsligt i
  varje rapport parametern dyker upp i.
- Rubriken löd *"Har du en soffor & fåtöljer?"* — katalogens etiketter är plural eftersom de står
  över ett rutnät. En annons som inte kan skriva sin egen rubrik inger inget förtroende för att
  kunna sälja någons möbel.

---

## 8. Ental och plural: samma fel tre gånger

Katalogens etiketter är plural ("Soffor & fåtöljer", "Stolar") eftersom de står som rubriker över ett
rutnät. Tre gånger under bygget hamnade de i en mening som handlar om EN möbel, och tre gånger gick
felet ut i skarp körning innan det syntes:

- *"Har du en soffor & fåtöljer?"* — annonsutkastets rubrik
- *"innehåller troligen din stolar"* — tömningsbrevets ämnesrad
- *"ca 22 st stol"* — rättningen av det förra, som gick för långt åt andra hållet

**Beslut:** `categoryNoun(slug)` bor i `butik/catalog.ts` bredvid `categoryLabel`, och båda formerna
används där de hör hemma: ental för "din stol", plural för "ca 22 stolar", och ental igen när antalet
är ett.

**Varför det hör hemma i katalogen:** annonsutkasten och tömningsbreven är två filer som aldrig läser
varandra. En lokal ordlista i vardera hade gett två listor som glider isär — och den som lägger till
en kategori ska inte behöva veta att det finns två ställen till att uppdatera.

---

## 9. En efterlysning utan konto, men med e-post

**Konflikt:** Efterlysningsfångaren på /kop tar kategori, maxpris och **e-post** — inget konto. Men
modellen från steg 1 kräver `userId`, och alla sju konsumenter (sveparen, pulsen, väggen, panelen,
tömningarna) filtrerar på just det fältet. En e-postefterlysning hade sparats och sedan aldrig
bevakats av någon.

**Beslut:** Kravet är inte ett konto — det är **en väg att nå personen**. Filtret byts från
`e.userId` till `nabar(e)`, som är sant när `userId` **eller** `email` finns.

**Varför:** motivet bakom kravet var alltid "en bevakning åt någon vi inte kan nå är ett löfte vi
inte kan hålla". En e-postadress uppfyller det motivet lika bra som ett konto. Att kräva konto för
en enrads-formulär hade dessutom flyttat konverteringen till fel ställe: sidan finns för att fånga en
avsikt, inte för att värva medlemmar.

**Följder, alla avsiktliga:**

- **Inkorgen** kräver fortfarande konto — den är personlig och slås upp på `userId`. En
  e-postefterlysning når mottagaren via brev, vilket är den kanal de valde.
- **Väggen** tar med dem: efterfrågan är efterfrågan oavsett hur köparen registrerades, och raderna
  är ändå anonymiserade.
- **Ägarkontrollen** är oförändrad. `forUser` och `remove` slår fortfarande på `userId`, så en
  e-postefterlysning går inte att lista eller radera via kontovägarna. Den som senare skapar ett
  konto med samma adress kopplas inte automatiskt — det vore en gissning om identitet.

---

## 10. SVG och CSS i stället för Lottie

**Beslut:** Fyrscensanimationen på /kop är SVG med CSS-animation, inte Lottie.

**Varför:** `lottie-web` är ~300 kB som måste laddas innan något rör sig — på en sida vars uttalade
krav är att LCP ska vara heron och att animationen ska lazy-laddas. Repot har dessutom noll
körtidsberoenden i webben, och ett bibliotek för en enda animation är en ny sorts sak att underhålla.

**Bytbarheten finns kvar**, som briefen kräver: varje scen är en egen komponent i
`web/src/kop/animation/`, och illustrationerna är rena `<svg>`-block utan logik. Att byta scen 2 mot
en riktig illustration är att skriva över en fil.

Skulle Lottie ändå väljas senare är scenerna redan avgränsade en och en, och `<LottiePlayer>` kan
ersätta `<Scen2>` utan att röra tidslinjen.

---

## 11. Chatten togs bort från /kop, men parsern lever

**Beslut:** `EfterlysningChat` och dess kort (`SpecCard`, `TraffLista`) är raderade — sidan har inget
LLM-anrop längre. Serverns tolkning (`efterlysning/parse.ts`, `backstop.ts`, det utökade
`interpretQuery`) och dess vägar ligger kvar orörda.

**Varför inte radera allt:** koden kostar ingenting när den inte anropas, den är testad, och den
lösta uppgiften — svenska till ett `ProductFilter` med skyddsnät för de hårda fälten — är inte
knuten till en chatt. Butikens AI-sökning använder samma väg redan i dag. Att riva ut den hade
kastat bort ett arbete som fungerar för att en av två ingångar ändrades.

**Vad som ÄR borta:** varje anrop från köpsidan. Den laddar inget, väntar på inget och kan inte
kosta en modellkörning.

---

## 12. Två filer ägde `.hero`

**Upptäckt:** Den nya heron blev tvåspaltig på desktop — underrubriken hamnade bredvid rubriken i
stället för under. Orsaken var en kvarglömd regel i `butik.css` från butikens avvecklade
landningssida: `@media (min-width: 900px) { .hero { display: grid; ... } }`.

**Beslut:** 216 rader döda regler (`.hero*`, `.hero-preview*`, `.how*`, `.shelf-intro`) borttagna ur
`butik.css`, med en kommentar kvar på platsen om varför.

**Lärdomen är värd raden:** två stilmallar som äger samma klassnamn är en fälla som gillras i tysthet
och löser ut långt senare, i en annan fil, för någon annan. Köpsidans egna klasser heter numera
`hero-*` bara i `kop.css`, och butiken har inga kvar.

---

## 13. Fyllda former i stället för konturikoner

**Beslut:** Både animationens scener och de fyra stegikonerna ritades om från tunna konturer till
fyllda former med massa, mjuka radier och accentfärg.

**Varför:** en soffa ritad som en konturikon läser som *symbolen för möbel*, inte som en möbel. Det
språket hör hemma i en verktygsrad, där ikonen står bredvid ett ord som förklarar den. Här är bilden
hela budskapet, och den har en halv sekund på sig.

**Scenerna fick en egen palett.** Första försöket återanvände `--surface` och `--field`, som är
gjorda för att ligga nästan omärkligt ovanpå varandra i ett gränssnitt — en soffa målad i dem
försvann i kortet den stod på. Scenernas toner är samma familj men med verklig separation:
möbelkroppen mörkare än kortet, dynorna ljusare än kroppen, accenten sparad till det som ska pekas ut.

**Två fel funna genom att titta:**

- Prisremsan i scen 2 låg bredvid soffan, krockade med armstödet och klipptes av ramens kant. Den
  ligger nu ovanför, där det är tomt.
- Det aktiva stegets ikon försvann i sin egen knapp: `:hover` mörknade ikonen även på det aktiva
  steget, vars bakgrund redan är mörk. Det syntes bara i just det läge man alltid hamnar i —
  markören ligger kvar på steget man nyss klickade på. Hovern gäller nu bara vilande steg.

---

## 14. Toppraden: sökknapp, rund profil, orange ordmärke

**Sökfältet blev en knapp.** Ett fullbrett fält högst upp sa att sidan handlar om att söka i vårt
lager. Det gör den inte — den handlar om en möbel besökaren hittat någon annanstans, och den saken
ska äga blicken. Fältet finns kvar, ett tryck bort.

**Profilen är en rund knapp med bild eller initial — eller "Logga in".** Skillnaden är avsiktligt
tydlig: en avatar säger *du är inne*, en textknapp säger *du är inte*. En generisk gubbe hade sagt
ingetdera.

**Ordmärket är orange i Poppins 800**, samma snitt och vikt som säljverktygets `.app-wordmark`. Det
är ett märke och ska se likadant ut var det står. Punkten är mörk nu när ordet självt bär färgen —
två oranger bredvid varandra gjorde punkten osynlig.

---

## 15. Inloggning frågas, den krävs inte

**Beslut:** Att klistra in en länk eller gå vidare till lagret öppnar en inloggningsruta ovanpå
sidan. Den som redan är inne märker ingenting.

**En fråga, inte en mur.** Sidorna bakom finns kvar: de är server-renderade, de indexeras, och en
delad länk till en möbel öppnar möbeln. Att låsa in dem hade kostat både sökbarheten och den som
klickat sig hit från en kompis.

**Varför fråga alls:** allt som följer efter länken — analys, inbjudan, betalning, leverans — kräver
ett konto ändå. Att fråga när avsikten är som starkast är vänligare än att fråga tre steg senare, när
någon redan lagt tid på det.

**Att veta:** det här gör /kop till en sida där de flesta möter en inloggningsruta. Konverteringen
mäts av `logga_in_fraga` mot `hero_submit` — visar den att folk faller av vid rutan är beslutet
enkelt att backa, eftersom grinden är ett enda anrop (`fragaOmInloggning`) på tre ställen.

---

## 16. Bläddra på märke, inte på "vårt utbud"

**Beslut:** Produktraden "Eller köp direkt ur vårt granskade utbud" är ersatt av en märkessektion
med en sökrad över brickorna.

**Varför:** märket är hur folk faktiskt letar begagnade möbler. *"Finns det någon Lamino?"* är
frågan; *"visa mig era nyinkomna"* är det inte. Åtta produktkort svarade på fel fråga — de visade
vad vi råkade ha, inte vad någon sökte.

**Båda källorna bakom varje bricka.** Ett klick ger märkets hela utbud: våra granskade möbler och
Traderas annonser i samma rutnät. Märkessidan gjorde det redan; det som saknades var vägen dit.

**Men antalen är DELADE på brickan** — "41 granskade · 33 via Tradera", aldrig "74". De två sakerna
är olika mycket värda: en granskad möbel går att köpa i dag med hemleverans, en Tradera-annons är
någon annans som vi kan analysera. Ett sammanslaget tal hade lånat vår granskning till annonser vi
inte granskat.

**Räkningen flyttades till `inventory.ts`** och fick tester. Talet på brickan är ett löfte om vad
sidan bakom innehåller, och ett löfte som bara finns i en HTTP-hanterare går inte att pröva.

**Sökraden filtrerar brickorna medan man skriver** och tar en till rutnätet när ordet inte är ett
märke — den som skriver "Lamino" menar en modell, och ska inte mötas av tomhet.

---

## 17. Bläddra på möbeltyp — och en sida per ord som ska ranka på "begagnad soffa"

**Beslut:** Under märkesbrickorna på startsidan ligger en rad med möbeltyper: Soffor, Fåtöljer,
Matstolar, Matbord, Byråer, Bokhyllor och så vidare. Varje bricka leder till en egen sida på
`/butik/mobel/<typ>` med rubriken *"Begagnad soffa i Stockholm"*.

**Typen är finare än kategorin, och det är hela poängen.** Kategorierna är nio och rätt för ett
filter. Men ingen söker på "begagnad förvaring" — man söker på "begagnad byrå", "begagnat matbord",
"begagnad bäddsoffa". Typen är den nivån: ordet folk skriver, som en egen adress. Varje typ hör
till exakt en kategori (`MOBELTYPER` i catalog.ts), och kategorin är brödsmulan uppåt.

**Singular, obestämd form, först i titeln.** Kategorisidan heter "Begagnade soffor" och det är rätt
över ett rutnät; frasen i sökrutan är "begagnad soffa", och titeln är det enda i träffen som kan
matcha den ordagrant. Rubriken böjs efter substantivet — *begagnat* matbord, *begagnad* soffa
(`typeHeading`); "begagnad matbord" hade sett ut som en maskin skrivit det.

**Allt på sidan är hämtat ur hyllan.** Antalet i titeln, prisspannet i ingressen, märkena att gå
vidare till, varulistan, svaren på "vad kostar en begagnad soffa" — allt räknas ur lagret vid varje
förfrågan. Det är det som skiljer sidan från en tunn nyckelordssida, och det är också därför en tom
typ ger `noindex` och saknas i sitemapen: en sida som lovar soffor och visar ingenting är sämre
för rankningen än ingen sida alls.

**React ritar samma rubrik som servern skrev.** Google renderar JavaScript, så det som räknas är
sidan EFTER att appen startat. Typskärmen hämtar därför rubrik och ingress ur samma katalogpost
(`/api/butik/mobeltyper/:slug`) i stället för att ha en egen text — två rubriker för samma sida är
två sanningar.

**Klassningen är ordbaserad och längsta ordet vinner**, samma regel som kategorierna: "sängbord" är
ett sidobord, inte en säng. En vara utan träffande ord räknas till kategorins fallback-typ bara där
kategorin *är* typen (soffor, fåtöljer, sängar, matstolar, skrivbord). Ett "Bord" utan mer blir
inget matbord: typsidan får inte fyllas med bord vi inte vet är matbord.

**Antalen är delade på brickan**, "12 granskade · 3 via Tradera", av samma skäl som på
märkesbrickan (beslut 16). Räkningen bor i inventory.ts med tester som låser att brickan och
rutnätet räknar på samma regel.

---

## 18. "Letar du möbel?" — en fotnot som frågar, och en människa som svarar

**Vad som byggdes:** en rad längst ned på startsidan och på produktsidorna. Klick öppnar en vy där
man beskriver vad man letar efter i fri text, får högst tre följdfrågor, lämnar en e-postadress och
inget mer. Ingen träfflista, inget konto, inget löfte om när.

### Den visar aldrig något utbud

Vyn kunde ha svarat med ett direktsvep — `/api/efterlysning/svep` finns och fungerar. Den gör det
inte. Att svara med en **tom hylla** på "jag letar efter X" är det värsta svar just den personen kan
få, och att svara med en **full hylla** gör dem till en besökare i rutnätet i stället för någon vi
har adressen till. Vi tar emot beskrivningen och hör av oss. Det är hela funktionen.

### Chatten kom tillbaka, men inte som chatt

Beslut 11 tog bort `EfterlysningChat` från /kop och lät parsern ligga kvar orörd. Den parsern är vad
den här funktionen står på: ett `/tolka`-anrop, och sedan **frågor bestämda i kod**. Det som inte
kom tillbaka är den öppna dialogen — vyn kan ställa åtta frågor och inga andra, den ställer högst
tre, och var och en går att hoppa över med en knapp som syns lika tydligt som svaret.

### Mjuka frågor, men bara till den som inte redan berättat

`followUps` frågade förut aldrig om märke, skick, färg eller stil: de gör en träff *bättre*, inte
*möjlig*. Argumentet höll för en SÖKNING som ska ge träffar nu — men en efterlysning läses av en
människa som matchar för hand, och för den handen är "grön, mid-century" skillnaden mellan att känna
igen möbeln och att gissa.

Fälten delas därför i två, och ordningen mellan dem är hela regeln:

- **Hårda** (kategori, pris, mått) avgör om en möbel kan matcha alls. En lucka frågas det alltid om.
- **Mjuka** (märke, skick, färg, stil, övrigt) frågas bara när beskrivningen är tunn — under tre
  ifyllda fält. Den som skrivit "soffa, max 5 000, högst 210 bred" har svarat på det vi behöver
  veta, och tre frågor till läser som att vi inte lyssnade.

Två hårda luckor tränger undan de mjuka: taket på tre gäller summan.

### Originaltexten sparas bredvid fälten, inte i stället för dem

Tolkningen kastar med flit allt den inte kan pröva mot katalogen. Ett märke vi inte har i lager
överlever den inte — och att någon letar en Muuto vi *inte* har är hela poängen med att skriva upp
sig. Efterlysningen bär därför tre nya fält: `originalText` (meningen ordagrant), `asked`
(frågeloggen, **med de överhoppade kvar** — en fråga alla hoppar över ska bort ur intaget, och bara
de besvarade hade dolt just den signalen) och `origin` (adressen personen kom från). Alla tre är
valfria i typen: rader skapade före fältet fanns saknar dem, och en migrering hade fyllt dem med en
påhittad mening.

Följdsvaren vävs in på **servern**, i samma slinga som skriver loggen. Alternativet — ett
`/tolka`-anrop per svar — hade gett tre extra rundturer mitt i ett intag som ska kännas som en fråga
i taget, och lagt tolkningen av "max 210 bred" på två ställen. Nu *kan* loggen och filtret inte gå
isär.

### Matchningen sker för hand, och det är ett beslut

Sveparen matchar redan automatiskt mot ett `ProductFilter`, och gör det bra för det som *är* ett
filter. Adminfliken finns för resten: originaltexten bredvid en hylla ur butikens vanliga `browse`,
och en knapp som skickar ett brev med möbel, bild, pris, skick och en länk rakt till produktsidan.
Kandidatfiltret körs **mjukt** — kategori och pristak, men utan mått, färg och material — för de
fälten fäller kandidater en människa mycket väl kan tycka duger, och en tom lista säger ingenting om
varför den är tom.

Dubbletten stoppas på servern och inte i knappen. Knappen är grå för en redan skickad möbel, men en
grå knapp är en artighet; regeln måste sitta där skrivningen sker.

### Följd: "Lägg en bevakning" är borta ur produktsidan

Notisen på en såld möbel sa "Lägg en bevakning så hör vi av oss". Ordet *bevakning* hör till
registret som redan är avvecklat (beslut i `efterlysning/types.ts`), och funktionen som ersätter det
säger *berätta*. På en såld möbel **ersätter** raden dessutom köpblocket i stället för att stå under
det: "Möbeln är såld och går inte längre att köpa" var sant och en återvändsgränd.

---

## 19. Annonsen i profilen är säljarens vy, och den går att ta bort

**Upptäckt:** Ett klick på en rad i profilen ledde till *köparens* sida — produktsidan för möbler som
låg i butiken, det publika kortet för resten. Båda visar möbeln; ingen av dem visar annonsen som
säljarens. Frågorna man öppnar sin egen rad för — hur går det, och hur tar jag bort den — hade inget
svar någonstans i produkten.

**Beslut:** Profilen öppnar säljarens kortvy på båda ingångarna. Säljverktyget som en skärm i flödet,
butiken på en egen adress: `/butik/annons/<jobId>`. Det är samma `ListingScreen` på båda ställena, av
samma skäl som profilen själv är en enda skärm — två varianter av samma vy börjar glida isär den vecka
någon lägger till en rad i den ena.

**Vägen tillbaka heter det den leder till.** Kortet skrev "Tillbaka till skicket", vilket är sant i
flödet direkt efter besiktningen och en lögn ur profilen: skicket ligger inte bakom, listan över egna
annonser gör det. Texten kommer därför utifrån, av den som vet var man kom ifrån.

### Borttagningen: tre saker, i en ordning som är regeln

1. **Tradera först.** Ligger annonsen ute hos dem tas den ner (`endTraderaItem`) innan något annat
   händer. Går det inte avbryts hela borttagningen med ett 502 och ett besked om att försöka igen: en
   annons som ligger uppe på Tradera men saknar kort hos oss visar "hittades inte" för någon som är på
   väg att lägga ett bud. Det är motsatt val till kassans `delistFromTradera`, som loggar och går
   vidare — där är köpet redan giltigt, här är ingenting oåterkalleligt ännu.
2. **Ur butiken**, om möbeln är publicerad. Posten står kvar i huvudboken som utkast; rader stryks
   inte ur en huvudbok.
3. **Jobbet märks som borttaget** — `removedAt`, `removedBy`.

**Grinden som inte går att förhandla om:** är möbeln reserverad, såld, levererad eller returnerad har
den en köpare, och den affären upphör inte för att säljaren ångrar sin annons. Svaret är 409 med ett
besked skrivet för säljaren. Regeln ligger på servern och inte i en grå knapp: klienten ska inte hålla
en andra kopia av listan över när det får ske.

### Varför en märkning och inte `rm -rf`

Två krav drar i olika riktningar: annonsen ska försvinna ur allt som visar möbler, och adminpanelen
ska kunna svara på vad som hände med en möbel som låg uppe i en vecka och togs ner. En raderad mapp
klarar det första och gör det andra omöjligt — en borttagen möbel och en möbel som aldrig funnits ser
likadana ut när båda är borta från disk.

Märkningen sitter därför på jobbet och **grinden ligger i `listJobs`**, det enda stället som räknar upp
lagret: butikens index, det publika kortet, profilen, datasetet, prisstegen och e-postbevakaren går
alla genom den. Ett filter hos var och en av de sex hade varit sex tillfällen att glömma. Panelen
frågar i stället uttryckligen, med `listRemovedJobs`, och raden får läget **"borttagen"** — som går
före butikens tillstånd, eftersom posten står kvar som `utkast` efteråt och "utkast" säger raka
motsatsen: att möbeln är på väg in.

**Följd:** `JOBS_DIR` går att peka om med `LOOPA_JOBS_DIR`, av samma skäl som `BUTIK_DATA_DIR` finns —
grinden ska gå att testa utan att skapa och ta bort jobb bland de skarpa besiktningarna.
