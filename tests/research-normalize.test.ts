// ─── Produktforskningen: från modellens JSON till rader annonsen kan visa ──────────────────────────
//
// Måtten är ÖPPNA: schemat låter modellen rapportera vilken måttyp som helst, och normaliseringen
// måste släppa igenom det okända lika väl som den känner igen det kända. Testerna nedan vaktar båda
// riktningarna: kända typer får stabila nycklar som resten av appen redan läser, okända typer får
// finnas, och det som inte är ett mått — ett tal utan rimlig storlek, ett "okänt" som material —
// stannar utanför.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSources,
  canonicalType,
  cleanUrl,
  dedupeDimensions,
  normalizeDimension,
  normalizeMaterial,
  sortDimensions,
  sourceTier,
  toCm,
} from "../server/src/research/normalize.js";

test("kända typer får appens nycklar och svenska etiketter", () => {
  const d = normalizeDimension({ type: "seat_height", label: "Seat height", value: 46, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: "https://www.ikea.com/se/sv/p/x/", quote: null });
  assert.ok(d);
  assert.equal(d.key, "sitthojd");
  assert.equal(d.label, "Sitthöjd");
  assert.equal(d.display, "46 cm");
});

test("en okänd måttyp går igenom med modellens etikett", () => {
  const d = normalizeDimension({ type: "lampshade_rim_width", label: "Skärmkantens bredd", value: 3.5, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: "https://a.se/p", quote: null });
  assert.ok(d);
  assert.equal(d.type, "lampshade_rim_width");
  assert.equal(d.label, "Skärmkantens bredd");
  assert.equal(d.key, "skarmkantens_bredd");
  assert.equal(d.display, "3,5 cm");
});

test("etiketten avgör typen när modellen skrev en lös variant", () => {
  assert.equal(canonicalType("width", null), "overall_width");
  assert.equal(canonicalType("Total height", null), "overall_height");
  assert.equal(canonicalType(null, "Sitthöjd"), "seat_height");
  assert.equal(canonicalType(null, "Ø"), "diameter");
  assert.equal(canonicalType("net_weight", null), "weight");
});

test("imperial och millimeter normaliseras till centimeter, råvärdet bevaras", () => {
  assert.equal(toCm(10, "in"), 25.4);
  const mm = normalizeDimension({ type: "overall_width", label: "Bredd", value: 420, valueMax: null, unit: "mm", appliesTo: null, sourceUrl: "https://a.se/p", quote: null });
  assert.equal(mm?.value, 42);
  assert.equal(mm?.display, "42 cm");
  assert.equal(mm?.rawValue, "420 mm");
  const inch = normalizeDimension({ type: "overall_width", label: "Width", value: 16.5, valueMax: null, unit: "in", appliesTo: null, sourceUrl: "https://a.com/p", quote: null });
  assert.equal(inch?.value, 41.9);
});

test("ett spann skrivs som spann", () => {
  const d = normalizeDimension({ type: "overall_height", label: "Höjd", value: 65, valueMax: 85, unit: "cm", appliesTo: null, sourceUrl: "https://a.se/p", quote: null });
  assert.equal(d?.display, "65–85 cm");
});

test("vikt är vikt, inte längd", () => {
  const d = normalizeDimension({ type: "weight", label: "Vikt", value: 6200, valueMax: null, unit: "g", appliesTo: null, sourceUrl: "https://a.se/p", quote: null });
  assert.equal(d?.unit, "kg");
  assert.equal(d?.display, "6,2 kg");
});

test("orimliga tal och tal utan enhet kastas", () => {
  assert.equal(normalizeDimension({ type: "overall_width", label: "Bredd", value: 4200, unit: "cm" }), null);
  assert.equal(normalizeDimension({ type: "overall_width", label: "Bredd", value: "42", unit: "cm" }), null);
  assert.equal(normalizeDimension({ type: "overall_width", label: "Bredd", value: 0.1, unit: "cm" }), null);
});

test("material per komponent — och 'okänt' är inget material", () => {
  const m = normalizeMaterial({ component: "stomme", material: "Massiv björk.", detail: "klarlack", appliesTo: null, sourceUrl: "https://a.se/p", quote: null });
  assert.equal(m?.component, "Stomme");
  assert.equal(m?.material, "Massiv björk");
  assert.equal(m?.detail, "klarlack");
  assert.equal(normalizeMaterial({ component: "Klädsel", material: "okänt" }), null);
  assert.equal(normalizeMaterial({ component: "", material: "Ull" }), null);
});

test("samma mått två gånger: bäst belagda vinner, olika varianter behålls", () => {
  const base = { type: "overall_width", key: "bredd", label: "Bredd", valueMax: null, unit: "cm" as const, rawValue: "", appliesTo: null, verified: false, quote: null };
  const a = { ...base, value: 42, display: "42 cm", sourceUrl: "https://retailer.se/p", verification: "cited" as const };
  const b = { ...base, value: 42, display: "42 cm", sourceUrl: "https://www.ikea.com/se/sv/p/", verification: "page_confirmed" as const, verified: true };
  const c = { ...base, value: 60, display: "60 cm", sourceUrl: "https://www.ikea.com/se/sv/p/", verification: "cited" as const, appliesTo: "bred" };
  const out = dedupeDimensions([a, b, c], (url) => (url ? sourceTier(url, "IKEA") : 4));
  assert.equal(out.length, 2);
  assert.equal(out[0].verification, "page_confirmed");
  assert.equal(out[1].appliesTo, "bred");
});

test("yttermåtten först, sedan sittmåtten, sedan resten i modellens ordning", () => {
  const mk = (type: string) => normalizeDimension({ type, label: type, value: 10, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: "https://a.se/p", quote: null })!;
  const out = sortDimensions([mk("leg_height"), mk("seat_height"), mk("overall_height"), mk("cable_length"), mk("overall_width")]);
  assert.deepEqual(
    out.map((d) => d.type),
    ["overall_width", "overall_height", "seat_height", "leg_height", "cable_length"],
  );
});

test("källor: tillverkare känns igen på värden, omdirigeringsadresser sållas bort, dubbletter slås ihop", () => {
  assert.equal(sourceTier("https://www.ikea.com/se/sv/p/norrnas-stol/", "IKEA"), 1);
  assert.equal(sourceTier("https://www.stringfurniture.com/x", "String"), 1);
  assert.equal(sourceTier("https://www.svenssons.se/x", "Swedese"), 2);
  assert.equal(sourceTier("https://blocket.se/x", "IKEA"), 3);
  assert.equal(cleanUrl("https://a.se/p)."), "https://a.se/p");
  assert.equal(cleanUrl("not a url"), null);
  const s = buildSources(
    [
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "ikea.com" },
      { url: "https://www.ikea.com/se/sv/p/x/", title: null, retrieved: true },
      { url: "https://www.ikea.com/se/sv/p/x/", title: "NORRNÄS stol", cited: true },
      { url: "https://blog.example.com/post", title: "Blogg" },
    ],
    "IKEA",
  );
  assert.equal(s.length, 2);
  assert.equal(s[0].url, "https://www.ikea.com/se/sv/p/x/");
  assert.equal(s[0].title, "NORRNÄS stol");
  assert.equal(s[0].retrieved, true);
  assert.equal(s[0].cited, true);
  assert.equal(s[0].tier, 1);
});
