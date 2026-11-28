// ─── Fraktsidan: adressen, granskningen, bekräftelse-SMS:et och SMS-saldot ──────────────────────
//
// Påhittade personer. Det som skyddas: en adress utanför Storstockholm ger aldrig tider, en
// granskning når Isac och panelen, ett godkännande öppnar tiderna, och den bokade frakten blir ett
// SMS till KÖPAREN.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fraktadress-butik-"));
process.env.OUTBOX_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fraktadress-outbox-"));
process.env.SMS_SALDO_DIR = mkdtempSync(path.join(tmpdir(), "loopa-fraktadress-saldo-"));
process.env.EMAIL_PROVIDER = "file";
process.env.SMS_PROVIDER = "file";
process.env.LOOPA_PUBLIC_URL = "https://app.loopa.nu";
delete process.env.FRAKT_NOTIFY_TO;
after(() => {
  for (const d of [process.env.BUTIK_DATA_DIR!, process.env.OUTBOX_DIR!, process.env.SMS_SALDO_DIR!]) rmSync(d, { recursive: true, force: true });
});

const { createTraderaOrder, getOrder } = await import("../server/src/butik/orders.js");
const { handleButikFrakt } = await import("../server/src/butik/routes.js");
const { andraOrder, listaOrdrar } = await import("../server/src/adminOrdrar.js");
const { confirmDelivery } = await import("../server/src/butik/checkout.js");
const { fraktBokadSms } = await import("../server/src/butik/notiser.js");
const { smsDelar } = await import("../server/src/notify/sms.js");

let nr = 0;
async function nyOrder(postnummer: string, ort: string) {
  nr++;
  const kopare = { alias: "testkop", namn: "Kim Köpare", adress: "Testvägen 1", postnummer, ort, email: `kim${nr}@example.com`, telefon: `+4670000010${nr}` };
  const saljare = { alias: "loopa", namn: "Loopa AB", adress: "Exempelgatan 1", postnummer: "11122", ort: "Stockholm", email: null, telefon: "+46700000001" };
  const { order } = await createTraderaOrder({
    productId: `LP-TEST-${nr}`,
    priceSek: 1000,
    deliveryFeeSek: 0,
    kopare,
    zone: null,
    tradera: { ordernummer: `T-${nr}`, itemId: 1, purchaseOrderId: null, jobId: null, jobOwnerId: null, saljare, totaltSek: 1299, betalmetod: "Kort", betaldAt: new Date().toISOString(), messageId: null },
  });
  return order;
}

function fakeRes() {
  const r = { status: 0, body: "", headers: {} as Record<string, unknown> };
  return Object.assign(r, {
    writeHead(s: number, h?: Record<string, unknown>) { r.status = s; Object.assign(r.headers, h ?? {}); return r; },
    setHeader(k: string, v: unknown) { r.headers[k] = v; },
    end(b?: string) { r.body = b ?? ""; },
  });
}

async function anrop(token: string, del: string | null, method: string, data?: unknown) {
  const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]), { method, headers: { "content-type": "application/json" } });
  const res = fakeRes();
  await handleButikFrakt(del ? ["frakt", token, del] : ["frakt", token], req as never, res as never);
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

const utkorg = () => readdirSync(process.env.OUTBOX_DIR!);

test("adress utanför området: inga tider, och en ny adress utanför sparas inte", async () => {
  const o = await nyOrder("90325", "Umeå");
  const forst = await anrop(o.fraktToken!, null, "GET");
  assert.equal(forst.body.utanforZon, true);
  assert.deepEqual(forst.body.slots, []);

  const nej = await anrop(o.fraktToken!, "adress", "POST", { adress: "Storgatan 5", postnummer: "903 26", ort: "Umeå" });
  assert.equal(nej.status, 422);
  assert.equal(nej.body.kod, "utanfor");
  assert.equal((await getOrder(o.id))!.kopare!.adress, "Testvägen 1", "ingenting får ändras");
});

test("köparen byter till en adress inom området: sparas, och tiderna öppnas", async () => {
  const o = await nyOrder("90325", "Umeå");
  const ja = await anrop(o.fraktToken!, "adress", "POST", { adress: "Storgatan 12", postnummer: "113 51", ort: "Stockholm" });
  assert.equal(ja.status, 200);
  assert.equal(ja.body.utanforZon, false);
  assert.ok(ja.body.slots.length > 0);
  const sparad = (await getOrder(o.id))!;
  assert.equal(sparad.kopare!.adress, "Storgatan 12");
  assert.equal(sparad.postalCode, "11351");
  assert.equal(sparad.deliveryZone, "innerstad");
  assert.ok(sparad.events.some((e) => e.note.includes("ändrade leveransadressen")));

  // Ogiltigt postnummer: 400, inte 422.
  const fel = await anrop(o.fraktToken!, "adress", "POST", { adress: "X 1", postnummer: "12", ort: "Y" });
  assert.equal(fel.status, 400);
});

test("'Hittar du inte din adress?': mejl till Isac, siffra i panelen, godkänn öppnar tiderna och SMS:ar köparen", async () => {
  const o = await nyOrder("76190", "Norrtälje");
  const fore = utkorg().length;
  const g = await anrop(o.fraktToken!, "adress-granskning", "POST", { text: "Nybyggd gård, Lilla Vägen 3, 761 90 Norrtälje" });
  assert.equal(g.status, 200);
  assert.equal(g.body.order.adressGranskning.status, "vantar");
  assert.deepEqual(g.body.slots, []);

  const nya = utkorg().slice(fore);
  const mejl = nya.find((f) => f.includes("ops-adress-granskning") && f.includes("isacekelund07@gmail.com"));
  assert.ok(mejl, `mejl till Isac saknas: ${nya.join(", ")}`);
  assert.match(readFileSync(path.join(process.env.OUTBOX_DIR!, mejl!), "utf-8"), /Lilla Vägen 3/);

  const rad = (await listaOrdrar()).rader.find((r) => r.id === o.id)!;
  assert.equal(rad.adressGranskning?.status, "vantar");
  assert.match(rad.attGora ?? "", /Granska/);

  // Tider går inte att skicka medan adressen granskas.
  const tidig = await anrop(o.fraktToken!, "leverans", "POST", { tider: [{ datum: "2030-01-07", tid: "08–12" }] });
  assert.equal(tidig.status, 409);

  await andraOrder(o.id, { gor: "godkann-adress", adress: "Lilla Vägen 3", postnummer: "76190", ort: "Norrtälje" }, null);
  const efter = await anrop(o.fraktToken!, null, "GET");
  assert.equal(efter.body.order.adressGranskning.status, "godkand");
  assert.ok(efter.body.slots.length > 0, "godkänd adress ska ge tider trots att den ligger utanför zonen");
  const sms = utkorg().find((f) => f.includes("sms-frakt-adress-godkand") && f.includes(o.kopare!.telefon!.slice(1)));
  assert.ok(sms, "köparen ska få ett SMS när adressen godkänts");

  const slot = efter.body.slots[0];
  const tider = await anrop(o.fraktToken!, "leverans", "POST", { tider: [{ datum: slot.date, tid: slot.window }] });
  assert.equal(tider.status, 200);
  assert.equal(tider.body.order.status, "booking");
});

test("avvisad adress: köparen får SMS och ombeds ange en ny", async () => {
  const o = await nyOrder("98132", "Kiruna");
  await anrop(o.fraktToken!, "adress-granskning", "POST", { text: "Bergsgatan 1, Kiruna" });
  await andraOrder(o.id, { gor: "avvisa-adress", text: "för långt" }, null);
  const efter = await anrop(o.fraktToken!, null, "GET");
  assert.equal(efter.body.order.adressGranskning.status, "avvisad");
  assert.deepEqual(efter.body.slots, []);
  assert.ok(utkorg().some((f) => f.includes("sms-frakt-adress-avvisad")));
});

test("bokad frakt: bekräftelse-SMS till KÖPAREN med dag och tid, en SMS-del", async () => {
  const o = await nyOrder("11351", "Stockholm");
  await confirmDelivery(o.id, "2030-01-07", "08–12");
  const fil = await (async () => {
    for (let i = 0; i < 50; i++) {
      const f = utkorg().find((x) => x.includes("sms-frakt-bokad") && x.includes(o.kopare!.telefon!.slice(1)));
      if (f) return f;
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  })();
  assert.ok(fil, "bekräftelse-SMS saknas");
  const text = readFileSync(path.join(process.env.OUTBOX_DIR!, fil!), "utf-8");
  assert.match(text, /måndag 7 jan kl 08-12/);
  assert.ok(!utkorg().some((f) => f.includes("sms-frakt-bokad") && f.includes("46700000001")), "aldrig till säljaren");

  const lang = fraktBokadSms({ namn: "Kim Köpare", titel: "IKEA Volfgang barstol i svart konstläder", datum: "2030-01-07", tid: "12–18" });
  assert.equal(smsDelar(lang), 1, lang);
});

test("SMS-saldot: varnar under gränsen, högst en gång per dygn, och nollställs när det fyllts på", async () => {
  const { kollaSmsSaldo } = await import("../server/src/notify/smsSaldo.js");
  const orig = { fetch: globalThis.fetch, provider: process.env.SMS_PROVIDER };
  delete process.env.SMS_PROVIDER;
  process.env.ELKS_API_USERNAME = "utest";
  process.env.ELKS_API_PASSWORD = "ptest";
  let balance = 52000; // 5,20 kr
  globalThis.fetch = (async (url: string) => {
    assert.equal(url, "https://api.46elks.com/a1/me");
    return new Response(JSON.stringify({ balance, currency: "SEK" }), { status: 200 });
  }) as typeof fetch;
  try {
    const varningar = () => utkorg().filter((f) => f.includes("ops-sms-saldo")).length;
    const fore = varningar();
    const t0 = new Date("2030-01-07T09:00:00Z");

    const a = await kollaSmsSaldo(t0);
    assert.equal(a.saldoKr, 5.2);
    assert.equal(a.varnade, true);
    assert.equal(varningar(), fore + 1);

    await kollaSmsSaldo(new Date(t0.getTime() + 3_600_000));
    assert.equal(varningar(), fore + 1, "inte igen inom ett dygn");

    await kollaSmsSaldo(new Date(t0.getTime() + 25 * 3_600_000));
    assert.equal(varningar(), fore + 2, "igen nästa dygn om det fortfarande är lågt");

    balance = 500000; // påfyllt
    const b = await kollaSmsSaldo(new Date(t0.getTime() + 26 * 3_600_000));
    assert.equal(b.varnade, false);
    balance = 52000;
    const c = await kollaSmsSaldo(new Date(t0.getTime() + 27 * 3_600_000));
    assert.equal(c.varnade, true, "efter påfyllning varnar den direkt nästa gång det blir lågt");
  } finally {
    globalThis.fetch = orig.fetch;
    process.env.SMS_PROVIDER = orig.provider;
    delete process.env.ELKS_API_USERNAME;
    delete process.env.ELKS_API_PASSWORD;
  }
});
