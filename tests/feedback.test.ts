// ─── Säljarens omdöme om processen ───────────────────────────────────────────
//
// Rutan öppnas i det ögonblick säljaren gjort oss en tjänst och inte har något ärende kvar. Allt i
// lagret är byggt runt det, och de tre reglerna som följer av det går sönder tyst:
//
// HALVA SVAR RÄKNAS. Betyg utan text, och text utan betyg, är båda riktiga svar. Börjar servern
// kräva båda växlar vi in svar mot tystnad — den som ville trycka på en fyra skriver inget stycke,
// de stänger rutan, och då har vi varken siffran eller stycket.
//
// OMDÖMET SITTER PÅ RÄTT MÖBEL. Vägen är öppen för varje inloggat konto. Utan ägarskapskontrollen
// kan vem som helst hänga ett omdöme på någon annans annons, och panelen läser raderna som säljarens
// ord om sin EGEN försäljning.
//
// TITELN FRYSES. Raden ska bära den möbel säljaren hade framför sig. Slås namnet upp när panelen
// läses i stället visar den dagens titel — eller ett tomrum när annonsen tagits bort — och svaret
// står plötsligt om något annat än frågan gällde.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Egna mappar, satta INNAN modulerna läses in: jobbens sökväg läses vid import.
process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-feedback-jobs-"));
process.env.FEEDBACK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-feedback-"));
process.on("exit", () => {
  rmSync(process.env.LOOPA_JOBS_DIR!, { recursive: true, force: true });
  rmSync(process.env.FEEDBACK_DATA_DIR!, { recursive: true, force: true });
});

const { sparaFeedback, listaFeedback, FeedbackFel } = await import("../server/src/feedback.js");
const { createJob } = await import("../server/src/jobStore.js");

const SÄLJARE = "user-saljaren";

test("betyg utan text och text utan betyg är båda riktiga svar", async () => {
  const bara_betyg = await sparaFeedback({ betyg: 5, userId: SÄLJARE, epost: "a@example.com" });
  const bara_text = await sparaFeedback({ text: "Gick fort!", userId: SÄLJARE, epost: "a@example.com" });

  assert.equal(bara_betyg.betyg, 5);
  assert.equal(bara_betyg.text, null);
  assert.equal(bara_text.betyg, null);
  assert.equal(bara_text.text, "Gick fort!");
});

test("ett tomt svar sparas inte — rutan hoppades över, den besvarades inte", async () => {
  await assert.rejects(
    () => sparaFeedback({ betyg: null, text: "   ", userId: SÄLJARE, epost: null }),
    FeedbackFel,
  );
});

test("betyget måste ligga på skalan", async () => {
  await assert.rejects(() => sparaFeedback({ betyg: 0, userId: SÄLJARE, epost: null }), FeedbackFel);
  await assert.rejects(() => sparaFeedback({ betyg: 6, userId: SÄLJARE, epost: null }), FeedbackFel);
});

test("omdömet knyts till möbeln, med titeln och Loopa-ID:t frusna i raden", async () => {
  const job = await createJob(null, { brand: "Ikea", model: "Strandmon" } as never, SÄLJARE, null);
  const rad = await sparaFeedback({ jobId: job.id, betyg: 4, text: "Bra", userId: SÄLJARE, epost: null });

  assert.equal(rad.jobId, job.id);
  assert.equal(rad.titel, "Ikea Strandmon");
  assert.ok(rad.loopaId, "Loopa-ID:t ska stå på raden, så panelen slipper översätta jobb-id:t");
});

test("ingen hänger ett omdöme på någon annans annons", async () => {
  const job = await createJob(null, null, SÄLJARE, null);
  await assert.rejects(
    () => sparaFeedback({ jobId: job.id, betyg: 1, userId: "user-nagon-annan", epost: null }),
    FeedbackFel,
  );
});

test("listan går nyast först, och snittet vilar bara på de satta betygen", async () => {
  const { poster, snitt, antalBetyg } = await listaFeedback();

  const tider = poster.map((p) => p.skapad);
  assert.deepEqual(tider, [...tider].sort((a, b) => b.localeCompare(a)));

  // Sparade ovan: 5, 4 och en ren fritext. Fritexten är inte en nolla.
  assert.equal(antalBetyg, 2);
  assert.equal(snitt, 4.5);
});
