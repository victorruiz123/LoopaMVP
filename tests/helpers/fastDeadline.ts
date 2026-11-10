/**
 * Importeras FÖRST i testfiler som prövar identifieringens tidsgräns i verklig tid.
 *
 * Tidskonstanterna i research/config.ts läses när modulen laddas, så de måste vara satta innan något annat importeras — och ES-moduler
 * körs i den ordning de importeras. Därför ligger det här i en egen modul i stället för som satser överst i testfilen (som körs
 * EFTER att alla importer är klara). Produktionens värden är 180 s, 4 s och 30 s; här krymper de så att ett test av
 * "tiden tar slut" tar en sekund i stället för en minut. Allt som prövas är relationerna mellan dem, inte talen.
 */
process.env.LOOPA_IDENTIFY_DEADLINE_MS = "400";
process.env.LOOPA_IDENTIFY_RESERVE_MS = "30";
process.env.LOOPA_IDENTIFY_MIN_CALL_MS = "10";
process.env.LOOPA_FACTS_CACHE = "0"; // testerna får inte läsa eller skriva driftens faktaminne

export const FAST = { deadlineMs: 400, reserveMs: 30, minCallMs: 10, watchdogGraceMs: 500 } as const;
