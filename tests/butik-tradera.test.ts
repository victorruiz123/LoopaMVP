// ─── Traderas annonser som butiksvaror ──────────────────────────────────────
//
// XML:en nedan är KOPIERAD ur ett skarpt SearchAdvanced-svar 2026-08-31, inte hittepå: nil-priser,
// http i ItemUrl, skickattributet och de fyra bildformaten ser ut precis så. Testerna går aldrig mot
// nätet — de låser fast tolkningen av ett svar vi redan sett.

import { test } from "node:test";
import assert from "node:assert/strict";
import { itemToProduct } from "../server/src/integrations/tradera/search.js";

/** En ren auktion: inget Köp Nu, stående bud, slutar om några dagar. */
const AUCTION = `<Id>747607260</Id><ShortDescription>Madison 3-sits soffa</ShortDescription>` +
  `<BuyItNowPrice xsi:nil="true"/><SellerId>5422014</SellerId><SellerAlias>Scoyard</SellerAlias>` +
  `<MaxBid>525</MaxBid><ThumbnailLink>https://img.tradera.net/thumbs/861/a.jpg</ThumbnailLink>` +
  `<EndDate>2099-09-05T20:26:14.404+02:00</EndDate><NextBid>550</NextBid><HasBids>true</HasBids>` +
  `<IsEnded>false</IsEnded><ItemType>Auction</ItemType>` +
  `<ItemUrl>http://www.tradera.com/item/302537/747607260/madison-3-sits-soffa</ItemUrl>` +
  `<CategoryId>302537</CategoryId><BidCount>2</BidCount>` +
  `<ImageLinks><ImageLink><Url>https://img.tradera.net/medium/861/a.jpg</Url><Format>gallery</Format></ImageLink>` +
  `<ImageLink><Url>https://img.tradera.net/thumbs/861/a.jpg</Url><Format>thumb</Format></ImageLink></ImageLinks>` +
  `<AttributeValues><TermAttributeValues><TermAttributeValue><Id>121</Id><Name>condition</Name>` +
  `<Values><string>Gott skick</string></Values></TermAttributeValue></TermAttributeValues></AttributeValues>`;

test("en auktion blir en vara med bud, antal bud och sluttid", () => {
  const p = itemToProduct(AUCTION, ["IKEA"])!;
  assert.ok(p);
  assert.equal(p.id, "tradera:747607260");
  assert.equal(p.source, "tradera");
  assert.equal(p.title, "Madison 3-sits soffa");
  assert.equal(p.auction!.isAuction, true);
  assert.equal(p.auction!.currentBidSek, 525);
  assert.equal(p.auction!.bidCount, 2);
  assert.equal(p.auction!.buyNowSek, null);
  assert.equal(p.priceSek, 525, "utan Köp Nu är det stående budet priset som visas");
});

test("ett saknat Köp Nu-pris blir null, aldrig noll", () => {
  // xsi:nil tolkat som tom sträng blir Number("") === 0, och då står "0 kr" på varenda auktion.
  const p = itemToProduct(AUCTION, [])!;
  assert.equal(p.auction!.buyNowSek, null);
  assert.notEqual(p.priceSek, 0);
});

test("en Tradera-vara får ALDRIG ett Loopa-betyg", () => {
  const p = itemToProduct(AUCTION, [])!;
  assert.equal(p.condition, null, "det är den här raden som gör Loopa-granskad värd något");
  assert.equal(p.sellerCondition, "Gott skick", "säljarens eget ord bärs vidare — som påstående");
  assert.equal(p.homeDeliveryAvailable, false);
  assert.equal(p.returnsAccepted, false);
});

test("länken går till Tradera och uppgraderas till https", () => {
  const p = itemToProduct(AUCTION, [])!;
  assert.equal(p.externalUrl, "https://www.tradera.com/item/302537/747607260/madison-3-sits-soffa");
  assert.equal(p.jobId, null);
});

test("bilden hotlänkas i galleriformat, aldrig nedladdad", () => {
  const p = itemToProduct(AUCTION, [])!;
  assert.equal(p.imageUrl, "https://img.tradera.net/medium/861/a.jpg");
});

test("en avslutad auktion blir aldrig en vara", () => {
  // Två vägar in i samma svar: flaggan, och en sluttid som passerat.
  assert.equal(itemToProduct(AUCTION.replace("<IsEnded>false</IsEnded>", "<IsEnded>true</IsEnded>"), []), null);
  assert.equal(itemToProduct(AUCTION.replace("2099-09-05", "2020-09-05"), []), null, "en cachad post får inte se köpbar ut");
});

test("Traderas kategori styr när den säger något", () => {
  const p = itemToProduct(AUCTION, [])!;
  assert.equal(p.categorySlug, "soffor", "302537 = Vardagsrum > Soffor");
});

test("men Övriga möbler är ingen kategori — då läses rubriken", () => {
  // Mätt: alla stolar och pallar i första hämtningen låg i 160402, Traderas slaskhylla.
  const stol = AUCTION
    .replace("<CategoryId>302537</CategoryId>", "<CategoryId>160402</CategoryId>")
    .replace("Madison 3-sits soffa", "IKEA FROSTA Pall");
  assert.equal(itemToProduct(stol, [])!.categorySlug, "stolar");
});

test("säger varken kategorin eller rubriken något blir det Övrigt", () => {
  const vag = AUCTION
    .replace("<CategoryId>302537</CategoryId>", "<CategoryId>160402</CategoryId>")
    .replace("Madison 3-sits soffa", "Retro grej från 60-talet");
  assert.equal(itemToProduct(vag, [])!.categorySlug, "ovrigt");
});

test("märket känns igen ur rubriken, men bara märken butiken har egna varor av", () => {
  const ikea = AUCTION.replace("Madison 3-sits soffa", "IKEA FROSTA Pall");
  assert.equal(itemToProduct(ikea, ["IKEA", "Swedese"])!.brand, "IKEA");
  assert.equal(itemToProduct(ikea, ["Swedese"])!.brand, null, "utan egna IKEA-varor finns ingen märkessida att peka på");
});

test("måtten är tomma — och det är därför måttfiltret utesluter Tradera", () => {
  const p = itemToProduct(AUCTION, [])!;
  assert.deepEqual(p.dimensions, { widthMm: null, depthMm: null, heightMm: null, seatHeightMm: null, estimated: false });
});

test("en annons utan id eller rubrik kastas i stället för att bli en tom ruta", () => {
  assert.equal(itemToProduct("<ShortDescription>Soffa</ShortDescription>", []), null);
  assert.equal(itemToProduct("<Id>1</Id>", []), null);
});

// ─── Att rutnätet överlever att Tradera inte gör det ────────────────────────
//
// Löftet är att en trasig extern källa ger ett kortare rutnät med en notis, aldrig en trasig sida.
// Det går inte att pröva mot det skarpa API:t, så felet matas in genom sömmen i browse.ts.

import { browse, type TraderaFetchers } from "../server/src/butik/browse.js";
import type { Product } from "../server/src/butik/types.js";

const traderaItem = itemToProduct(AUCTION, [])!;

const fakes = (over: Partial<TraderaFetchers> = {}): TraderaFetchers => ({
  enabled: () => true,
  pool: async () => [traderaItem],
  search: async () => [traderaItem],
  ...over,
});

test("Tradera nere: Loopas varor visas ändå, med notisen satt", async () => {
  const down = fakes({ pool: async () => { throw new Error("ETIMEDOUT"); } });
  const r = await browse({ limit: 96 }, down);
  assert.equal(r.traderaDegraded, true, "notisen ska gå att visa för köparen");
  assert.ok(r.items.length > 0, "rutnätet ska inte vara tomt bara för att någon annans API är det");
  assert.ok(r.items.every((p: Product) => p.source === "loopa"));
});

test("Tradera avstängd är inte samma sak som Tradera nere", async () => {
  // Avstängd är ett beslut och behöver ingen ursäkt; nere är ett fel köparen ska få veta om.
  const off = fakes({ enabled: () => false });
  const r = await browse({ limit: 96 }, off);
  assert.equal(r.traderaDegraded, false);
  assert.ok(r.items.every((p: Product) => p.source === "loopa"));
});

test("filtret Endast Loopa-granskade rör inte Tradera alls", async () => {
  let called = false;
  const spy = fakes({ pool: async () => { called = true; return [traderaItem]; } });
  const r = await browse({ onlyLoopa: true, limit: 96 }, spy);
  assert.equal(called, false, "ett filter som utesluter källan ska inte anropa den");
  assert.ok(r.items.every((p: Product) => p.source === "loopa"));
});

test("båda källorna i samma lista, med Loopa först", async () => {
  const r = await browse({ limit: 96 }, fakes());
  const first = r.items.findIndex((p: Product) => p.source === "tradera");
  const lastLoopa = r.items.map((p: Product) => p.source).lastIndexOf("loopa");
  assert.ok(r.items.some((p: Product) => p.source === "tradera"), "Tradera ska vara med");
  assert.ok(first > lastLoopa, "allt granskat står före allt ogranskat i relevansordning");
});
