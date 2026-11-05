// ─── Säljarens siffror från Tradera och Blocket ──────────────────────────────
//
// Fyra saker måste hålla, alla prövade utan webbläsare och mot sidorna som de stod 2026-10-29:
//
// BLOCKETS STATISTIKSIDA LÄSES SOM DEN STÅR. Sammanfattningen är text; dagarna ligger som base64-JSON i
// diagrammets data-props. En sida utan huvudtalen ger null — hellre förra avläsningen än nollor.
//
// TRADERAS SÄLJARLISTA LÄSES SOM DEN STÅR: visningar och bevakare per annons, ur webbklientens JSON.
//
// RÄTT ANNONSER RÄKNAS: den aktuella och de som ligger kvar efter en omläggning, aldrig en nedtagen.
//
// EN PUNKT PER DAG för Tradera, i svensk tid, och "sedan i går" jämför med gårdagen.

import { test } from "node:test";
import assert from "node:assert/strict";

const { tolkaStatistiksida, dagarUrProps, statusUrProps, talEfter } = await import("../server/src/integrations/blocket/statistik.js");
const { tolkaWebAnnons } = await import("../server/src/integrations/tradera/saljarsidor.js");
const { blocketIdn, igar, medDagspunkt, summaTradera, traderaIdn } = await import("../server/src/kanalStatistik.js");
import type { ConditionJob } from "../server/src/types.js";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");

/** Statistiksidans text, ordagrant ur innerText för annons 26757853 (från tipsrutan och nedåt). */
const SIDTEXT = `Få köparnas uppmärksamhet genom att sänka priset

8 personer har markerat din annons som favorit. Genom att sänka priset kan du öka dina chanser att få dina prylar sålda.

Sänk priset
Din annonsstatistik
Totalt antal klick
80
Kontakter
1
Sparad som favorit
8

Klick per dag

Vanliga klick

Klick från synlighet

Klick från ökad synlighet
0

Klick när annonsen var överst på resultatlistan eller under Utvalt för dig

Mejlnotiser
156

Personer som har fått ett bevakningsmejl om din annons

Pushnotiser
143

Personer som har fått en pushnotis om din annons

Annonsens besökare
60

Personer som har besökt din annons

En gång: 49 personer

Två till fem gånger: 11 personer

Fler än fem gånger: 0 personer`;

/** Attributen som de stod: annonsens läge, tipsen, och histogrammet (nyast först, som Blocket skickar). */
const PROPS = [
  b64({ brand: "BLOCKET", title: "IKEA Ektorp fåtölj i fint skick", price: 1460, state: { type: "ACTIVE", display: "success", label: "Aktiv" } }),
  b64({ tips: [{ type: "price_drop", title: "Få köparnas uppmärksamhet genom att sänka priset" }] }),
  b64({
    histogram: [
      { date: "2026-10-29", views: 2, chat_replies: 0, email_replies: 0, favorited: 8, favorited_change: 0, homepage_clicks: 0, promotion_clicks: 0, pole_position_clicks: 0, recommendation_clicks: 0 },
      { date: "2026-10-24", views: 5, chat_replies: 1, email_replies: 0, favorited: 8, favorited_change: 0, homepage_clicks: 0, promotion_clicks: 0, pole_position_clicks: 0, recommendation_clicks: 0 },
      { date: "2026-09-20", views: 9, chat_replies: 0, email_replies: 0, favorited: 0, favorited_change: 0, homepage_clicks: 0, promotion_clicks: 0, pole_position_clicks: 0, recommendation_clicks: 0 },
    ],
  }),
];

test("Blockets statistiksida: alla tal i sammanfattningen", () => {
  const s = tolkaStatistiksida(SIDTEXT, PROPS);
  assert.ok(s);
  assert.equal(s.status, "Aktiv");
  assert.equal(s.klick, 80);
  assert.equal(s.kontakter, 1);
  assert.equal(s.favoriter, 8, "kortets tal, inte tipsrutans löptext");
  assert.equal(s.klickOkadSynlighet, 0);
  assert.equal(s.mejlnotiser, 156);
  assert.equal(s.pushnotiser, 143);
  assert.equal(s.besokare, 60);
  assert.deepEqual(s.besokFordelning, { enGang: 49, tvaTillFem: 11, flerAnFem: 0 });
});

test("Blockets dagar: ur histogrammet, äldst först, med Blockets alla fält", () => {
  const dagar = dagarUrProps(PROPS);
  assert.deepEqual(dagar.map((d) => d.datum), ["2026-09-20", "2026-10-24", "2026-10-29"]);
  assert.deepEqual(dagar[1], {
    datum: "2026-10-24",
    klick: 5,
    chattsvar: 1,
    mejlsvar: 0,
    favoriter: 8,
    nyaFavoriter: 0,
    klickStartsidan: 0,
    klickMarknadsforing: 0,
    klickTopplacering: 0,
    klickRekommendation: 0,
  });
  assert.equal(statusUrProps(PROPS), "Aktiv");
  assert.deepEqual(dagarUrProps(["inte base64-json", b64({ annat: 1 })]), []);
});

test("en statistiksida utan huvudtalen är ingen avläsning", () => {
  assert.equal(tolkaStatistiksida("Logga in för att fortsätta", []), null);
  assert.equal(tolkaStatistiksida("Totalt antal klick 80 Kontakter 1", PROPS), null);
});

test("tusental med mellanslag eller hårt mellanslag är ett tal", () => {
  assert.equal(talEfter("Totalt antal klick 1 234 Kontakter", /Totalt antal klick/), 1234);
  assert.equal(talEfter("Mejlnotiser\n12 560\nPersoner", /Mejlnotiser/), 12560);
  assert.equal(talEfter("Kontakter 1 Sparad", /Kontakter/), 1);
});

test("Traderas säljarlista: visningar, bevakare och läge ur webbklientens JSON", () => {
  // En post som den stod i /api/webclient/my/seller/listings, kortad.
  const a = tolkaWebAnnons({
    itemId: 752969544,
    isActive: true,
    activityType: "Active",
    listing: { itemType: "PureBin", endDate: "2026-11-28T12:09:30.7956906Z", ownReference: "1a3f5d99-75ed-4294-83d7-237ce6b596c7" },
    bidInformation: { bidCount: 0 },
    currentPrice: 1070,
    itemUrl: "/item/302538/752969544/brun-laderfatolj-fran-mio",
    wishlistCount: 0,
    viewsCount: 107,
  });
  assert.deepEqual(a, {
    itemId: 752969544,
    ownReference: "1a3f5d99-75ed-4294-83d7-237ce6b596c7",
    aktiv: true,
    status: "Active",
    visningar: 107,
    bevakare: 0,
    bud: 0,
    prisSek: 1070,
    slutar: "2026-11-28T12:09:30.7956906Z",
    typ: "PureBin",
    url: "https://www.tradera.com/item/302538/752969544/brun-laderfatolj-fran-mio",
  });
  assert.equal(tolkaWebAnnons({ listing: {} }), null, "utan id finns inget att knyta siffrorna till");
});

test("rätt annonser räknas: den aktuella och de kvarlämnade, aldrig en nedtagen", () => {
  const job = {
    id: "j1",
    tradera: { status: "published", itemId: 111 },
    blocket: { status: "published", dryRun: false, url: "https://www.blocket.se/26757853" },
    kvarlamnadeAnnonser: [
      { kanal: "tradera", itemId: 99, url: null, nedtagenAt: null },
      { kanal: "tradera", itemId: 98, url: null, nedtagenAt: "2026-10-20T10:00:00Z" },
      { kanal: "blocket", itemId: null, url: "https://www.blocket.se/recommerce/forsale/item/21288561", nedtagenAt: null },
    ],
  } as unknown as ConditionJob;
  assert.deepEqual(traderaIdn(job), [
    { itemId: 111, aktuell: true },
    { itemId: 99, aktuell: false },
  ]);
  assert.deepEqual(blocketIdn(job).map((b) => [b.adId, b.aktuell]), [
    ["26757853", true],
    ["21288561", false],
  ]);
  const torr = { id: "j2", blocket: { status: "published", dryRun: true, url: "https://www.blocket.se/26757853" } } as unknown as ConditionJob;
  assert.deepEqual(blocketIdn(torr), [], "en torrkörning har ingen annons");
});

const summa = (visningar: number) => ({ visningar, bevakare: 0, bud: 0 });

test("Tradera: en punkt per dag i svensk tid, och historiken kapas", () => {
  let h = medDagspunkt([], summa(1), "2026-10-28T08:00:00Z");
  h = medDagspunkt(h, summa(5), "2026-10-28T20:00:00Z");
  assert.equal(h.length, 1);
  assert.equal(h[0].visningar, 5, "dagens senaste avläsning gäller");
  h = medDagspunkt(h, summa(6), "2026-10-28T23:30:00Z");
  assert.equal(h.length, 2, "23:30 UTC är redan nästa dag i Stockholm");
  let lang = medDagspunkt([], summa(0), "2026-09-01T10:00:00Z", 30);
  for (let d = 1; d < 40; d++) lang = medDagspunkt(lang, summa(d), new Date(Date.UTC(2026, 8, 1 + d, 10)).toISOString(), 30);
  assert.equal(lang.length, 30);
});

test("sedan i går jämför med gårdagens sista punkt, och finns inte för en ny annons", () => {
  let h = medDagspunkt([], summa(10), "2026-10-27T10:00:00Z");
  h = medDagspunkt(h, summa(20), "2026-10-28T19:00:00Z");
  h = medDagspunkt(h, summa(26), "2026-10-29T09:00:00Z");
  assert.equal(igar(h, new Date("2026-10-29T12:00:00Z"))?.visningar, 20);
  assert.equal(igar(medDagspunkt([], summa(3), "2026-10-29T09:00:00Z"), new Date("2026-10-29T12:00:00Z")), null);
});

test("summan över annonserna", () => {
  const a = { visningar: 107, bevakare: 1, bud: 0 } as never;
  const b = { visningar: 12, bevakare: 2, bud: 3 } as never;
  assert.deepEqual(summaTradera([a, b]), { visningar: 119, bevakare: 3, bud: 3 });
});
