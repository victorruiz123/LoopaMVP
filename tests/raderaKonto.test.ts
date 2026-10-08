// ─── Radera användare & innehåll ─────────────────────────────────────────────
//
// Adminens knapp tar bort en person ur ett dussin lager. Tre saker prövas, valda för att de går
// sönder tyst:
//
// RÄTT PERSON, OCH BARA DEN. Varje lager filtreras på sitt eget sätt — userId, ownerId, uid, e-post,
// jobb-id — och ett enda fel filter raderar någon annans bilder. Ett andra konto ligger därför i
// samma lager genom hela testet och ska stå orört efteråt.
//
// BOKFÖRINGEN STÅR KVAR. En order ska tappa köparen, inte försvinna.
//
// INGENTING FÖRSVINNER UTAN BEKRÄFTELSE, OCH INGENTING NÄR NÅGOT STOPPAR. Fel e-post och en såld men
// outbetald möbel ska båda lämna lagret precis som det var.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Varje lager i en egen tillfällig mapp, satt INNAN modulerna läses in: sökvägarna läses vid import.
const ROT = mkdtempSync(path.join(tmpdir(), "loopa-radering-"));
const DIR = (namn: string) => {
  const d = path.join(ROT, namn);
  mkdirSync(d, { recursive: true });
  return d;
};
process.env.LOOPA_JOBS_DIR = DIR("jobs");
process.env.BUTIK_DATA_DIR = DIR("butik");
process.env.AFFAR_DATA_DIR = DIR("affarer");
process.env.REFERRAL_DATA_DIR = DIR("referral");
process.env.EFTERLYSNING_DATA_DIR = DIR("efterlysningar");
process.env.FEEDBACK_DATA_DIR = DIR("feedback");
process.env.DATA_FLODE_DIR = DIR("data");
process.env.UTSKICK_DATA_DIR = DIR("utskick");
process.env.OUTBOX_DIR = DIR("outbox");
process.env.RADERING_DATA_DIR = DIR("raderingar");
process.env.FACEBOOK_DATA_DIR = DIR("facebook");
process.env.SUPABASE_URL = "https://exempel.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-nyckel";
process.env.ADMIN_EMAILS = "admin@loopa.nu";
delete process.env.LOOPA_LAGRING;
process.on("exit", () => rmSync(ROT, { recursive: true, force: true }));

const ANNA = { id: "anna-0000-0001", email: "anna@exempel.se" };
const BO = { id: "bo-0000-0002", email: "bo@exempel.se" };
const ADMIN = "admin-0000-0009";

/** Supabase, som raderingen ser det: kontona finns, och DELETE svarar 204. Anropen sparas. */
const anrop: Array<{ method: string; url: string }> = [];
globalThis.fetch = (async (input: string, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  anrop.push({ method, url });
  if (method === "DELETE") return new Response(null, { status: 204 });
  const konto = [ANNA, BO].find((k) => url.includes(`/auth/v1/admin/users/${k.id}`));
  if (konto) return Response.json({ id: konto.id, email: konto.email, user_metadata: {} });
  if (url.includes("/rest/v1/profiles")) return Response.json([]);
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const { raderaKonto, underlag, RaderingsFel } = await import("../server/src/raderaKonto.js");
const { loopaIdFor } = await import("../server/src/loopaId.js");
const { store: butik, resetStore } = await import("../server/src/butik/store.js");
const { createBevakning, listBevakningar } = await import("../server/src/butik/bevakningar.js");
const { createOrder, allOrders } = await import("../server/src/butik/orders.js");
const { spara: sparaFlode } = await import("../server/src/data/flode.js");
const { spara: sparaSamtal, allaSamtal } = await import("../server/src/data/samtal.js");
const efterlysning = await import("../server/src/efterlysning/store.js");
const { listaFeedback } = await import("../server/src/feedback.js");

function skrivJobb(id: string, ownerId: string) {
  const d = path.join(process.env.LOOPA_JOBS_DIR!, id);
  mkdirSync(path.join(d, "originals"), { recursive: true });
  writeFileSync(path.join(d, "originals", "bild.jpg"), "foto");
  writeFileSync(
    path.join(d, "job.json"),
    JSON.stringify({ id, ownerId, createdAt: "2026-09-01T10:00:00.000Z", progress: { stage: "done", message: "" } }),
  );
}

async function lagret() {
  skrivJobb("jobb-anna", ANNA.id);
  skrivJobb("jobb-bo", BO.id);
  await createBevakning({ userId: ANNA.id, email: ANNA.email, categorySlug: "soffor", brand: null, maxPriceSek: null, maxWidthMm: null, maxDepthMm: null, maxHeightMm: null });
  await createBevakning({ userId: BO.id, email: BO.email, categorySlug: "soffor", brand: null, maxPriceSek: null, maxWidthMm: null, maxDepthMm: null, maxHeightMm: null });
  await createOrder({ productId: "LP-ANNAN", userId: ANNA.id, email: ANNA.email, priceSek: 1200, reservationToken: "t1" });
  await createOrder({ productId: "LP-ANNAN", userId: BO.id, email: BO.email, priceSek: 900, reservationToken: "t2" });
  await sparaFlode("sessanna1", "jobb-anna", "steg", { steg: "capture" }, null);
  await sparaFlode("sessbo0002", null, "steg", { steg: "capture" }, BO.id);
  await sparaSamtal({ samtal: "samtal-anna", uid: ANNA.id, fraga: "Hur funkar det?", svar: "Så här." });
  await sparaSamtal({ samtal: "samtal-bo", uid: BO.id, fraga: "Och för mig?", svar: "Likadant." });
  writeFileSync(
    path.join(process.env.EFTERLYSNING_DATA_DIR!, "efterlysningar.json"),
    JSON.stringify([
      { id: "e-anna", userId: ANNA.id, email: ANNA.email, state: "active", createdAt: "2026-09-01T10:00:00.000Z" },
      { id: "e-bo", userId: BO.id, email: BO.email, state: "active", createdAt: "2026-09-01T10:00:00.000Z" },
    ]),
  );
  writeFileSync(
    path.join(process.env.FEEDBACK_DATA_DIR!, "feedback.json"),
    JSON.stringify([
      { id: "f1", jobId: "jobb-anna", userId: ANNA.id, epost: ANNA.email, betyg: 5, text: "Bra", skapad: "2026-09-01T10:00:00.000Z" },
      { id: "f2", jobId: "jobb-bo", userId: BO.id, epost: BO.email, betyg: 4, text: "Ok", skapad: "2026-09-01T10:00:00.000Z" },
    ]),
  );
  writeFileSync(path.join(process.env.OUTBOX_DIR!, `2026-09-01__match__${ANNA.email}.txt`), "brev");
  writeFileSync(path.join(process.env.OUTBOX_DIR!, `2026-09-01__match__${BO.email}.txt`), "brev");
}

await lagret();

test("fel bekräftelse raderar ingenting", async () => {
  await assert.rejects(
    () => raderaKonto(ANNA.id, "fel@exempel.se", ADMIN),
    (err: unknown) => err instanceof RaderingsFel && err.status === 400,
  );
  assert.ok(existsSync(path.join(process.env.LOOPA_JOBS_DIR!, "jobb-anna")));
  assert.equal((await listBevakningar(ANNA.id)).length, 1);
  assert.ok(!anrop.some((a) => a.method === "DELETE"));
});

test("en såld möbel som inte är utbetald stoppar raderingen", async () => {
  const id = loopaIdFor("jobb-anna");
  const nu = new Date().toISOString();
  await butik().put({
    id, source: "loopa", jobId: "jobb-anna", state: "sold", reservedUntil: null, reservationToken: null,
    reservedPriceSek: null, listedAt: nu, soldAt: nu, soldChannel: "butik", traderaItemId: null, updatedAt: nu,
  });
  const u = await underlag(ANNA.id, ADMIN);
  assert.ok(u?.hinder.some((h) => h.includes("inte utbetald")));
  await assert.rejects(
    () => raderaKonto(ANNA.id, ANNA.email, ADMIN),
    (err: unknown) => err instanceof RaderingsFel && err.status === 409,
  );
  assert.ok(existsSync(path.join(process.env.LOOPA_JOBS_DIR!, "jobb-anna")));

  // Tillbaka till ett tomt butikslager för nästa test.
  rmSync(path.join(process.env.BUTIK_DATA_DIR!, "products.json"), { force: true });
  resetStore();
});

test("det egna kontot går inte att radera", async () => {
  const sig = await underlag(ANNA.id, ANNA.id);
  assert.ok(sig?.hinder.some((h) => h.includes("ditt eget konto")));
});

test("raderingen tar bort Annas uppgifter och lämnar Bos orörda", async () => {
  const resultat = await raderaKonto(ANNA.id, " ANNA@exempel.se ", ADMIN);

  // Jobbet, med bilderna, är borta från disk. Bos står kvar.
  assert.ok(!existsSync(path.join(process.env.LOOPA_JOBS_DIR!, "jobb-anna")));
  assert.ok(existsSync(path.join(process.env.LOOPA_JOBS_DIR!, "jobb-bo", "originals", "bild.jpg")));

  assert.equal((await listBevakningar(ANNA.id)).length, 0);
  assert.equal((await listBevakningar(BO.id)).length, 1);

  assert.deepEqual((await efterlysning.all()).map((e) => e.id), ["e-bo"]);
  assert.deepEqual((await listaFeedback()).poster.map((f) => f.id), ["f2"]);

  // Ordern står kvar för bokföringen — utan Anna.
  const ordrar = await allOrders();
  assert.equal(ordrar.length, 2);
  const hennes = ordrar.find((o) => o.priceSek === 1200)!;
  assert.equal(hennes.userId, null);
  assert.equal(hennes.email, null);
  assert.equal(ordrar.find((o) => o.priceSek === 900)!.email, BO.email);

  // Chatten och flödet: Annas samtal och session är strukna ur filen, Bos står kvar.
  assert.deepEqual((await allaSamtal()).map((s) => s.id), ["samtal-bo"]);
  const flode = readFileSync(path.join(process.env.DATA_FLODE_DIR!, "flode.jsonl"), "utf-8");
  assert.ok(!flode.includes("sessanna1"));
  assert.ok(flode.includes("sessbo0002"));

  // Breven i /outbox.
  assert.ok(!existsSync(path.join(process.env.OUTBOX_DIR!, `2026-09-01__match__${ANNA.email}.txt`)));
  assert.ok(existsSync(path.join(process.env.OUTBOX_DIR!, `2026-09-01__match__${BO.email}.txt`)));

  // Inloggningen: profilraden först, sedan Auth — och bara Annas.
  const deletes = anrop.filter((a) => a.method === "DELETE").map((a) => a.url);
  assert.deepEqual(deletes, [
    `https://exempel.supabase.co/rest/v1/profiles?user_id=eq.${ANNA.id}`,
    `https://exempel.supabase.co/auth/v1/admin/users/${ANNA.id}`,
  ]);
  assert.deepEqual(resultat.inloggning, { raderad: true, fel: null });

  // Kvittot nämner id:t och inte adressen.
  const kvitto = readFileSync(path.join(process.env.RADERING_DATA_DIR!, "logg.jsonl"), "utf-8");
  assert.ok(kvitto.includes(ANNA.id));
  assert.ok(!kvitto.includes(ANNA.email));
});
