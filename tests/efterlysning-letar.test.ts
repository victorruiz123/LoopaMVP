// ─── "Letar du möbel?": vägen in och brevet ut ──────────────────────────────
//
// Två saker prövas här, och båda handlar om att INGENTING SOM SADES FÅR TAPPAS BORT.
//
// Det första är vägen in. Efterlysningen sparas med köparens egna ord bredvid de tolkade fälten, med
// frågeloggen (inklusive de överhoppade) och med var på sajten de kom ifrån. Tolkningen kastar med
// flit allt den inte kan pröva mot katalogen, och det som kastas är ofta just det en människa
// behöver läsa — matchningen sker för hand.
//
// Det andra är brevet. Det bär möbel, pris och en länk rakt till produktsidan, och samma möbel går
// inte att skicka två gånger. Regeln sitter på servern och inte i en grå knapp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "loopa-letar-"));
process.env.EFTERLYSNING_DATA_DIR = path.join(TMP, "efterlysningar");
process.env.BUTIK_DATA_DIR = path.join(TMP, "butik");
process.env.LOOPA_PUBLIC_URL = "https://app.loopa.nu";
// Utskicket skriver till fil i det här läget. Testet läser inte breven — det räcker att avsändaren
// inte är en riktig leverantör.
process.env.OUTBOX_DIR = path.join(TMP, "outbox");
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const store = await import("../server/src/efterlysning/store.js");
const { handleEfterlysningPublic } = await import("../server/src/efterlysning/routes.js");

/** En begäran som en läsbar ström, vilket är allt `readBody` behöver. */
function req(method: string, body: unknown): never {
  const r = new EventEmitter() as never as { method: string; url: string } & AsyncIterable<Buffer>;
  const kropp = Buffer.from(JSON.stringify(body), "utf-8");
  (r as { method: string }).method = method;
  (r as { url: string }).url = "/";
  (r as unknown as { [Symbol.asyncIterator]: () => AsyncGenerator<Buffer> })[Symbol.asyncIterator] =
    async function* () { yield kropp; };
  return r as never;
}

/** Ett svar som bara minns vad som skrevs till det. */
function res() {
  const out = { status: 0, body: null as unknown };
  return {
    writeHead(status: number) { out.status = status; },
    end(text: string) { out.body = text ? JSON.parse(text) : null; },
    out,
  };
}

async function post(väg: string, body: unknown) {
  const r = res();
  const träff = await handleEfterlysningPublic([väg], req("POST", body), r as never);
  assert.ok(träff, `vägen /${väg} svarade inte`);
  return r.out;
}

// ─── vägen in ───────────────────────────────────────────────────────────────

test("beskrivningen sparas med köparens egna ord kvar", async () => {
  const text = "En 3-sits soffa i ljust tyg, gärna HAY, max 7 000 kr, får plats 220 cm.";
  const svar = await post("beskrivning", {
    text,
    spec: {
      filter: { categorySlug: "soffor", maxPriceSek: 7000 },
      styleTags: [], deadline: null, urgency: "none", note: null, summary: "", aiUsed: true,
    },
    fragor: [],
    epost: "Kim@Exempel.se",
    varifran: "/butik/objekt/LP-1234-5678",
  });

  assert.equal(svar.status, 201);
  const id = (svar.body as { efterlysning: { id: string } }).efterlysning.id;
  const rad = await store.get(id);

  // Meningen ordagrant. Tolkningen tappade "HAY" — märket finns inte i lagret och överlever därför
  // inte valideringen — och utan den här raden hade önskemålet varit borta för alltid.
  assert.equal(rad?.originalText, text);
  assert.match(rad!.originalText!, /HAY/);
  assert.equal(rad?.origin, "/butik/objekt/LP-1234-5678");
  // Adressen normaliseras. "Kim@Exempel.se" och "kim@exempel.se" är samma brevlåda.
  assert.equal(rad?.email, "kim@exempel.se");
  assert.equal(rad?.userId, null, "inget konto krävs — se DECISIONS.md #9");
  assert.equal(rad?.state, "active");
});

test("frågeloggen behåller de överhoppade frågorna", async () => {
  const svar = await post("beskrivning", {
    text: "en soffa",
    spec: { filter: { categorySlug: "soffor" }, styleTags: [], deadline: null, urgency: "none", note: null, summary: "", aiUsed: true },
    fragor: [
      { field: "maxpris", question: "Ungefär vad vill du lägga?", answer: "5 000 kr" },
      { field: "matt", question: "Finns det något mått den måste passa?", answer: "" },
      { field: "skick", question: "Hur viktigt är skicket?", answer: "Som nytt" },
    ],
    epost: "kim@exempel.se",
    varifran: "/",
  });

  const rad = await store.get((svar.body as { efterlysning: { id: string } }).efterlysning.id);
  assert.equal(rad?.asked?.length, 3);

  // En överhoppad fråga ÄR ett svar: den säger att frågan inte var värd att svara på. Tom sträng och
  // null hade varit två sätt att skriva samma sak, och statistiken över överhoppade frågor hade
  // blivit osann.
  assert.equal(rad?.asked?.[1].answer, null);
  assert.equal(rad?.asked?.[1].question, "Finns det något mått den måste passa?");

  // Svaren är invävda i specen, inte bara loggade. Loggen och filtret skrivs av samma slinga.
  assert.equal(rad?.filter.maxPriceSek, 5000);
  assert.deepEqual(rad?.filter.grades, ["A"], "'Som nytt' är betyg A");
});

test("en adress utan @ avvisas med ett svar som hjälper", async () => {
  const svar = await post("beskrivning", { text: "en soffa", epost: "kim" });
  assert.equal(svar.status, 400);
  assert.match((svar.body as { error: string }).error, /e-postadress/i);
});

test("faller tolkningen sparas meningen ändå", async () => {
  // Utan spec finns bara det personen skrev — och det är fullt användbart för en människa som
  // matchar för hand. Ett felmeddelande här hade kostat oss hela avsikten.
  const svar = await post("beskrivning", {
    text: "något att ha vid sängen, gärna i trä",
    epost: "kim@exempel.se",
    varifran: "/",
  });
  assert.equal(svar.status, 201);
  const rad = await store.get((svar.body as { efterlysning: { id: string } }).efterlysning.id);
  assert.equal(rad?.originalText, "något att ha vid sängen, gärna i trä");
  // Sammanfattningen blir köparens ord och inte "Allt i lagret", som är vad ett tomt filter
  // sammanfattas till. Sant om ett filter, men en lögn som rubrik på någons efterlysning.
  assert.match(rad!.summary, /vid sängen/);
});

// ─── brevet ut ──────────────────────────────────────────────────────────────

test("samma möbel går inte att skicka två gånger", async () => {
  const { skickaTips, TipsFel, produktLank } = await import("../server/src/efterlysning/admin.js");

  const rad = await store.create({
    userId: null, email: "kim@exempel.se",
    filter: { categorySlug: "soffor" }, styleTags: [], deadline: null, urgency: "none",
    note: null, summary: "Soffor", parseMethod: "chat", area: null,
  });

  // Möbeln finns inte i lagret i testet, så anropet faller på det — men märkningen prövas för sig:
  // regeln får inte sitta i knappen.
  await store.markNotified(rad.id, ["LP-1111-2222"]);
  await assert.rejects(
    () => skickaTips(rad.id, "LP-1111-2222"),
    (err: unknown) => err instanceof TipsFel && /redan hört av oss/.test((err as Error).message),
  );

  // Länken i brevet pekar på produktsidan och inte på en inloggning: mottagaren ska kunna avgöra om
  // det är rätt möbel utan att först logga in någonstans.
  assert.equal(produktLank("LP-1111-2222"), "https://app.loopa.nu/butik/objekt/LP-1111-2222");
});

test("en efterlysning utan adress får inget brev", async () => {
  const { skickaTips, TipsFel } = await import("../server/src/efterlysning/admin.js");
  const rad = await store.create({
    userId: "u1", email: null,
    filter: {}, styleTags: [], deadline: null, urgency: "none",
    note: null, summary: "", parseMethod: "chat", area: null,
  });
  await assert.rejects(
    () => skickaTips(rad.id, "LP-9999-9999"),
    (err: unknown) => err instanceof TipsFel && /e-postadress/.test((err as Error).message),
  );
});

// ─── panelen ────────────────────────────────────────────────────────────────

test("panelen visar riktiga efterlysningar, inte svepets utkast", async () => {
  const { listaEfterlysningar } = await import("../server/src/efterlysning/admin.js");

  // Direktsvepet skapar en rad utan både konto och adress. Den är ingens efterlysning — den finns
  // bara för att bära svepets loggning — och en människa ska aldrig behöva sålla bort den.
  await store.create({
    userId: null, email: null,
    filter: {}, styleTags: [], deadline: null, urgency: "none",
    note: null, summary: "utkast", parseMethod: "chat", area: null, state: "paused",
  });

  const { poster } = await listaEfterlysningar();
  assert.ok(poster.length > 0);
  assert.ok(poster.every((p) => p.epost || p.konto), "utkast utan väg att nå någon ska inte stå i listan");
  // Nyast först: den som skrev senast är den som ännu inte fått något svar.
  const tider = poster.map((p) => new Date(p.skapad).getTime());
  assert.deepEqual(tider, [...tider].sort((a, b) => b - a));
});
