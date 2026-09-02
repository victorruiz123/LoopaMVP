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
