// ─── data/: flödesmätningen, rättelseloggen och kategoriseringen ──────────────
//
// De tre delar av datafliken som har en egen sanning att bevaka.
//
// FLÖDET: hopsättningen av lösa rader till en session är det enda stället där "tid till intygat" och
// "var hoppade de av" uppstår. Räknar den fel är felet TYST — panelen visar ett tal som ser rimligt
// ut. Vitlistan prövas i samma andetag: vägen in är öppen, och en händelse som slipper igenom med
// ett påhittat namn är en skrivbar disk för vem som helst.
//
// RÄTTELSERNA: en rättelse utan sitt "före" är ingen etikett. Testet vaktar att ett identiskt värde
// aldrig blir en rad, och att ett tillägg (aiSa null) skiljs från en korrigering.
//
// KATEGORISERINGEN: ordningen mellan nyckelorden ÄR regeln — "vad kostar frakten" är en leveransfråga
// och inte en prisfråga.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "loopa-data-"));
process.env.DATA_FLODE_DIR = dir;

const flode = await import("../server/src/data/flode.js");
const rattelser = await import("../server/src/data/rattelser.js");
const { kategoriseraFraga } = await import("../server/src/data/dataset.js");

const SESS = "abcdef0123456789";

test("flödet: sessionen sätts ihop, tiden räknas och jobbet knyts på i efterhand", async () => {
  flode.nollstall();
  await flode.spara(SESS, null, "enhet", { enhet: "mobil", vy: "mobile" });
  await flode.spara(SESS, null, "steg", { steg: "home", ms: 12_000 });
  await flode.spara(SESS, null, "guide_fraga", { steg: "home", chatt: "start", kategori: "pris" });
  await flode.spara(SESS, null, "chip", { steg: "home", text: "Vad kostar det?" });
  await flode.spara(SESS, null, "steg", { steg: "capture", ms: 48_000 });
  // Jobbet dyker upp först vid uppladdningen — allt ovan hör ändå till det.
  await flode.spara(SESS, "job-1", "steg", { steg: "identify", ms: 9_000 });
  await flode.spara(SESS, "job-1", "intygat", { steg: "listing" });

  const s = await flode.flodeForJobb("job-1");
  assert.ok(s, "sessionen ska hittas på jobbet fastän de första raderna saknade det");
  assert.equal(s.jobId, "job-1");
  assert.equal(s.perSteg.capture, 48_000);
  assert.equal(s.besokta[0], "home");
  assert.equal(s.sistaSteg, "listing");
  assert.equal(s.intygat, true);
  assert.equal(s.enhet, "mobil");
  assert.equal(s.fragor.length, 1);
  assert.equal(s.fragor[0].kategori, "pris");
  assert.equal(s.chip.length, 1);
  // "Berätta" finns inte i appen än. Falskt här betyder osamlat, inte "ingen tryckte" — se LUCKOR.
  assert.equal(s.berattaPa, false);
  assert.equal(flode.berattaFinns, false);
});

test("flödet: bara vitlistade händelser, steg och egenskaper tar sig in", async () => {
  flode.nollstall();
  await flode.spara(SESS, null, "steg", { steg: "home", ms: 1000 });
  // Påhittat händelsenamn.
  await flode.spara(SESS, null, "drop_table", { steg: "home" });
  const efter = await flode.allaSessioner();
  assert.equal(efter.length, 1);
});

test("flödet: ett okänt steg och en okänd egenskap kastas, raden står kvar", async () => {
  flode.nollstall();
  await flode.spara(SESS, null, "steg", { steg: "påhittat", ms: 5, email: "a@b.se" });
  const rad = JSON.parse((await readFile(path.join(dir, "flode.jsonl"), "utf-8")).trim().split("\n").pop() as string);
  assert.equal(rad.props.steg, undefined, "ett steg som inte finns i STEG får inte sparas");
  assert.equal(rad.props.email, undefined, "en egenskap utanför vitlistan får aldrig nå disken");
});

test("tratten: nådde-hit och avhopp räknas på sessioner, inte på rader", async () => {
  flode.nollstall();
  await flode.spara("aaaaaaaaaaaaaaaa", null, "steg", { steg: "home", ms: 1 });
  await flode.spara("aaaaaaaaaaaaaaaa", null, "steg", { steg: "capture", ms: 1 });
  await flode.spara("bbbbbbbbbbbbbbbb", null, "steg", { steg: "home", ms: 1 });
  // `tratt` är en ren funktion över sessioner, och testet matar den med SINA — loggfilen delas
  // mellan testerna i den här filen, och en tratt räknad över allt hade mätt de andra testen.
  const mina = (await flode.allaSessioner()).filter((s) => s.sess.startsWith("aaaa") || s.sess.startsWith("bbbb"));
  const t = flode.tratt(mina);
  const home = t.find((r) => r.steg === "home");
  const capture = t.find((r) => r.steg === "capture");
  assert.equal(home?.naddeHit, 2);
  assert.equal(home?.stannade, 1, "bara sessionen som aldrig kom längre räknas som avhopp här");
  assert.equal(capture?.naddeHit, 1);
  assert.equal(capture?.stannade, 1);
});

test("säljaren: kontot knyts till hela sessionen, även raderna som skrevs före inloggningen", async () => {
  flode.nollstall();
  const sess = "cccccccccccccccc";
  // Märkesvalet och filmningen sker före grinden: de raderna bär inget konto.
  await flode.spara(sess, null, "steg", { steg: "home", ms: 3_000 });
  await flode.spara(sess, null, "steg", { steg: "capture", ms: 40_000 });
  await flode.spara(sess, null, "saljare", { steg: "signup" }, "konto-abc123");
  await flode.spara(sess, "job-9", "steg", { steg: "identify", ms: 7_000 }, "konto-abc123");

  const s = await flode.flodeForJobb("job-9");
  assert.ok(s);
  assert.equal(s.uid, "konto-abc123", "kontot ska gälla hela flödet, inte bara raderna efter inloggningen");
  assert.equal(s.besokta[0], "home");
});

test("säljaren: ett uid som inte har kontoformen kastas i stället för att bli en fri textrad", async () => {
  flode.nollstall();
  await flode.spara("dddddddddddddddd", null, "steg", { steg: "home", ms: 1 }, "a@b.se");
  const rad = JSON.parse((await readFile(path.join(dir, "flode.jsonl"), "utf-8")).trim().split("\n").pop() as string);
  assert.equal(rad.uid, null, "en e-postadress är inte ett konto-id och får aldrig nå filen");
});

test("avhoppen: en påbörjad annons skiljs från ett besök, och intygade flöden står inte med", async () => {
  flode.nollstall();
  // Ett besök: bara startsidan.
  await flode.spara("eeeeeeeeeeeeeeee", null, "steg", { steg: "home", ms: 4_000 });
  // En påbörjad annons som släpptes på modellvalet.
  await flode.spara("ffffffffffffffff", null, "steg", { steg: "home", ms: 2_000 }, "konto-ffffffff");
  await flode.spara("ffffffffffffffff", null, "steg", { steg: "capture", ms: 51_000 }, "konto-ffffffff");
  await flode.spara("ffffffffffffffff", null, "steg", { steg: "identify", ms: 22_000 }, "konto-ffffffff");
  await flode.spara("ffffffffffffffff", null, "avhopp", { steg: "identify" }, "konto-ffffffff");
  // Ett flöde som gick hela vägen. Ska inte finnas bland avhoppen.
  await flode.spara("gggggggggggggggg", null, "steg", { steg: "home", ms: 1_000 });
  await flode.spara("gggggggggggggggg", null, "intygat", { steg: "listing" });

  const mina = (await flode.allaSessioner()).filter((s) => /^[efg]/.test(s.sess));
  const avhopp = flode.avhoppen(mina);
  assert.equal(avhopp.length, 2, "det intygade flödet är inget avhopp");

  const slapptes = avhopp.find((a) => a.sess.startsWith("ffff"));
  assert.ok(slapptes);
  assert.equal(slapptes.paborjad, true);
  assert.equal(slapptes.sistaSteg, "identify", "steget de stod i när de tryckte bort");
  assert.equal(slapptes.sistaStegMs, 22_000);
  assert.equal(slapptes.uid, "konto-ffffffff");

  const besok = avhopp.find((a) => a.sess.startsWith("eeee"));
  assert.equal(besok?.paborjad, false, "den som bara öppnade startsidan har inte avbrutit någonting");
});

test("rättelserna: ett oförändrat fält blir ingen rad, ett ändrat blir en", async () => {
  rattelser.nollstall();
  await rattelser.noteraFalt(
    { jobId: "job-2", omrade: "skick", fyndId: "d1", kalla: "saljare", notis: null },
    { severity: "S2", part: "armstöd" },
    { severity: "S3", part: "armstöd" },
  );
  const rader = await rattelser.rattelserFor("job-2");
  assert.equal(rader.length, 1, "bara det fält som faktiskt ändrades ska loggas");
  assert.equal(rader[0].falt, "severity");
  assert.equal(rader[0].aiSa, "S2");
  assert.equal(rader[0].manniskanSa, "S3");
});

test("rättelserna: ett tillägg har inget före, och det är skillnaden mot en korrigering", async () => {
  rattelser.nollstall();
  await rattelser.notera({
    jobId: "job-3", omrade: "skick", falt: "fynd säljaren la till", fyndId: "m1",
    aiSa: null, manniskanSa: "stain på sits", kalla: "saljare", notis: null,
  });
  const [rad] = await rattelser.rattelserFor("job-3");
  assert.equal(rad.aiSa, null, "modellen sa ingenting om det här fyndet — den missade det helt");
  assert.equal(rad.manniskanSa, "stain på sits");
});

test("köparfrågor kategoriseras grovt, och leverans går före pris", () => {
  assert.equal(kategoriseraFraga("Vad kostar frakten till Solna?"), "leverans");
  assert.equal(kategoriseraFraga("Kan du gå ner i pris?"), "pris");
  assert.equal(kategoriseraFraga("Hur bred är den?"), "mått");
  assert.equal(kategoriseraFraga("Är repan djup?"), "skick");
  assert.equal(kategoriseraFraga("Hej!"), "övrigt");
});
