// ─── Förturen: får aldrig blockera pipelinen ────────────────────────────────
//
// Kravet är hårdare än det låter. Det räcker inte att en utgången förtur SLÄPPER — den får inte
// kunna hålla kvar en möbel ens när städjobbet aldrig kört, servern startats om mitt i, eller
// intervallet aldrig hann. Därför räknas frågan "gäller den?" om vid varje läsning i stället för
// att lita på att någon markerat den som utgången.
//
// Och därför ligger förturen UTANFÖR butikens tillståndsmaskin. Den uppenbara lösningen — draft ->
// reserved — hade gjort släppandet till en regel någon måste komma ihåg att köra, och hade dessutom
// vidgat precis det `reserved`-läge som dubbelförsäljningsskyddet finns för att hålla smalt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "loopa-fortur-"));
process.env.EFTERLYSNING_DATA_DIR = path.join(TMP, "efterlysningar");
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const fortur = await import("../server/src/efterlysning/fortur.js");
const { ALLOWED_TRANSITIONS } = await import("../server/src/butik/types.js");

const HOUR = 3600_000;

test("en reservation grindar publiceringen", async () => {
  const f = await fortur.reserve({ productId: "LP-A", efterlysningId: "e1", userId: "u1" });
  assert.ok(f);
  assert.equal(await fortur.publishBlocked("LP-A"), true);
  assert.equal(await fortur.publishBlocked("LP-B"), false, "andra möbler rörs inte");
});

test("UTGÅNGEN FÖRTUR SLÄPPER — även om ingen städat", async () => {
  // Kärnkravet. Klockan prövas vid varje läsning, inte i ett städjobb som kan ha uteblivit.
  await fortur.reserve({ productId: "LP-C", efterlysningId: "e2", userId: "u1", hours: 1 });
  assert.equal(await fortur.publishBlocked("LP-C"), true, "gäller nu");
  const senare = Date.now() + 2 * HOUR;
  assert.equal(await fortur.publishBlocked("LP-C", senare), false, "släpper när klockan gått ut");
  assert.equal(await fortur.holdFor("LP-C", senare), null);
});

test("en släppt förtur grindar ingenting", async () => {
  const f = await fortur.reserve({ productId: "LP-D", efterlysningId: "e3", userId: "u1" });
  await fortur.release(f!.id, "acted");
  assert.equal(await fortur.publishBlocked("LP-D"), false);
});

test("en möbel har en förtur i taget", async () => {
  // Två köpare som båda får "du får se den först" är ett löfte vi brutit mot en av dem.
  await fortur.reserve({ productId: "LP-E", efterlysningId: "e4", userId: "u1" });
  assert.equal(await fortur.reserve({ productId: "LP-E", efterlysningId: "e5", userId: "u2" }), null);
});

test("men när den första gått ut får nästa köpare sin tur", async () => {
  await fortur.reserve({ productId: "LP-F", efterlysningId: "e6", userId: "u1", hours: 1 });
  await fortur.expireDue(Date.now() + 2 * HOUR);
  assert.ok(await fortur.reserve({ productId: "LP-F", efterlysningId: "e7", userId: "u2" }));
});

test("städningen skiljer utgången från agerad i historiken", async () => {
  await fortur.reserve({ productId: "LP-G", efterlysningId: "e8", userId: "u1", hours: 1 });
  await fortur.expireDue(Date.now() + 2 * HOUR);
  const row = (await fortur.all()).find((f) => f.productId === "LP-G");
  assert.equal(row?.releasedReason, "expired");
});

test("städningen är BOKFÖRING — grinden släppte redan innan den kördes", async () => {
  await fortur.reserve({ productId: "LP-H", efterlysningId: "e9", userId: "u1", hours: 1 });
  const senare = Date.now() + 2 * HOUR;
  // Ingen expireDue här. Grinden ska ändå vara öppen.
  assert.equal(await fortur.publishBlocked("LP-H", senare), false);
});

test("butikens tillståndsmaskin är ORÖRD", () => {
  // Hela konstruktionen finns för att slippa röra den här tabellen. Ändras den har någon flyttat
  // förturen in i maskinen, och då gäller inte längre bevisen ovan.
  assert.deepEqual(ALLOWED_TRANSITIONS.draft, ["live"], "draft leder fortfarande bara till live");
  assert.ok(!ALLOWED_TRANSITIONS.draft.includes("reserved" as never), "ingen väg draft -> reserved");
});

test("mina levande förturer går att lista", async () => {
  await fortur.reserve({ productId: "LP-I", efterlysningId: "e10", userId: "mig" });
  const mina = await fortur.forUser("mig");
  assert.equal(mina.length, 1);
  assert.equal((await fortur.forUser("mig", Date.now() + 48 * HOUR)).length, 0, "utgångna listas inte");
});
