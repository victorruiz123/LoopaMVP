/**
 * Tar ner ett jobbs Tradera-annons, om den nått dit.
 *
 * Utbruten ur säljarens borttagning (handleDeleteJob i server.ts) så att adminens radering av ett
 * helt konto tar ner annonserna på exakt samma sätt — samma grindar, samma loggrader. Två kopior av
 * reglerna nedan hade glidit isär första gången någon av dem lagades.
 *
 * KASTAR när Tradera svarade fel på en annons som fortfarande kan vara köpbar. Den som anropar
 * avgör vad det betyder: säljaren får en 502 och försöker igen, raderingen avbryts innan något
 * hunnit tas bort.
 */

import type { ConditionJob } from "../../types.js";

export async function taNerTraderaAnnons(job: ConditionJob, loopaId: string, orsak: string): Promise<void> {
  // `pending` har aldrig lämnat oss — den ligger i panelens kö och har inget itemId att ta ner.
  const itemId = job.tradera?.itemId ?? null;
  if (!itemId || (job.tradera?.status !== "published" && job.tradera?.status !== "publishing")) return;

  const { endTraderaItem, getTraderaLage, traderaConfigured } = await import("./tradera.js");
  /**
   * UTAN NYCKLAR FINNS INGET ATT TA NER, och säljaren ska inte hållas fången av det.
   *
   * `endTraderaItem` läser TRADERA_USER_ID ur miljön och kastar "Saknar env-variabel" när den
   * inte finns. Det felet blev en 502 härifrån, och säljaren kunde inte ta bort sin annons alls —
   * exakt samma utfall som den utgångna auktionen nedan, men av en helt annan orsak. Oracle-servern
   * hade i september 2026 bara APP-nycklarna, inte USER-nycklarna, och därför gällde det VARJE
   * annons som nått Tradera, inte bara de utgångna.
   *
   * Att ändå ta bort hos oss är det minst dåliga: annonsen kan ligga kvar hos Tradera, och det
   * loggas högt, men alternativet är en annons säljaren aldrig blir av med. Nycklarna är vårt
   * fel att laga, inte deras att vänta ut.
   */
  if (!traderaConfigured()) {
    console.error(
      `[tradera] ${loopaId}: annons ${itemId} kunde INTE tas ner — Tradera är inte konfigurerat på servern.` +
        " Annonsen togs bort hos oss ändå. Ta ner den för hand hos Tradera.",
    );
    return;
  }
  /**
   * EN AVSLUTAD AUKTION GÅR INTE ATT TA NER, och ska inte heller behöva det.
   *
   * Tradera svarar med ett fel på DELETE mot en annons som redan löpt ut — det finns ingenting
   * kvar att avsluta. Utan kontrollen nedan blev det felet en 502 härifrån, och säljaren kunde
   * INTE TA BORT SIN ANNONS ALLS: märkningen nås aldrig, så annonsen låg kvar i profilen och i
   * butiken hur många gånger de än tryckte. Det gällde varje möbel vars auktion hunnit gå ut, alltså
   * förr eller senare varenda en — och bara i drift, där annonser faktiskt publiceras. En Swedese
   * Lamino vars auktion tog slut 2026-09-11 16:39 var den som visade det.
   *
   * Grinden nedan är därför inte "hoppa över när det är krångligt": en utgången annons är inte
   * köpbar, och det är just köpbarheten felet finns för att skydda. Går läget inte att läsa (null,
   * t.ex. ett tillfälligt fel hos Tradera) försöker vi ta ner som förut — då vet vi inte att den är
   * ofarlig, och då ska den som bad om det hellre få försöka igen.
   */
  const lage = await getTraderaLage(itemId);
  if (lage?.ended) {
    console.log(`[tradera] ${loopaId}: annons ${itemId} hade redan löpt ut — inget att ta ner.`);
    return;
  }
  await endTraderaItem(itemId);
  console.log(`[tradera] ${loopaId}: annons ${itemId} togs ner — ${orsak}.`);
}

/**
 * Tar ner jobbets KVARLÄMNADE Tradera-annonser — äldre annonser som fick ligga kvar vid veckans
 * omläggning för att en köpare skrivit till dem (types.ts `KvarlamnadAnnons`). De är samma möbel: när
 * den säljs eller tas bort får ingen av dem ligga kvar och gå att köpa.
 *
 * `utom` = annonsen som just sålts; den är redan avslutad hos Tradera. Samma grindar som ovan: utan
 * nycklar loggas det och hoppas över, en utgången annons räknas som nere. KASTAR när Tradera svarade
 * fel på en annons som kan vara köpbar — den som anropar avgör vad det betyder, som ovan.
 */
export async function taNerKvarlamnadeTradera(job: ConditionJob, loopaId: string, orsak: string, utom: number | null = null): Promise<void> {
  const kvar = (job.kvarlamnadeAnnonser ?? []).filter((k) => k.kanal === "tradera" && k.itemId && !k.nedtagenAt && k.itemId !== utom);
  if (kvar.length === 0) return;

  const { endTraderaItem, getTraderaLage, traderaConfigured } = await import("./tradera.js");
  const { persist } = await import("../../jobStore.js");
  if (!traderaConfigured()) {
    console.error(
      `[tradera] ${loopaId}: ${kvar.length} kvarlämnad(e) annons(er) (${kvar.map((k) => k.itemId).join(", ")}) kunde INTE tas ner — ` +
        "Tradera är inte konfigurerat på servern. Ta ner dem för hand hos Tradera.",
    );
    return;
  }
  try {
    for (const k of kvar) {
      const lage = await getTraderaLage(k.itemId!);
      if (!lage?.ended) await endTraderaItem(k.itemId!);
      k.nedtagenAt = new Date().toISOString();
      console.log(`[tradera] ${loopaId}: kvarlämnad annons ${k.itemId} ${lage?.ended ? "hade redan löpt ut" : "togs ner"} — ${orsak}.`);
    }
  } finally {
    await persist(job);
  }
}
