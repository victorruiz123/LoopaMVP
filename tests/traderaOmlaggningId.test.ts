// ─── Tradera: den nya annonsens id efter en omläggning ───────────────────────
//
// Loopa hittar en publicerad Tradera-annons i säljarlistan på ownReference (jobbets id). Vid en
// omläggning ligger den gamla, avslutade annonsen kvar där med SAMMA referens. Skarpt 2026-10-21
// (barstolen) tog publiceringen den gamla — 756963478 i stället för 756963802 — och jobbet hade då
// pekat på en annons som inte längre fanns, medan den nya låg ute utan att Loopa kunde styra den.
//
// Regeln: det id publiceringen returnerar är en artikel som INTE bar referensen innan.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TRADERA_APP_ID = "1";
process.env.TRADERA_APP_KEY = "k";
process.env.TRADERA_USER_ID = "2";
process.env.TRADERA_USER_TOKEN = "t";

const { publishToTradera } = await import("../server/src/integrations/tradera/tradera.js");

const REF = "job-barstol";
const GAMMAL = { id: 756963478, ownReferences: [REF], itemLink: "https://www.tradera.com/item/1/756963478/x" };
const NY = { id: 756963802, ownReferences: [REF], itemLink: "https://www.tradera.com/item/1/756963802/x" };

function annons() {
  return {
    ownReference: REF,
    title: "Svart IKEA NORDVIKEN barstol (62 cm)",
    description: "<p>Barstol</p>",
    categoryId: 302532,
    price: 270,
    images: [],
    condition: null,
    shippingOptionId: 1,
    mode: "fixed" as const,
  };
}

/** Säljarlistan: den gamla från början, den nya först efter `nyEfter` hämtningar efter commit. */
function attrapp(nyEfter: number) {
  const riktig = globalThis.fetch;
  let committad = false;
  let hamtningarEfterCommit = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const svar = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (u.endsWith("/listings/items") && init?.method === "POST") return svar({ requestId: 99, itemId: 0 });
    if (u.endsWith("/commit")) {
      committad = true;
      return svar(null);
    }
    if (u.includes("/request-results")) return svar([{ requestId: 99, message: null }]);
    if (u.endsWith("/listings/seller-items")) {
      if (committad) hamtningarEfterCommit++;
      // Gamla först i listan, som hos Tradera i dag.
      return svar(committad && hamtningarEfterCommit >= nyEfter ? [GAMMAL, NY] : [GAMMAL]);
    }
    throw new Error(`oväntat anrop: ${init?.method ?? "GET"} ${u}`);
  }) as typeof fetch;
  return () => (globalThis.fetch = riktig);
}

test("omläggning: den nya annonsens id, inte den gamla som bär samma referens", async () => {
  const aterstall = attrapp(1);
  try {
    const r = await publishToTradera(annons());
    assert.equal(r.itemId, NY.id);
    assert.equal(r.url, NY.itemLink);
  } finally {
    aterstall();
  }
});

test("omläggning: väntar på den nya i stället för att ta den gamla medan Tradera behandlar kön", async () => {
  const aterstall = attrapp(2);
  try {
    const r = await publishToTradera(annons());
    assert.equal(r.itemId, NY.id);
  } finally {
    aterstall();
  }
});
