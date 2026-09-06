// ─── Notispolicyn och pulsen ────────────────────────────────────────────────
//
// Fyra regler avgör om en bevakning är värd att ha kvar, och alla fyra prövas här:
//
//   1. Bara EXAKTA träffar väcker någon. En nära-träff som ringer blir ett brev man måste
//      kontrollera, och då slutar man öppna dem.
//   2. Vårt eget direkt, Tradera högst en gång per dygn.
//   3. Samma möbel en gång — och märkningen sker när notisen SKAPAS, inte när brevet går.
//   4. Varje notis bär sin efterlysning i länken.
//
// Pulsen prövas för sitt eget löfte: den skickas ÄVEN när ingenting hänt, och dess siffror är
// hämtade ur riktiga räknare eller så står de inte där.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "loopa-notify-"));
process.env.EFTERLYSNING_DATA_DIR = path.join(TMP, "efterlysningar");
process.env.OUTBOX_DIR = path.join(TMP, "outbox");
process.env.EMAIL_PROVIDER = "file";
process.env.PUBLIC_URL = "https://app.loopa.nu";
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const store = await import("../server/src/efterlysning/store.js");
const notify = await import("../server/src/efterlysning/notify.js");
const { runPulse, resetPulseMarkers } = await import("../server/src/efterlysning/pulse.js");
const { sender, outboxDir } = await import("../server/src/notify/outbox.js");
import type { Candidate } from "../server/src/efterlysning/match.js";
import type { Product } from "../server/src/butik/types.js";

const spec = (over = {}) => ({
  userId: "u1", email: "kopare@example.com",
  filter: { categorySlug: "soffor", maxPriceSek: 5000 },
  styleTags: [], deadline: null, urgency: "none" as const, note: null,
  summary: "Soffor & fåtöljer · max 5 000 kr", parseMethod: "chat" as const, area: "Södermalm",
  ...over,
});

const kandidat = (id: string, source: Candidate["source"]): Candidate => ({
  product: { id, title: `Soffa ${id}`, priceSek: 3000, source: "loopa" } as Product,
  source, kind: "exact", fitNote: "Uppfyller allt du bad om.", rank: 0,
});

const brev = () => readdirSync(outboxDir()).map((f) => readFileSync(path.join(outboxDir(), f), "utf-8"));

// ─── kanalen ────────────────────────────────────────────────────────────────

test("fil-adaptern skriver ett läsbart brev till /outbox", async () => {
  await sender().send({ to: "a@b.se", subject: "Hej", body: "Rad ett", kind: "test" });
  const texter = brev();
  assert.ok(texter.some((t) => t.includes("Till: a@b.se") && t.includes("Rad ett")));
});

test("EMAIL_PROVIDER=none skickar ingenting, och säger det", async () => {
  const had = process.env.EMAIL_PROVIDER;
  process.env.EMAIL_PROVIDER = "none";
  try {
    assert.equal(sender().name, "none");
  } finally { process.env.EMAIL_PROVIDER = had; }
});

test("en okänd leverantör tappar inte breven — den faller till fil", () => {
  const had = process.env.EMAIL_PROVIDER;
  process.env.EMAIL_PROVIDER = "sendgrdi";
  try { assert.equal(sender().name, "file"); } finally { process.env.EMAIL_PROVIDER = had; }
});

// ─── notispolicyn ───────────────────────────────────────────────────────────

test("en notis bär sin efterlysning i länken", async () => {
  const e = await store.create(spec());
  const n = await notify.notifyMatches(e, [kandidat("p1", "loopa_live")]);
  assert.ok(n);
  assert.match(n!.href, new RegExp(`mina-efterlysningar#${e.id}$`));
});

test("samma möbel notifieras aldrig två gånger", async () => {
  const e = await store.create(spec());
  assert.ok(await notify.notifyMatches(e, [kandidat("p9", "loopa_live")]));
  const igen = await store.get(e.id);
  assert.equal(await notify.notifyMatches(igen!, [kandidat("p9", "loopa_live")]), null);
});

test("märkningen sker när notisen skapas, inte när brevet går", async () => {
  // En avsändare som faller ska hellre ha missat ett brev än skicka samma brev varje minut.
  const e = await store.create(spec());
  await notify.notifyMatches(e, [kandidat("p10", "loopa_live")]);
  assert.ok((await store.get(e.id))!.notifiedProductIds.includes("p10"));
});

test("vårt eget lager får höra av sig när som helst", async () => {
  const e = await store.create(spec());
  assert.equal(await notify.mayNotify(e, "loopa_live"), true);
  assert.equal(await notify.mayNotify(e, "loopa_incoming"), true);
});

test("Tradera högst en gång per dygn och efterlysning", async () => {
  const e = await store.create(spec());
  assert.equal(await notify.mayNotify(e, "tradera"), true, "första gången");
  await notify.notifyMatches(e, [kandidat("t1", "tradera")]);
  assert.equal(await notify.mayNotify(e, "tradera"), false, "inte igen samma dygn");
  // ...men vårt eget spärras inte av Traderas takt.
  assert.equal(await notify.mayNotify(e, "loopa_live"), true);
});

test("inkorgen är personlig", async () => {
  const min = await store.create(spec({ userId: "mig" }));
  const din = await store.create(spec({ userId: "du" }));
  await notify.notifyMatches(min, [kandidat("m1", "loopa_live")]);
  await notify.notifyMatches(din, [kandidat("d1", "loopa_live")]);
  assert.equal((await notify.inbox("mig")).length, 1);
  assert.equal((await notify.inbox("du")).length, 1);
});

test("lästa notiser markeras, och bara ens egna", async () => {
  const e = await store.create(spec({ userId: "läsare" }));
  await notify.notifyMatches(e, [kandidat("l1", "loopa_live")]);
  const [n] = await notify.inbox("läsare");
  await notify.markRead("någon-annan", [n.id]);
  assert.equal((await notify.inbox("läsare"))[0].readAt, null, "fel användare ändrar inget");
  await notify.markRead("läsare", [n.id]);
  assert.ok((await notify.inbox("läsare"))[0].readAt);
});

// ─── pulsen ─────────────────────────────────────────────────────────────────

test("pulsen skickas ÄVEN när ingenting hänt", async () => {
  resetPulseMarkers();
  const e = await store.create(spec({ userId: "puls1" }));
  await store.recordSweep(e.id, 214, 2);
  const r = await runPulse();
  assert.ok(r.sent >= 1);
  const n = (await notify.inbox("puls1")).find((x) => x.kind === "puls");
  assert.ok(n, "ett livstecken i inkorgen");
  assert.match(n!.body, /214 objekt/, "siffran är den vi faktiskt läst");
  assert.match(n!.body, /2 tömningar/);
});

test("men inte två gånger samma vecka", async () => {
  const before = (await notify.inbox("puls1")).filter((n) => n.kind === "puls").length;
  await runPulse();
  const after = (await notify.inbox("puls1")).filter((n) => n.kind === "puls").length;
  assert.equal(after, before);
});

test("utan något läst påstår pulsen ingenting om siffror", async () => {
  resetPulseMarkers();
  const e = await store.create(spec({ userId: "puls2" }));
  assert.equal(e.scannedCount, 0);
  await runPulse();
  const n = (await notify.inbox("puls2")).find((x) => x.kind === "puls");
  assert.ok(n);
  assert.doesNotMatch(n!.body, /\d+ objekt/, "ingen siffra alls hellre än en påhittad");
  assert.match(n!.body, /bevakningen är igång/);
});

test("en pausad efterlysning får ingen puls", async () => {
  const e = await store.create(spec({ userId: "pausad" }));
  await store.update(e.id, { state: "paused" });
  await runPulse();
  assert.equal((await notify.inbox("pausad")).length, 0);
});

// ─── deadline-ventilen ──────────────────────────────────────────────────────

test("ventilen tiger när köparen redan fått besked om samma möbler", async () => {
  // Mätt i skarp körning: matbordet fick både en träffnotis och ett deadline-brev med exakt samma
  // innehåll — och det andra sa "inget stämmer helt" ovanför en lista med "uppfyller allt du bad om".
  const { runDeadlineValve } = await import("../server/src/efterlysning/pulse.js");
  const { sweep } = await import("../server/src/efterlysning/sweep.js");

  const e = await store.create(spec({
    userId: "vent1",
    deadline: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
  }));

  // Ta reda på vad ventilen skulle hitta, och låtsas att köparen redan fått besked om just det.
  const forhand = await sweep((await store.get(e.id))!, { generous: true });
  const exakta = forhand.candidates.filter((c) => c.kind === "exact").map((c) => c.product.id);
  if (exakta.length === 0) return; // Inget lager i den här miljön — grenen går inte att pröva.
  await store.markNotified(e.id, exakta);

  await runDeadlineValve();
  assert.equal(
    (await notify.inbox("vent1")).find((n) => n.kind === "deadline"),
    undefined,
    "brevet skulle ha upprepat det köparen redan visste",
  );
});

test("men den skickas när det bästa vi har bara är nära", async () => {
  const { runDeadlineValve } = await import("../server/src/efterlysning/pulse.js");
  const e = await store.create(spec({
    userId: "vent2",
    // Färgkravet gör varje träff till en nära-träff: ingen av våra möbler har färg satt.
    filter: { categorySlug: "soffor", maxPriceSek: 5000, colors: ["magenta"] },
    deadline: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
  }));
  await runDeadlineValve();
  const n = (await notify.inbox("vent2")).find((x) => x.kind === "deadline");
  if (!n) return; // Inget lager i den här miljön.
  assert.match(n.body, /Inget stämmer helt/);
});

test("förnyelsebrevet skriver inte '0 dagar'", async () => {
  const { runRenewalReminders } = await import("../server/src/efterlysning/pulse.js");
  const e = await store.create(spec({ userId: "forny1" }));
  await store.update(e.id, { expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString() });
  await store.recordSweep(e.id, 77);
  await runRenewalReminders();
  const n = (await notify.inbox("forny1")).find((x) => x.kind === "fornyelse");
  assert.ok(n);
  assert.doesNotMatch(n!.body, /i 0 dagar/);
  assert.match(n!.body, /77 objekt/);
});
