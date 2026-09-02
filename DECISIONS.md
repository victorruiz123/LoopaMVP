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
