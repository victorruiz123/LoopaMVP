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
