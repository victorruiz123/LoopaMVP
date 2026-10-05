// ─── Övrigt med flit, eller Övrigt för att vi inte vet ───────────────────────
//
// En Chilli-spegel kunde inte läggas ut: "Fyll i kategori". Spegeln HADE en kategori — Övrigt, som
// är butikens hylla för speglar — men kontrollen räknade varje Övrigt som saknad.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCategorySlug, resolveCategorySlug } from "../server/src/butik/catalog.js";

test("spegel, matta och tavla känns igen och hamnar i Övrigt", () => {
  for (const ord of ["Spegel", "Stor silvrig väggspegel från Chilli", "Matta i ull", "Tavla med guldram"]) {
    assert.equal(matchCategorySlug({ title: ord }), "ovrigt", ord);
  }
});

test("ett modellnamn utan möbelord känns inte igen, men får ändå Övrigt som reserv", () => {
  assert.equal(matchCategorySlug({ title: "NORDVIKEN" }), null);
  assert.equal(resolveCategorySlug({ title: "NORDVIKEN" }), "ovrigt");
});
