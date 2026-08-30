// ─── cardChat.ts: vad kortets chatbot får se ─────────────────────────────────
//
// Boten svarar bara på det som står i kontexten. Det gör `cardContext` till hela gränsen: vad som
// INTE står där kan boten inte säga, och vad som står där fel kommer den att säga fel. Båda halvorna
// testas här, för ingen av dem syns i drift — ett svar som låter rimligt ser likadant ut oavsett om
// underlaget var rätt.
//
// NUMRERINGEN är det som binder ihop chatten med kortet. Skickrapporten numrerar anmärkningarna
// 1..n i listans ordning, och punkterna på renderingen bär samma nummer. Säger boten "anmärkning 2"
// om något annat än rad 2 pekar den läsaren på fel skada — och det är exakt den sortens fel ingen
// upptäcker förrän en köpare står med möbeln framför sig.
//
// TOMMA FÄLT ska stå som tomma. Ett kort utan pris, utan mått eller utan belägg är ett vanligt kort,
// inte ett trasigt, och kontexten måste säga att uppgiften saknas i stället för att utelämna raden —
// utelämnad information är exakt det en språkmodell fyller i själv.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cardContext } from "../server/src/cardChat.js";
import type { PublicCard, PublicDamage } from "../server/src/publicCard.js";

function damage(over: Partial<PublicDamage> = {}): PublicDamage {
  return {
    id: "d1",
    type: "scratch",
    part: "bordsskiva",
    semanticLocation: "främre högra hörnet",
    severity: "S2",
    impact: "cosmetic",
    description: "En repa på ungefär fem centimeter i lacken.",
    ...over,
  };
}

function card(over: Partial<PublicCard> = {}): PublicCard {
  return {
    loopaId: "LP-KC4W-4519",
    createdAt: "2026-08-20T09:00:00.000Z",
    identity: { brand: "String", model: "Plex" },
    card: {
      identity: {
        brand: "String",
        exactProduct: "String Plex hyllsystem",
        variant: null,
        category: "Hylla",
        confidence: "high",
        uncertain: false,
        uncertaintyNote: null,
      },
      attributes: [{ key: "width", label: "Bredd", value: "78 cm", sourceUrl: "https://example.com/plex" }],
      pricing: { retailPriceSek: 4200, suggestedPriceSek: null, priceRangeMinSek: null, priceRangeMaxSek: null, rationale: null },
      listing: { title: "String Plex hyllsystem", description: "Vägghängd hylla i vitlackerad plåt.", conditionText: "Bra skick." },
      sources: [{ title: "Stringfurniture.com", url: "https://example.com/plex" }],
      status: "full",
      missingNotes: [],
    },
    grade: {
      grade: "B",
      canonicalCondition: "Mycket bra skick",
      label: "Gott begagnat skick",
      rationale: "En kosmetisk anmärkning, inget som påverkar funktionen.",
      reasons: [],
    },
    price: { status: "ok", low: 1800, default: 2200, high: 2600, currency: "SEK", damageDeduction: 0.12, unavailableReason: null },
    damages: [damage()],
    imageCount: 6,
    reviewed: false,
    productImage: null,
    tradera: null,
    ...over,
  };
}

test("anmärkningarna numreras som i skickrapporten, med svenska etiketter", () => {
  const text = cardContext(
    card({
      damages: [
        damage({ id: "a", type: "scratch", part: "bordsskiva" }),
        damage({ id: "b", type: "dent", part: "benet", severity: "S3", impact: "structural", description: "En buckla i metallen." }),
      ],
    }),
  );

  assert.match(text, /1\. Repa — bordsskiva/);
  assert.match(text, /2\. Buckla — benet.*stor.*strukturell/);
  assert.match(text, /En buckla i metallen\./);
  assert.match(text, /ANMÄRKNINGAR \(2\)/);
});

test("ett kort utan skador säger det rakt ut", () => {
  const text = cardContext(card({ damages: [] }));
  assert.match(text, /ANMÄRKNINGAR \(0\)/);
  assert.match(text, /hittade inga synliga skador/);
});

test("hur många vyer besiktningen byggde på följer med — det är svaret på 'kan det finnas fler skador'", () => {
  assert.match(cardContext(card({ imageCount: 6, reviewed: false })), /6 vyer.*i en omgång/);
  assert.match(cardContext(card({ imageCount: 1, reviewed: true })), /1 vy.*två omgångar/);
});

test("saknat pris blir en uttalad avsaknad, inte en utelämnad rad", () => {
  const text = cardContext(
    card({
      price: {
        status: "unavailable",
        low: null,
        default: null,
        high: null,
        currency: "SEK",
        damageDeduction: null,
        unavailableReason: "Prismotorn svarade inte.",
      },
    }),
  );
  assert.match(text, /Inget prisförslag\. Prismotorn svarade inte\./);
  // Nypriset är en annan uppgift än marknadsvärdet och står kvar — men ingen siffra får kunna
  // förväxlas med ett prisförslag som inte finns.
  assert.doesNotMatch(text, /Marknadsvärde för skicket/);
});

test("priset bär både spann och skickavdrag, i procent", () => {
  const text = cardContext(card());
  assert.match(text, /Marknadsvärde för skicket: 2200 kr/);
  assert.match(text, /Spann: 1800–2600 kr/);
  assert.match(text, /Avdrag för skadorna: 12 %/);
  assert.match(text, /Nypris i handeln: 4200 kr/);
});

test("det som inte gick att belägga står med, så en fråga om det inte möts av en gissning", () => {
  const text = cardContext(
    card({
      card: { ...card().card, status: "partial", missingNotes: ["Djupet kunde inte bekräftas mot någon källa."] },
    }),
  );
  assert.match(text, /delvis belagt/);
  assert.match(text, /Kunde inte bekräftas: Djupet kunde inte bekräftas/);
});

test("boten vet var möbeln säljs bara när den faktiskt ligger uppe", () => {
  assert.match(cardContext(card({ tradera: null })), /Du vet inte var eller om den säljs/);
  assert.match(
    cardContext(card({ tradera: { status: "published", url: "https://www.tradera.com/item/1" } })),
    /säljs på Tradera/,
  );
  // Länken följer aldrig med in i kontexten: kortet har redan en knapp, och en inklistrad URL i ett
  // chattsvar är det enklaste sättet för boten att skicka någon till fel ställe.
  assert.doesNotMatch(cardContext(card({ tradera: { status: "published", url: "https://www.tradera.com/item/1" } })), /tradera\.com\/item/);
});

test("osäker identifiering döljs inte", () => {
  const base = card();
  const text = cardContext(
    card({
      card: {
        ...base.card,
        identity: { ...base.card.identity, confidence: "low", uncertain: true, uncertaintyNote: "Kan vara en äldre variant." },
      },
    }),
  );
  assert.match(text, /Träffsäkerhet i identifieringen: low/);
  assert.match(text, /Osäkerhet: Kan vara en äldre variant\./);
});
