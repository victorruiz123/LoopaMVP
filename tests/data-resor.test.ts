// ─── data/resor: mikrostegen, klicken, felen och kartan ──────────────────────
//
// VITLISTAN: vägen in är öppen, och ett mikrosteg, klick eller fel med ett påhittat namn får aldrig
// nå filen. Det är samma säkerhet som resten av flödesmätningen vilar på.
//
// KARTAN: "vart gick de sedan" och "var gav de upp" räknas ur tidslinjen. Räknar de fel är felet
// TYST — kartan ser rimlig ut. Testet bygger tre kända resor och kontrollerar varje tal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const flode = await import("../server/src/data/flode.js");
const { resor, resaFor } = await import("../server/src/data/resor.js");

async function nyKatalog(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "loopa-resor-"));
  process.env.DATA_FLODE_DIR = dir;
  flode.nollstall();
  return dir;
}

test("vitlistan: okända mikrosteg, klick och fel kastas, kända går in med sin detalj", async () => {
  const dir = await nyKatalog();
  await flode.spara("vitlista00000001", null, "mikro", { namn: "kamera_oppnad" });
  await flode.spara("vitlista00000001", null, "mikro", { namn: "hittepa" });
  await flode.spara("vitlista00000001", null, "klick", { namn: "<script>" });
  await flode.spara("vitlista00000001", null, "klick", { namn: "vinkel_tagen", detalj: "framifran" });
  await flode.spara("vitlista00000001", null, "klick", { namn: "vinkel_tagen", detalj: "Inte En Kod!" });
  await flode.spara("vitlista00000001", null, "fel", { namn: "kamera_nekad", varde: 3 });
  await flode.spara("vitlista00000001", null, "fel", { namn: "kamera_nekad", varde: "tre" });

  const fil = await readFile(path.join(dir, "flode.jsonl"), "utf-8");
  assert.ok(!fil.includes("hittepa") && !fil.includes("<script>"), "okända namn ska aldrig nå filen");
  assert.ok(!fil.includes("Inte En Kod"), "en detalj utanför formen ska strykas");

  const [s] = await flode.allaSessioner();
  assert.deepEqual(
    s.punkter.map((p) => `${p.typ}:${p.namn}`),
    ["mikro:kamera_oppnad", "klick:vinkel_tagen", "klick:vinkel_tagen", "fel:kamera_nekad", "fel:kamera_nekad"],
  );
  assert.equal(s.punkter[1].detalj, "framifran");
  assert.equal(s.punkter[2].detalj, null);
  assert.equal(s.punkter[3].varde, 3);
  assert.equal(s.punkter[4].varde, null, "ett värde som inte är ett tal ska strykas");
  assert.deepEqual(s.mikro, ["kamera_oppnad"]);
});

test("kartan: framåt, bakåt, gav upp, felet före avhoppet — och adminer och pågående räknas rätt", async () => {
  await nyKatalog();
  // A: i mål, med en vända tillbaka till kameran efter ett fel i uppladdningen.
  const A = "resaaaaa00000001";
  await flode.spara(A, null, "enhet", { enhet: "mobil" });
  await flode.spara(A, null, "mikro", { namn: "kamera_oppnad" });
  await flode.spara(A, null, "klick", { namn: "spela_in" });
  await flode.spara(A, null, "mikro", { namn: "varv_klart", varde: 34 });
  await flode.spara(A, null, "mikro", { namn: "skickar_in" });
  await flode.spara(A, null, "fel", { namn: "uppladdning_misslyckad" });
  await flode.spara(A, null, "mikro", { namn: "kamera_oppnad" });
  await flode.spara(A, null, "mikro", { namn: "skickar_in" });
  await flode.spara(A, "job-a", "mikro", { namn: "uppladdat" });
  await flode.spara(A, "job-a", "mikro", { namn: "fardig_annons" });
  await flode.spara(A, "job-a", "intygat", { steg: "listing" });
  // B: nekade kameran och gav upp.
  const B = "resabbbb00000002";
  await flode.spara(B, null, "enhet", { enhet: "dator" });
  await flode.spara(B, null, "mikro", { namn: "kamera_oppnad" });
  await flode.spara(B, null, "fel", { namn: "kamera_nekad" });
  // C: en admin som testar — räknas inte.
  const C = "resacccc00000003";
  await flode.spara(C, null, "mikro", { namn: "kamera_oppnad" }, "admin-0000001");
  await flode.spara(C, null, "fel", { namn: "kamera_nekad" }, "admin-0000001");

  const sessioner = await flode.allaSessioner();
  // "Nu" en timme efter allt: ingen av resorna pågår längre.
  const senare = new Date(Date.now() + 60 * 60 * 1000);
  const svar = resor(sessioner, 30, new Set(["admin-0000001"]), senare);

  assert.equal(svar.summering.besok, 2, "adminens försök räknas inte");
  assert.equal(svar.summering.iMal, 1);
  assert.equal(svar.summering.lamnade, 1);
  assert.equal(svar.summering.medFel, 2);

  const kamera = svar.karta.find((k) => k.namn === "kamera_oppnad")!;
  assert.equal(kamera.nadde, 2, "ett besök räknas en gång per steg, även när det kommer tillbaka");
  assert.equal(kamera.lamnade, 1);
  assert.deepEqual(kamera.felForeAvhopp, [{ namn: "kamera_nekad", antal: 1 }]);
  assert.deepEqual(kamera.mobil, { nadde: 1, lamnade: 0 });
  assert.deepEqual(kamera.dator, { nadde: 1, lamnade: 1 });
  assert.ok(kamera.klick.some((c) => c.namn === "spela_in"));

  const skickar = svar.karta.find((k) => k.namn === "skickar_in")!;
  assert.ok(skickar.vidare.some((v) => v.namn === "kamera_oppnad" && v.riktning === "bak"), "vändan tillbaka ska synas");
  assert.ok(skickar.vidare.some((v) => v.namn === "uppladdat" && v.riktning === "fram"));
  assert.ok(skickar.fel.some((f) => f.namn === "uppladdning_misslyckad"));

  // Ordningen följer flödet, inte storleken.
  const ordning = svar.karta.map((k) => k.namn);
  assert.ok(ordning.indexOf("kamera_oppnad") < ordning.indexOf("skickar_in"));

  const fel = svar.fel.find((f) => f.namn === "kamera_nekad")!;
  assert.deepEqual({ antal: fel.antal, besok: fel.besok, ledTillAvhopp: fel.ledTillAvhopp }, { antal: 1, besok: 1, ledTillAvhopp: 1 });

  const resaB = resaFor(sessioner.find((s) => s.sess === B)!, senare);
  assert.equal(resaB.iMal, false);
  assert.equal(resaB.pagar, false);
  assert.equal(resaB.punkter.at(-1)?.namn, "kamera_nekad");
});

test("kartan: ett besök som just tystnat pågår — det är inget avhopp än", async () => {
  await nyKatalog();
  await flode.spara("resadddd00000004", null, "mikro", { namn: "vantar_modell" });
  const svar = resor(await flode.allaSessioner(), 30, new Set());
  assert.equal(svar.summering.pagar, 1);
  assert.equal(svar.summering.lamnade, 0);
  assert.equal(svar.karta.find((k) => k.namn === "vantar_modell")?.lamnade, 0);
});
