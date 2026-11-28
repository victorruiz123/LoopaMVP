// ─── Tradera: "Betalt objekt" → order → fraktlänk till köparen ────────────────
//
// Textraderna nedan är tagna ur en SKARP orderspecifikation (Orderspecifikation.pdf, sept 2026) med
// samma koordinater och samma egenheter — plustecknet som en osynlig glyf, säljaren till vänster och
// köparen till höger på samma höjd — men med påhittade personer. Det farligaste felet här är att
// SMS:et går till säljarens nummer, som står FÖRE köparens i den platta texten.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.BUTIK_DATA_DIR = mkdtempSync(path.join(tmpdir(), "loopa-orderspec-butik-"));
process.env.OUTBOX_DIR = mkdtempSync(path.join(tmpdir(), "loopa-orderspec-outbox-"));
process.env.EMAIL_PROVIDER = "file";
process.env.SMS_PROVIDER = "file";
process.env.LOOPA_PUBLIC_URL = "https://app.loopa.nu";
after(() => {
  rmSync(process.env.BUTIK_DATA_DIR!, { recursive: true, force: true });
  rmSync(process.env.OUTBOX_DIR!, { recursive: true, force: true });
});

const { parseOrderspecifikation, parseBetaltMejl, normalizePhone, isBetaltMejl } = await import(
  "../server/src/integrations/tradera/orderspec.js"
);
const { classify } = await import("../server/src/integrations/tradera/mail.js");
const { smsText, mejlText, prisUppdelning, hanteraBetaltKop, kortTitel } = await import("../server/src/integrations/tradera/betald.js");
const { smsDelar } = await import("../server/src/notify/sms.js");
const { orderByFraktToken, resetOrders } = await import("../server/src/butik/orders.js");
const { handleButikFrakt } = await import("../server/src/butik/routes.js");

type Item = { str: string; x: number; y: number };
const I = (x: number, y: number, str: string): Item => ({ x, y, str });
/** Glyfen där "+" borde stå. Läses som ett tecken utan text. */
const PLUS = "\u0003";

/** Den skarpa layouten, påhittade personer. */
function specItems(opts: { kopareTelefon?: string | null; kopareRad2?: string | null } = {}): Item[] {
  const items: Item[] = [
    I(27, 790, "Orderspeci"), I(119, 790, "fi"), I(130, 790, "kation"),
    I(27, 764, "Webbplats"), I(78, 764, ":"), I(81, 764, " "), I(83, 764, "tradera"), I(117, 764, "."), I(120, 764, "com"),
    I(27, 739, "Datum"), I(492, 739, "2026"), I(518, 739, "09"), I(533, 739, "26 11"), I(557, 739, "59"),
    I(27, 709, "Ordernummer"), I(94, 709, " "), I(521, 709, "152000111"),
    I(27, 679, "Säljare"), I(60, 679, " "), I(62, 679, "|"), I(65, 679, " "), I(68, 679, "Saljkonto1"),
    I(27, 659, "Sara Säljare"),
    I(27, 643, "Säljgatan 1"),
    I(27, 627, "11122 Stockholm"),
    I(27, 603, "sara.saljare@example.com"),
    I(27, 587, PLUS), I(33, 587, "46700000001"),
    I(488, 679, "Köpare"), I(521, 679, " "), I(524, 679, "|"), I(527, 679, " "), I(530, 679, "Kopkonto9"),
    I(499, 659, "Kim Köpare"),
    I(482, 643, "Köpvägen 108"),
  ];
  let y = 627;
  if (opts.kopareRad2) {
    items.push(I(482, y, opts.kopareRad2));
    y -= 16;
  }
  items.push(I(497, y, "18651 Vallentuna"));
  items.push(I(451, 603, "kim.kopare@example.com"));
  if (opts.kopareTelefon !== null) items.push(I(503, 587, PLUS), I(509, 587, opts.kopareTelefon ?? "46700000009"));
  items.push(
    I(27, 539, "Produkt"), I(177, 539, "Egen referens"), I(318, 539, "Objektnr"), I(392, 539, "Antal"), I(445, 539, "Pris"), I(509, 539, "Totalt"),
    I(27, 514, "3-sitssoffa Bergholm från"), I(27, 503, "SoffaDirekt i ljusklädsel"),
    I(177, 514, "3146ad51"), I(223, 514, "88d8"), I(249, 514, "4a23"), I(275, 514, "8…"),
    I(318, 514, "751514068"), I(392, 514, "1"), I(445, 514, "1 600,00"), I(532, 514, "1 600,00"),
    I(27, 473, "Frakt"), I(392, 473, "1"), I(445, 473, "0,00"), I(549, 473, "0,00"),
    I(27, 443, "Totalt"), I(530, 443, "1 600,00"),
    I(27, 427, "Varav moms 25%"), I(548, 427, "0,00"),
    I(27, 389, "Betalmetod"), I(543, 389, "Swish"),
  );
  return items;
}

test("köparen läses ur HÖGER kolumn — säljarens nummer blir aldrig köparens", () => {
  const spec = parseOrderspecifikation(specItems());
  assert.equal(spec.ordernummer, "152000111");
  assert.equal(spec.kopare.telefon, "+46700000009");
  assert.equal(spec.saljare.telefon, "+46700000001");
  assert.deepEqual(
    { ...spec.kopare },
    { alias: "Kopkonto9", namn: "Kim Köpare", adress: "Köpvägen 108", postnummer: "18651", ort: "Vallentuna", email: "kim.kopare@example.com", telefon: "+46700000009" },
  );
  assert.deepEqual(
    { ...spec.saljare },
    { alias: "Saljkonto1", namn: "Sara Säljare", adress: "Säljgatan 1", postnummer: "11122", ort: "Stockholm", email: "sara.saljare@example.com", telefon: "+46700000001" },
  );
  assert.deepEqual(spec.objektnr, [751514068]);
  assert.equal(spec.totaltSek, 1600);
  assert.equal(spec.fraktSek, 0);
  assert.equal(spec.betalmetod, "Swish");
});

test("köpare utan telefon: inget nummer — och säljarens tas inte i dess ställe", () => {
  const spec = parseOrderspecifikation(specItems({ kopareTelefon: null }));
  assert.equal(spec.kopare.telefon, null);
  assert.equal(spec.kopare.email, "kim.kopare@example.com");
  assert.equal(spec.saljare.telefon, "+46700000001");
});

test("två adressrader fogas ihop, postnumret hittas ändå", () => {
  const spec = parseOrderspecifikation(specItems({ kopareRad2: "c/o Andersson" }));
  assert.equal(spec.kopare.adress, "Köpvägen 108, c/o Andersson");
  assert.equal(spec.kopare.postnummer, "18651");
  assert.equal(spec.kopare.ort, "Vallentuna");
});

test("telefonnummer normaliseras till E.164", () => {
  assert.equal(normalizePhone("46701234567"), "+46701234567");
  assert.equal(normalizePhone("+46 70-123 45 67"), "+46701234567");
  assert.equal(normalizePhone("070-123 45 67"), "+46701234567");
  assert.equal(normalizePhone("0046701234567"), "+46701234567");
  assert.equal(normalizePhone("\u000346701234567"), "+46701234567");
  assert.equal(normalizePhone("123"), null);
  assert.equal(normalizePhone(""), null);
});

const HTML = `<span class="h1">Ordern &#xE4;r betald - Dags att skicka</span>
Hej! K&#xF6;paren Kopkonto9 har betalat. Inbetalningen f&#xF6;r objekt och frakt hamnar p&#xE5; ditt saldo p&#xE5; Tradera.
<a href="https://www.tradera.com/my/shipping?purchaseOrderId=0a0a0a0a-1111-4222-8333-444444444444&utm_source=x">Boka frakt</a>
<td>Ordernummer 152000111</td>
<a href="https://www.tradera.com/item/302537/751514068/3-sitssoffa-bergholm?utm_source=x">3-sitssoffa</a>
<span>Objektnr &zwj;751514068 <span>&nbsp;•&nbsp;Egen referens:&nbsp;3146ad51-88d8-4a23-8fba-57832da653c6</span></span>`;
const SUBJECT = "Betalt objekt - 3-sitssoffa Bergholm från SoffaDirekt i ljusklädsel (751514068)";

test("'Betalt objekt' är en egen sort — inte 'såld', inte 'övrigt'", () => {
  assert.equal(classify(SUBJECT, "Hej! Köparen Kopkonto9 har betalat."), "betald");
  assert.equal(classify("Sålt objekt - 3-sitssoffa Bergholm (751514068). Köpare: Kopkonto9", ""), "sald");
  assert.equal(isBetaltMejl(SUBJECT, ""), true);
});

test("mejlet ger ordernummer, objekt, vår egen referens och Traderas köp-id", () => {
  const m = parseBetaltMejl(SUBJECT, null, HTML);
  assert.equal(m.ordernummer, "152000111");
  assert.equal(m.itemId, 751514068);
  assert.equal(m.egenReferens, "3146ad51-88d8-4a23-8fba-57832da653c6");
  assert.equal(m.alias, "Kopkonto9");
  assert.equal(m.purchaseOrderId, "0a0a0a0a-1111-4222-8333-444444444444");
  assert.equal(m.titel, "3-sitssoffa Bergholm från SoffaDirekt i ljusklädsel");
});

test("SMS:et: förnamn, möbeln, länken — och högst två SMS-delar", () => {
  const lank = "https://app.loopa.nu/butik/frakt/AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const text = smsText({ namn: "Kim Köpare", titel: "3-sitssoffa Bergholm från SoffaDirekt i ljusklädsel", lank });
  assert.match(text, /^Hej Kim! /);
  assert.ok(text.includes(lank));
  assert.ok(smsDelar(text) <= 2, `${smsDelar(text)} delar: ${text}`);
  assert.equal(kortTitel("3-sitssoffa Bergholm från SoffaDirekt i ljusklädsel"), "3-sitssoffa Bergholm från SoffaDirekt i ljusklädsel");
  assert.equal(kortTitel("Matbord i massiv ek med två iläggsskivor och sex stolar, Gemla 1970-tal"), "Matbord i massiv ek med två iläggsskivor och sex stolar,".replace(/,$/, "") + "...");
  assert.match(smsText({ namn: null, titel: null, lank }), /^Hej! Tack för ditt köp av möbeln/);
  const m = mejlText({ namn: "Kim Köpare", titel: "Soffa", lank, ordernummer: "152000111", adress: "Köpvägen 108, 18651 Vallentuna" });
  assert.ok(m.body.includes(lank));
  assert.ok(m.body.includes("Köpvägen 108, 18651 Vallentuna"));
});

test("priset delas i möbel och frakt som på en butiksorder", () => {
  // Inbakad frakt (äldre annonser): annonsens frakt dras av totalen.
  assert.deepEqual(prisUppdelning({ totaltSek: 1600, fraktSek: 0 }, { tradera: { shippingSek: 600 } } as never), { priceSek: 1000, deliveryFeeSek: 600 });
  // Frakten som egen rad hos Tradera.
  assert.deepEqual(prisUppdelning({ totaltSek: 1600, fraktSek: 600 }, null), { priceSek: 1000, deliveryFeeSek: 600 });
  // Separat frakt men "Annat fraktsätt" 0 kr: hela beloppet är möbeln.
  assert.deepEqual(prisUppdelning({ totaltSek: 1600, fraktSek: 0 }, { tradera: { fraktSeparat: true } } as never), { priceSek: 1600, deliveryFeeSek: 0 });
});

function fakeRes() {
  const r = { status: 0, body: "" as string, writeHead(s: number) { r.status = s; return r; }, end(b: string) { r.body = b; } };
  return r;
}

test("hela kedjan: order med köpare och säljare, SMS till KÖPAREN, mejl, en gång", async () => {
  resetOrders();
  const spec = parseOrderspecifikation(specItems());
  const meta = parseBetaltMejl(SUBJECT, null, HTML);
  const input = {
    meta,
    spec,
    messageId: "<betalt-1@tradera.com>",
    receivedAt: "2026-09-26T10:01:17.000Z",
    job: null,
    loopaId: "LP-TEST-0001",
    titel: "3-sitssoffa Bergholm från SoffaDirekt i ljusklädsel",
  };
  const forsta = await hanteraBetaltKop(input);
  assert.equal(forsta.created, true);
  assert.equal(forsta.order.status, "paid");
  assert.equal(forsta.order.kanal, "tradera");
  assert.equal(forsta.order.kopare?.telefon, "+46700000009");
  assert.equal(forsta.order.kopare?.namn, "Kim Köpare");
  assert.equal(forsta.order.postalCode, "18651");
  assert.equal(forsta.order.tradera?.saljare.namn, "Sara Säljare");
  assert.equal(forsta.order.tradera?.saljare.adress, "Säljgatan 1");
  assert.equal(forsta.order.tradera?.jobId, "3146ad51-88d8-4a23-8fba-57832da653c6");
  assert.equal(forsta.order.tradera?.ordernummer, "152000111");
  assert.ok((forsta.order.fraktToken ?? "").length >= 30);

  const filer = readdirSync(process.env.OUTBOX_DIR!);
  const sms = filer.filter((f) => f.includes("sms-tradera-frakt"));
  assert.equal(sms.length, 1);
  assert.ok(sms[0].includes("+46700000009"), "SMS:et ska gå till köparen");
  assert.ok(!filer.some((f) => f.includes("46700000001")), "inget får gå till säljarens nummer");
  const smsFil = readFileSync(path.join(process.env.OUTBOX_DIR!, sms[0]), "utf-8");
  assert.ok(smsFil.includes(`/butik/frakt/${forsta.order.fraktToken}`));
  assert.equal(filer.filter((f) => f.includes("tradera-frakt__kim.kopare")).length, 1);

  // Samma mejl igen: ingen ny order, inget nytt SMS.
  const andra = await hanteraBetaltKop(input);
  assert.equal(andra.created, false);
  assert.equal(andra.order.id, forsta.order.id);
  assert.equal(readdirSync(process.env.OUTBOX_DIR!).length, filer.length);

  // Fraktlänken öppnar ordern utan inloggning — utan säljarens uppgifter och utan token.
  const res = fakeRes();
  const handled = await handleButikFrakt(["frakt", forsta.order.fraktToken!], { method: "GET" } as never, res as never);
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.order.kopare.namn, "Kim Köpare");
  assert.equal(body.order.tradera.saljare.namn, null);
  assert.equal(body.order.tradera.saljare.telefon, null);
  assert.equal(body.order.fraktToken, undefined);
  assert.ok(Array.isArray(body.slots) && body.slots.length > 0, "Vallentuna ligger i en leveranszon");

  // Fel token: 404.
  const fel = fakeRes();
  await handleButikFrakt(["frakt", "x".repeat(32)], { method: "GET" } as never, fel as never);
  assert.equal(fel.status, 404);
  assert.equal(await orderByFraktToken("kort"), null);
});

test("46elks: rätt adress, Basic-inloggning, avsändare Loopa — och provläget skickar dryrun", async () => {
  const { sendSms } = await import("../server/src/notify/sms.js");
  const fore = { u: process.env.ELKS_API_USERNAME, p: process.env.ELKS_API_PASSWORD, prov: process.env.SMS_PROVIDER, dry: process.env.SMS_DRYRUN };
  const origFetch = globalThis.fetch;
  const anrop: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    anrop.push({ url, init });
    return new Response(JSON.stringify({ id: "s123", status: "created" }), { status: 200 });
  }) as typeof fetch;
  try {
    process.env.ELKS_API_USERNAME = "uabc";
    process.env.ELKS_API_PASSWORD = "hemligt";
    delete process.env.SMS_PROVIDER;
    process.env.SMS_DRYRUN = "1";
    const r = await sendSms({ to: "+46700000009", text: "Hej!", kind: "prov" });
    assert.deepEqual(r, { sent: true, provider: "46elks", id: "s123", error: null });
    assert.equal(anrop[0].url, "https://api.46elks.com/a1/sms");
    assert.equal((anrop[0].init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("uabc:hemligt").toString("base64")}`);
    const body = new URLSearchParams(String(anrop[0].init.body));
    assert.equal(body.get("from"), "Loopa");
    assert.equal(body.get("to"), "+46700000009");
    assert.equal(body.get("message"), "Hej!");
    assert.equal(body.get("dryrun"), "yes");

    // Ett fel från 46elks blir ett tydligt "inte skickat", inte ett kast.
    globalThis.fetch = (async () => new Response("Not enough credits", { status: 402 })) as typeof fetch;
    const fel = await sendSms({ to: "+46700000009", text: "Hej!", kind: "prov" });
    assert.equal(fel.sent, false);
    assert.match(fel.error ?? "", /402.*credits/);
    // Ogiltigt nummer når aldrig leverantören.
    assert.equal((await sendSms({ to: "0700", text: "x", kind: "prov" })).sent, false);
  } finally {
    globalThis.fetch = origFetch;
    for (const [k, v] of [["ELKS_API_USERNAME", fore.u], ["ELKS_API_PASSWORD", fore.p], ["SMS_PROVIDER", fore.prov], ["SMS_DRYRUN", fore.dry]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("panelens 'Skicka fraktlänken igen' skickar SMS + mejl en gång till och skriver det i historiken", async () => {
  const { andraOrder } = await import("../server/src/adminOrdrar.js");
  const { allOrders } = await import("../server/src/butik/orders.js");
  const order = (await allOrders()).find((o) => o.kanal === "tradera");
  assert.ok(order);
  const fore = readdirSync(process.env.OUTBOX_DIR!).length;
  const detalj = await andraOrder(order!.id, { gor: "skicka-fraktlank" }, "admin-1");
  assert.ok(detalj);
  const efter = readdirSync(process.env.OUTBOX_DIR!);
  assert.equal(efter.length, fore + 2, "ett SMS och ett mejl till");
  assert.ok(detalj!.handelser.some((h) => /igen, från panelen/.test(h.note)));
  // En order som inte finns ger null, inte ett utskick.
  assert.equal(await andraOrder("finns-inte", { gor: "skicka-fraktlank" }, null), null);
});
