// ─── Säljarens rättade mått överlever pipelinen ──────────────────────────────
//
// Måttsteget visas så fort första annonsen finns, och där kan säljaren rätta måtten. Pipelinen
// skriver därefter om annonsen hel — ett omförsök med bättre mått, och sista skrivningen när
// besiktningen blir klar. Rättelsen ska stå kvar genom varje sådan omskrivning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { behallSaljarensRattelser } from "../server/src/pipeline/identify.js";
import type { GeneratedListing, ListingAttribute, ListingResult } from "../server/src/types.js";

const rad = (key: string, label: string, value: string, extra: Partial<ListingAttribute> = {}): ListingAttribute => ({
  key,
  label,
  value,
  sourceUrl: null,
  estimated: false,
  ...extra,
});

const annons = (attributes: ListingAttribute[]): ListingResult =>
  ({ status: "ok", unavailableReason: null, result: { attributes } as unknown as GeneratedListing }) as ListingResult;

test("en rättad rad ersätter generatorns på samma plats", () => {
  const nu = annons([rad("bredd", "Bredd", "92 cm", { sellerEdited: true })]);
  const ny = annons([
    rad("bredd", "Bredd", "80 cm", { sourceUrl: "https://ikea.com" }),
    rad("hojd", "Höjd", "100 cm"),
  ]);
  const ut = behallSaljarensRattelser(ny, nu).result!.attributes;
  assert.deepEqual(
    ut.map((a) => [a.label, a.value, !!a.sellerEdited]),
    [
      ["Bredd", "92 cm", true],
      ["Höjd", "100 cm", false],
    ],
  );
});

test("matchar på etikett när nyckeln skiljer sig", () => {
  const nu = annons([rad("width", "bredd", "92 cm", { sellerEdited: true })]);
  const ny = annons([rad("bredd", "Bredd", "80 cm")]);
  assert.equal(behallSaljarensRattelser(ny, nu).result!.attributes[0].value, "92 cm");
});

test("en rättad rad som den nya annonsen saknar läggs sist", () => {
  const nu = annons([rad("sitthojd", "Sitthöjd", "45 cm", { sellerEdited: true })]);
  const ny = annons([rad("bredd", "Bredd", "80 cm")]);
  assert.deepEqual(
    behallSaljarensRattelser(ny, nu).result!.attributes.map((a) => a.label),
    ["Bredd", "Sitthöjd"],
  );
});

test("utan rättelser lämnas den nya annonsen orörd", () => {
  const ny = annons([rad("bredd", "Bredd", "80 cm")]);
  assert.equal(behallSaljarensRattelser(ny, annons([rad("bredd", "Bredd", "70 cm")])), ny);
  assert.equal(behallSaljarensRattelser(ny, null), ny);
});
