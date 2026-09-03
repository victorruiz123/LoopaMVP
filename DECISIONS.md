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
