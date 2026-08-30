// ─── publish.ts: annonstexten som går upp på Tradera ─────────────────────────
//
// Texten är det enda av Loopas arbete en KÖPARE någonsin ser. Den ska säga tre saker rakt ut — att
// annonsen är skriven av Loopa, vad AI:n hittade, och vilket skick den satte — och bära det en
// möbelannons behöver för att inte kräva en fråga i meddelandefunktionen: mått, specifikationer,
// varje skada och leveranssättet. Sist Loopa-ID:t, som är köparens väg till det publika kortet.
//
// Testet finns för att en annons som ligger uppe INTE går att rätta i efterhand utan att röras för
// hand, och för att bortfallet är tyst: en utelämnad skada ser ut som en felfri möbel.
//
// Publiceringen — anropet mot Tradera — testas inte här. Det är ett nätverksanrop; TEXTEN är vår.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDescription } from "../server/src/integrations/tradera/publish.js";
import { SHIPPING_INCLUDED_SEK, traderaPriceWithShipping } from "../server/src/integrations/tradera/shipping.js";
import { DEFAULT_WEEKLY_DROP, ladderRungs } from "../server/src/priceLadder.js";
import { publicCardFor } from "../server/src/publicCard.js";
import { loopaIdFor } from "../server/src/loopaId.js";
import type { ConditionJob, Damage, GeneratedListing } from "../server/src/types.js";

const JOB_ID = "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

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
    { key: "width", label: "Bredd", value: "180 cm", sourceUrl: "https://www.ikea.com/se/sv/p/stockholm/" },
    { key: "depth", label: "Djup", value: "59 cm", sourceUrl: null },
    { key: "material", label: "Material", value: "Valnötsfaner & stål", sourceUrl: null },
  ],
  pricing: {
    retailPriceSek: 4995,
    suggestedPriceSek: 2400,
    priceRangeMinSek: 2000,
    priceRangeMaxSek: 2800,
    rationale: null,
  },
  listing: {
    title: "IKEA STOCKHOLM soffbord i valnöt",
    description: "Ett soffbord ur IKEA:s STOCKHOLM-serie.",
    conditionText: "Använt men helt.",
  },
  sources: [{ title: "ikea.com", url: "https://www.ikea.com/se/sv/p/stockholm/", qualityTier: 1 }],
  status: "full",
};

function job(p: { damages?: Damage[]; attributes?: GeneratedListing["attributes"] } = {}): ConditionJob {
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
      listing: {
        status: "ok",
        unavailableReason: null,
        result: { ...card, attributes: p.attributes ?? card.attributes },
        latencyMs: 1200,
      },
      coverage: "INSPECTED_DAMAGE",
      coverageNote: null,
      grade: {
        grade: "B",
        canonicalCondition: "Mycket bra skick",
        label: "Gott begagnat skick",
        rationale: "Ett par ytliga repor, inget som påverkar funktionen.",
        reasons: [],
      },
      damages: p.damages ?? [dmg()],
      overallCondition: null,
      images: [
        { id: "img_0", viewLabel: "Framifrån", source: "video", width: 1280, height: 720, path: "img_0.jpg", capturedAt: "2026-08-29T09:59:00.000Z" },
        { id: "img_1", viewLabel: "Höger sida", source: "video", width: 1280, height: 720, path: "img_1.jpg", capturedAt: "2026-08-29T09:59:10.000Z" },
      ],
      coverImageId: "img_0",
      productImage: null,
      modelUsed: "test",
      tokensUsed: 0,
      costUsd: 0,
      geminiCallCount: 0,
      latencyMs: 0,
    },
  };
}

test("annonsen säger att den är skapad av Loopa, och att det är en AI som tittat", () => {
  const html = buildDescription(job());
  assert.match(html, /Den här annonsen är skapad av Loopa/);
  assert.match(html, /Loopas AI har gått igenom 2 vyer av möbeln/);
});

test("skicket står med både betygets etikett och Traderas skickord", () => {
  const html = buildDescription(job());
  assert.match(html, /satt skicket <strong>Gott begagnat skick<\/strong> \(Mycket bra skick\)/);
  assert.match(html, /Skick: Gott begagnat skick — Mycket bra skick/);
  assert.match(html, /Ett par ytliga repor/, "motiveringen ska följa med, inte bara betyget");
});

test("annonsgeneratorns egen skicktext hålls utanför — den har inte sett besiktningen", () => {
  // Generatorn skriver sin conditionText ur bilderna ensamma och påstår med jämna mellanrum "utan
  // synliga skador" på en möbel där besiktningen räknat upp sex. Två skickpåståenden som säger emot
  // varandra i samma annons är värre än ett magert.
  const html = buildDescription(job());
  assert.doesNotMatch(html, /Använt men helt/);
});

test("varje skada står utskriven, numrerad som på annonsen", () => {
  const html = buildDescription(
    job({ damages: [dmg({ id: "a" }), dmg({ id: "b", type: "stain", part: "benet", description: "En fläck." })] }),
  );
  assert.match(html, /AI:n hittade 2 skador/);
  assert.match(html, /<ol>/, "numrerad lista — samma nummer som nålarna på kortet");
  assert.match(html, /Repa på bordsskiva \(vänstra hörnet\) — måttlig\. En repa på cirka 4 cm\./);
  assert.match(html, /Fläck på benet/);
});

test("en skada säljaren avvisat följer inte med till annonsen", () => {
  const html = buildDescription(
    job({ damages: [dmg({ id: "a" }), dmg({ id: "b", sellerAction: "rejected", description: "Avvisad av säljaren." })] }),
  );
  assert.match(html, /hittat 1 synlig skada/);
  assert.match(html, /AI:n hittade 1 skada:/);
  assert.doesNotMatch(html, /Avvisad av säljaren/);
});

test("noll skador sägs som noll skador, inte genom att listan uteblir", () => {
  const html = buildDescription(job({ damages: [] }));
  assert.match(html, /inte hittat någon synlig skada/);
  assert.match(html, /AI:n hittade inga synliga skador/);
});

test("måtten står för sig, före övriga specifikationer", () => {
  const html = buildDescription(job());
  const matt = html.indexOf("<strong>Mått</strong>");
  const spec = html.indexOf("<strong>Specifikationer</strong>");
  assert.ok(matt > -1 && spec > matt, "måtten ska ligga före övriga specifikationer");
  assert.match(html, /Bredd: 180 cm/);
  assert.match(html, /Djup: 59 cm/);
  assert.match(html.slice(spec), /Material: Valnötsfaner &amp; stål/, "material är inte ett mått");
});

test("saknade mått sägs rakt ut i stället för att rubriken tyst uteblir", () => {
  const html = buildDescription(job({ attributes: [] }));
  assert.match(html, /Måtten kunde inte beläggas mot någon källa/);
});

// Leveransen är den enda uppgiften i texten som inte kommer ur besiktningen utan ur affären: köparen
// betalar inget extra, och en budfirma kör hem möbeln efter köpet. Faller det bort ser annonsen ut
// som vilken avhämtningsannons som helst, och köparen antar att de ska köra själva.
test("leveransen säger både att den ingår och vad som händer efter köpet", () => {
  const html = buildDescription(job());
  assert.match(html, /Leverans endast — frakt ingår\. Boka tid efter köp\./);
  assert.match(html, new RegExp(`Hemleveransen kostar ${SHIPPING_INCLUDED_SEK} kr och är redan inräknad`));
  assert.match(html, /ingenting tillkommer i kassan/);
  assert.match(html, /budfirma kör möbeln hem till din dörr/);
  assert.match(html, /leveranstid via SMS/);
  assert.match(html, /Avhämtning erbjuds inte/);
  assert.doesNotMatch(html, /Hämtas hos säljaren/);
});

test("Loopa-ID:t står i annonsen, med vad det går att göra med det", () => {
  const html = buildDescription(job());
  assert.match(html, new RegExp(`Loopa-ID: ${loopaIdFor(JOB_ID)}`));
  assert.match(html, /Varje annons hos Loopa är publik/);
  assert.match(html, /Sök på Loopa-ID:t/);
});

test("adressen till kortet skrivs ut bara när servern vet vilken den är", () => {
  const before = process.env.LOOPA_PUBLIC_URL;
  delete process.env.LOOPA_PUBLIC_URL;
  assert.doesNotMatch(buildDescription(job()), /https?:\/\/[^ ]*\/c\//);
  process.env.LOOPA_PUBLIC_URL = "https://app.loopa.nu/";
  assert.match(buildDescription(job()), new RegExp(`https://app.loopa.nu/c/${loopaIdFor(JOB_ID)}`));
  if (before === undefined) delete process.env.LOOPA_PUBLIC_URL;
  else process.env.LOOPA_PUBLIC_URL = before;
});

test("texten är HTML, och säljarens tecken kan inte bryta ut ur den", () => {
  const html = buildDescription(job({ damages: [dmg({ description: '<script>alert("x")</script> & mer' })] }));
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

// ─── Hemleveransen ───────────────────────────────────────────────────────────
//
// De 600 kronorna ligger i annonspriset, inte i Traderas fraktfält, och de får ALDRIG följa med ner
// när prisstegen sänker. Går de med kostar felet 600 kr per leverans i verkliga pengar, samtidigt som
// annonstexten fortsätter påstå att beloppet är inräknat. Ingen av dem syns i något gränssnitt.

test("annonspriset är möbeln plus frakten", () => {
  assert.equal(traderaPriceWithShipping(2400), 2400 + SHIPPING_INCLUDED_SEK);
  assert.equal(SHIPPING_INCLUDED_SEK, 600);
  assert.equal(traderaPriceWithShipping(2399.6), 2400 + SHIPPING_INCLUDED_SEK, "öretal avrundas, som hos Tradera");
});

test("den veckovisa sänkningen tar bara av möbeln — frakten står stilla hela vägen ner", () => {
  const rungs = ladderRungs(2400, 900, DEFAULT_WEEKLY_DROP);
  assert.ok(rungs.length > 3, "spannet ska ha flera steg att gå igenom");
  for (const rung of rungs) {
    assert.equal(traderaPriceWithShipping(rung) - rung, SHIPPING_INCLUDED_SEK, `steget ${rung} tappade frakt`);
  }
  // Golvet i annonsen är säljarens golv plus frakten — aldrig lägre.
  assert.equal(traderaPriceWithShipping(rungs.at(-1)!), 900 + SHIPPING_INCLUDED_SEK);
});

// ─── Det publika kortet ──────────────────────────────────────────────────────

test("det publika kortet bär skicket och skadorna — men aldrig bildrutorna eller ägaren", () => {
  const withOwner: ConditionJob = { ...job(), ownerId: "user-42" };
  const publicCard = publicCardFor(withOwner)!;
  assert.equal(publicCard.loopaId, loopaIdFor(JOB_ID));
  assert.equal(publicCard.grade?.grade, "B");
  assert.equal(publicCard.damages.length, 1);
  const serialized = JSON.stringify(publicCard);
  assert.doesNotMatch(serialized, /user-42/, "ägaren får aldrig följa med ut");
  assert.doesNotMatch(serialized, /"images"/, "säljarens egna bildrutor är inte publika");
  assert.doesNotMatch(serialized, /"evidence"/, "bevisbilderna är inte publika");
});

test("ett jobb utan färdig annons är inget publikt kort", () => {
  const unfinished = job();
  unfinished.result!.listing = { status: "unavailable", unavailableReason: "Ingen träff.", result: null, latencyMs: 10 };
  assert.equal(publicCardFor(unfinished), null);
});
