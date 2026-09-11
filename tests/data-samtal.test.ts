// ─── data/samtal: samtalen i "Hur fungerar det?" ──────────────────────────────
//
// Den enda fritext skriven av en människa som produkten sparar. Tre saker måste hålla, och alla tre
// är tysta om de går sönder:
//
//   TRÅDEN. Tio frågor i rad ska bli ETT samtal att läsa. Blir de tio lösryckta rader är en
//   uppföljningsfråga obegriplig — och det är uppföljningsfrågorna som säger var svaret tog slut.
//
//   VITLISTAN. Vägen in är öppen: den som frågar har per definition inget konto. Ett samtals-id som
//   inte har id-formen, eller ett konto som i själva verket är en e-postadress, får inte nå filen.
//
//   FELET. En fråga som föll ska stå kvar i samtalet som ett fel. Ett svar som tystnar och inte
//   syns någonstans är precis det mätningen finns för att fånga.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "loopa-samtal-"));
process.env.DATA_FLODE_DIR = dir;

const samtal = await import("../server/src/data/samtal.js");

test("samtalet: turerna hålls ihop av sitt id, i den ordning de ställdes", async () => {
  samtal.nollstall();
  await samtal.spara({ samtal: "trad-aaaa1111", sess: "sessaaaa1111", fraga: "Vad kostar det?", svar: "Vi tar 20 %." });
  await samtal.spara({ samtal: "trad-aaaa1111", sess: "sessaaaa1111", fraga: "Och om den inte säljs?", svar: "Då får du den tillbaka." });
  await samtal.spara({ samtal: "trad-bbbb2222", fraga: "Tar ni IKEA?", svar: "Ja." });

  const alla = await samtal.allaSamtal();
  const tråd = alla.find((s) => s.id === "trad-aaaa1111");
  assert.ok(tråd);
  assert.equal(tråd.turer.length, 2);
  assert.equal(tråd.turer[0].fraga, "Vad kostar det?");
  assert.equal(tråd.turer[1].fraga, "Och om den inte säljs?");
  assert.equal(tråd.sess, "sessaaaa1111", "samtalet ska gå att lägga bredvid flödesstegen det fördes i");
  assert.equal(alla.filter((s) => s.id === "trad-bbbb2222").length, 1);
});

test("samtalet: kontot står på tråden även när inloggningen skedde mitt i den", async () => {
  samtal.nollstall();
  await samtal.spara({ samtal: "trad-cccc3333", fraga: "Hur får jag betalt?", svar: "Swish." });
  await samtal.spara({ samtal: "trad-cccc3333", uid: "konto-cccc3333", fraga: "När då?", svar: "Inom ett dygn." });

  const [tråd] = (await samtal.allaSamtal()).filter((s) => s.id === "trad-cccc3333");
  assert.equal(tråd.uid, "konto-cccc3333", "kontot hör till hela samtalet, inte bara turen efter inloggningen");
});

test("samtalet: ett påhittat id och en e-postadress som konto når aldrig filen", async () => {
  samtal.nollstall();
  // Kort id — inte ett samtal, utan något någon skrivit i fältet.
  await samtal.spara({ samtal: "x", fraga: "Hej", svar: "Hej" });
  await samtal.spara({ samtal: "trad-dddd4444", uid: "anna@exempel.se", fraga: "Hämtar ni?", svar: "Ja." });

  const alla = await samtal.allaSamtal();
  assert.equal(alla.some((s) => s.id === "x"), false, "ett id utan id-form ska inte skapa ett samtal");
  const tråd = alla.find((s) => s.id === "trad-dddd4444");
  assert.equal(tråd?.uid, null, "en e-postadress är inte ett konto-id och får aldrig sparas som ett");
});

test("samtalet: en fråga som föll står kvar som ett fel och inte som ett tomt svar", async () => {
  samtal.nollstall();
  await samtal.spara({ samtal: "trad-eeee5555", fraga: "Vilka möbler tar ni?", svar: "", fel: true });

  const [tråd] = (await samtal.allaSamtal()).filter((s) => s.id === "trad-eeee5555");
  assert.equal(tråd.turer[0].fel, true);
  assert.equal(tråd.turer[0].fraga, "Vilka möbler tar ni?", "frågan som inte fick svar är den intressanta raden");

  const rad = JSON.parse((await readFile(path.join(dir, "samtal.jsonl"), "utf-8")).trim().split("\n").pop() as string);
  assert.equal(rad.fel, true);
});
