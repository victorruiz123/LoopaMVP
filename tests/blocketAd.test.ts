// ─── blocket.ts: annonsen säljaren för över för hand ─────────────────────────
//
// Blocket har inget API. Allt som händer är att säljaren kopierar fyra fält och laddar upp bilderna
// själv — och just därför måste fälten vara FÄRDIGA. Ett stycke HTML i beskrivningen, ett pris med
// frakt inbakad eller ett leveranslöfte Loopa inte kan hålla i säljarens namn syns inte här utan i
// den publicerade annonsen, efter att den lämnat oss.
//
// Att texten säger samma sak om möbeln som Tradera-annonsen testas där (traderaListing.test.ts).
// Här prövas det som skiljer de två kanalerna åt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { blocketAdFor } from "../server/src/integrations/blocket.js";
import { traderaPriceWithShipping } from "../server/src/integrations/tradera/shipping.js";
import { loopaIdFor } from "../server/src/loopaId.js";
import type { ConditionJob, Damage, GeneratedListing } from "../server/src/types.js";

const JOB_ID = "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";
const ITEM_PRICE = 2400;

function dmg(p: Partial<Damage> = {}): Damage {
  return {
    id: p.id ?? "d1",
    type: p.type ?? "scratch",
    part: p.part ?? "bordsskiva",
    semanticLocation: p.semanticLocation ?? "vänstra hörnet",
    severity: p.severity ?? "S2",
    impact: p.impact ?? "cosmetic",
    description: p.description ?? "En repa på cirka 4 cm.",
    confidence: 90,
    verification: "CONFIRMED",
    verificationReason: "",
    evidence: [],
    recaptureRequested: false,
    sellerAction: p.sellerAction ?? null,
    sellerAdded: false,
  };
}

const card: GeneratedListing = {
  identity: {
    brand: "IKEA",
    exactProduct: "STOCKHOLM",
    variant: "soffbord, valnöt",
    category: "soffbord",
    confidence: "high",
    uncertain: false,
    uncertaintyNote: null,
  },
  attributes: [
    { key: "width", label: "Bredd", value: "180 cm", sourceUrl: null },
    { key: "material", label: "Material", value: "Valnötsfaner & stål", sourceUrl: null },
  ],
  pricing: {
    retailPriceSek: 4995,
    suggestedPriceSek: ITEM_PRICE,
    priceRangeMinSek: 2000,
    priceRangeMaxSek: 2800,
    rationale: null,
  },
  listing: {
    title: "IKEA STOCKHOLM soffbord i valnöt",
    description: "Ett soffbord ur IKEA:s STOCKHOLM-serie.",
    conditionText: "Använt men helt.",
  },
  sources: [],
  status: "full",
};

function job(p: { damages?: Damage[] } = {}): ConditionJob {
  return {
    id: JOB_ID,
    createdAt: "2026-08-29T10:00:00.000Z",
    progress: { stage: "done", message: "" },
    error: null,
    productContext: null,
    identity: { brand: "IKEA", model: "STOCKHOLM" },
    result: {
      jobId: JOB_ID,
      createdAt: "2026-08-29T10:00:00.000Z",
      identity: { brand: "IKEA", model: "STOCKHOLM" },
      price: null,
      reviewPending: false,
      reviewed: false,
      listing: { status: "ok", unavailableReason: null, result: card, latencyMs: 1200 },
      coverage: "INSPECTED_DAMAGE",
      coverageNote: null,
      grade: {
        grade: "B",
        canonicalCondition: "Mycket bra skick",
        label: "Gott begagnat skick",
        rationale: "Ett par ytliga repor.",
        reasons: [],
      },
      damages: p.damages ?? [dmg()],
      overallCondition: null,
      images: [
        { id: "img_0", viewLabel: "Framifrån", source: "video", width: 1280, height: 720, path: "img_0.jpg", capturedAt: "2026-08-29T09:59:00.000Z" },
        { id: "img_1", viewLabel: "Höger sida", source: "video", width: 1280, height: 720, path: "img_1.jpg", capturedAt: "2026-08-29T09:59:10.000Z" },
      ],
      // Andra bildrutan är omslaget här, just för att ordningen ska gå att skilja från filmningens.
      coverImageId: "img_1",
      productImage: null,
      modelUsed: "test",
      tokensUsed: 0,
      costUsd: 0,
      geminiCallCount: 0,
      latencyMs: 0,
    },
  };
}

test("beskrivningen är ren text — Blockets fält renderar varken HTML eller markdown", async () => {
  const { ad } = await blocketAdFor(job());
  assert.ok(ad);
  assert.doesNotMatch(ad.description, /<\/?(p|strong|ol|ul|li|br)\b/i, "ingen HTML får följa med");
  assert.doesNotMatch(ad.description, /\*\*/, "ingen markdown heller — fältet renderar den inte");
  assert.match(ad.description, /^Den här annonsen är skapad av Loopa\./);
});

test("skadorna står numrerade, med samma nummer som på annonsen", async () => {
  const { ad } = await blocketAdFor(
    job({ damages: [dmg({ id: "a" }), dmg({ id: "b", type: "stain", part: "benet", description: "En fläck." })] }),
  );
  assert.match(ad!.description, /AI:n hittade 2 skador:/);
  assert.match(ad!.description, /\n1\. Repa på bordsskiva \(vänstra hörnet\) — måttlig\. En repa på cirka 4 cm\./);
  assert.match(ad!.description, /\n2\. Fläck på benet/);
});

test("specifikationerna står som punkter, med säljarens tecken orörda", async () => {
  const { ad } = await blocketAdFor(job());
  assert.match(ad!.description, /• Bredd: 180 cm/);
  // & escapas till &amp; på väg in i Traderas HTML. I ren text vore det ett fel som klistras in.
  assert.match(ad!.description, /• Material: Valnötsfaner & stål/);
  assert.doesNotMatch(ad!.description, /&amp;/);
});

// Leveransen är Loopas löfte på Loopas eget Tradera-konto: Loopa säljer, Loopa bokar budfirman. På
// Blocket säljer säljaren i eget namn, och ett stycke om hemleverans hade blivit deras att hålla.
test("leveransstycket följer inte med till Blocket", async () => {
  const { ad } = await blocketAdFor(job());
  assert.doesNotMatch(ad!.description, /Hemleveransen kostar/);
  assert.doesNotMatch(ad!.description, /frakt ingår/i);
  assert.doesNotMatch(ad!.description, /Avhämtning erbjuds inte/);
});

test("priset är möbelns eget — de 600 kronorna hör till Traderas annons, inte till den här", async () => {
  const { ad } = await blocketAdFor(job());
  assert.equal(ad!.price, ITEM_PRICE);
  assert.notEqual(ad!.price, traderaPriceWithShipping(ITEM_PRICE));
  assert.equal(ad!.priceSource, "listing");
});

test("bilderna kommer i annonsens ordning, omslaget först", async () => {
  const { ad } = await blocketAdFor(job());
  assert.deepEqual(
    ad!.images.map((i) => i.id),
    ["img_1", "img_0"],
    "omslaget ska ligga först — på Blocket blir första uppladdade bilden annonsens ansikte",
  );
});

test("Loopa-ID:t står i beskrivningen, och adressen till den publika annonsen när servern vet den", async () => {
  const before = process.env.LOOPA_PUBLIC_URL;
  process.env.LOOPA_PUBLIC_URL = "https://app.loopa.nu/";
  const { ad } = await blocketAdFor(job());
  assert.equal(ad!.loopaId, loopaIdFor(JOB_ID));
  assert.match(ad!.description, new RegExp(`Loopa-ID: ${loopaIdFor(JOB_ID)}`));
  assert.equal(ad!.publicUrl, `https://app.loopa.nu/c/${loopaIdFor(JOB_ID)}`);
  assert.match(ad!.description, new RegExp(`https://app.loopa.nu/c/${loopaIdFor(JOB_ID)}`));
  if (before === undefined) delete process.env.LOOPA_PUBLIC_URL;
  else process.env.LOOPA_PUBLIC_URL = before;
});

test("rubriken är annonsens egen, färdig att klistra in", async () => {
  const { ad } = await blocketAdFor(job());
  assert.equal(ad!.title, "IKEA STOCKHOLM soffbord i valnöt");
});

// Samma tre krav som Tradera-publiceringen ställer. Ett tomt fält är sämre än ett besked om varför.
test("ett jobb utan färdig annons går inte att föra över, och säger varför", async () => {
  const unfinished = job();
  unfinished.result!.listing = { status: "unavailable", unavailableReason: "Ingen träff.", result: null, latencyMs: 10 };
  const state = await blocketAdFor(unfinished);
  assert.equal(state.ad, null);
  assert.match(state.blockedReason ?? "", /kunde inte skapas/);
});

test("utan pris blir det ingen annons — ett pris får inte gissas fram i överlämningen", async () => {
  const priceless = job();
  priceless.result!.listing!.result!.pricing.suggestedPriceSek = null;
  const state = await blocketAdFor(priceless);
  assert.equal(state.ad, null);
  assert.match(state.blockedReason ?? "", /inget pris/);
});
