// ─── Möbeltyperna: sidan för "begagnad soffa" ───────────────────────────────
//
// Kategorin är ett filter med nio värden; typen är ordet folk skriver i sökrutan. Varje typ har en
// egen sida, och sidan är ett löfte i tre led: brickan säger hur många, rutnätet visar dem, och
// sökmotorn får en titel som säger samma sak. Testerna låser fast att de tre leden räknar på samma
// regel — och att en tom hylla aldrig blir en sida som lovar soffor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MOBELTYPER, categoryBySlug, furnitureTypesIn, resolveTypeSlug, typeHeading } from "../server/src/butik/catalog.js";
import { applyFilter, typeFacetsMerged } from "../server/src/butik/inventory.js";
import { seoFor } from "../server/src/butik/seo.js";
import type { Product } from "../server/src/butik/types.js";

const vara = (over: Partial<Product> = {}): Product => ({
  id: Math.random().toString(36).slice(2), source: "loopa", title: "Soffa",
  brand: "IKEA", model: null, categorySlug: "soffor", color: null, material: null,
  dimensions: { widthMm: null, depthMm: null, heightMm: null, seatHeightMm: null },
  priceSek: 1000, retailPriceSek: null, imageUrl: null, condition: null,
  state: "live", listedAt: "2026-09-01T00:00:00Z", listedAtKnown: true,
  externalUrl: null, auction: null, region: "Stockholm", homeDeliveryAvailable: true,
  returnsAccepted: true, jobId: null, identity: null,
  ...over,
} as Product);

test("varje typ hör till en kategori som finns", () => {
  for (const t of MOBELTYPER) {
    assert.ok(categoryBySlug(t.categorySlug), `${t.slug} pekar på kategorin ${t.categorySlug}, som inte finns`);
  }
});

test("slugarna är unika och adressvänliga", () => {
  const slugar = MOBELTYPER.map((t) => t.slug);
  assert.equal(new Set(slugar).size, slugar.length);
  for (const s of slugar) assert.match(s, /^[a-z-]+$/, `${s} har tecken som inte hör hemma i en adress`);
});

test("det mer specifika ordet vinner: ett sängbord är ett sidobord, inte en säng", () => {
  assert.equal(resolveTypeSlug(vara({ title: "Sängbord i ek", categorySlug: "bord" })), "sidobord");
  assert.equal(resolveTypeSlug(vara({ title: "Barstol Bertil", categorySlug: "stolar" })), "barstolar");
  assert.equal(resolveTypeSlug(vara({ title: "Kontorsstol Markus", categorySlug: "skrivbord-kontor" })), "kontorsstolar");
  assert.equal(resolveTypeSlug(vara({ title: "Bäddsoffa Friheten", categorySlug: "soffor" })), "baddsoffor");
});

test("stavningen spelar ingen roll: Fåtölj, fatolj och FÅTÖLJ är samma typ", () => {
  for (const t of ["Fåtölj Poäng", "fatolj i skinn", "FÅTÖLJ"]) {
    assert.equal(resolveTypeSlug(vara({ title: t, categorySlug: "fatoljer" })), "fatoljer");
  }
});

test("en soffa utan närmare ord är en soffa — men ett bord utan närmare ord är inget matbord", () => {
  // Soffor har en fallback-typ: kategorin och typen är samma sak.
  assert.equal(resolveTypeSlug(vara({ title: "Lamino", categorySlug: "soffor" })), "soffor");
  // Bord har det inte: en typsida som lovar matbord får inte fyllas med bord vi inte vet är det.
  assert.equal(resolveTypeSlug(vara({ title: "NORDVIKEN", categorySlug: "bord" })), null);
});

test("modellen räknas när titeln inte säger något", () => {
  assert.equal(resolveTypeSlug(vara({ title: "IKEA", model: "Matbord Ekedalen", categorySlug: "bord" })), "matbord");
});

test("brickornas antal delas per källa, och bara det man kan gå till räknas", () => {
  const rader = typeFacetsMerged([
    vara({ title: "Matbord", categorySlug: "bord", source: "loopa" }),
    vara({ title: "Matbord", categorySlug: "bord", source: "tradera" }),
    vara({ title: "Matbord", categorySlug: "bord", source: "loopa", state: "sold" }),
    vara({ title: "Bord", categorySlug: "bord" }), // ingen typ: räknas inte någonstans
  ]);
  assert.equal(rader.length, 1, "bara typer med varor står med");
  assert.equal(rader[0].slug, "matbord");
  assert.equal(rader[0].loopa, 1);
  assert.equal(rader[0].tradera, 1);
  assert.equal(rader[0].count, 2);
});

test("brickorna står i katalogens ordning, inte storlekens — hyllan ska se likadan ut varje dag", () => {
  const rader = typeFacetsMerged([
    vara({ title: "Spegel", categorySlug: "ovrigt" }), vara({ title: "Spegel", categorySlug: "ovrigt" }),
    vara({ title: "Soffa", categorySlug: "soffor" }),
  ]);
  assert.deepEqual(rader.map((r) => r.slug), ["soffor", "speglar"]);
});

test("rutnätet och brickan räknar på samma regel", () => {
  const lager = [
    vara({ title: "Matbord", categorySlug: "bord" }),
    vara({ title: "Soffbord", categorySlug: "bord" }),
    vara({ title: "Matbord", categorySlug: "bord" }),
  ];
  const bricka = typeFacetsMerged(lager).find((r) => r.slug === "matbord")!;
  const rutnat = applyFilter(lager, { typeSlug: "matbord" });
  assert.equal(rutnat.total, bricka.count, "talet på brickan är ett löfte om vad sidan bakom innehåller");
});

test("rubriken böjs efter substantivet: begagnad soffa, begagnat matbord", () => {
  assert.equal(typeHeading(MOBELTYPER.find((t) => t.slug === "soffor")!), "Begagnad soffa");
  assert.equal(typeHeading(MOBELTYPER.find((t) => t.slug === "matbord")!), "Begagnat matbord");
});

test("varje kategori med typer har minst en, och syskonen delar kategori", () => {
  for (const t of MOBELTYPER) {
    const syskon = furnitureTypesIn(t.categorySlug);
    assert.ok(syskon.some((s) => s.slug === t.slug));
    assert.ok(syskon.every((s) => s.categorySlug === t.categorySlug));
  }
});

// ─── Sidan som sökmotorn ser ────────────────────────────────────────────────

test("typsidan heter det folk söker på: singular först, orten med", async () => {
  const head = await seoFor("/butik/mobel/soffor", "");
  assert.ok(head);
  assert.match(head.title, /^Begagnad soffa i Stockholm/);
  assert.match(head.body ?? "", /<h1>Begagnad soffa i Stockholm<\/h1>/);
  assert.equal(head.canonical.endsWith("/butik/mobel/soffor"), true);
});

test("en okänd typ får inget huvud alls — skalet skickas orört", async () => {
  assert.equal(await seoFor("/butik/mobel/finns-inte", ""), null);
});

test("typsidan bär brödsmulor upp genom kategorin", async () => {
  const head = await seoFor("/butik/mobel/matbord", "");
  assert.ok(head?.jsonLd);
  const grafer = JSON.parse(head.jsonLd);
  const lista = (Array.isArray(grafer) ? grafer : [grafer]).find((g) => g["@type"] === "BreadcrumbList");
  assert.ok(lista, "utan brödsmulor visar träffen en naken adress");
  const namn = lista.itemListElement.map((e: { name: string }) => e.name);
  assert.deepEqual(namn, ["Loopa Butik", "Bord", "Begagnat matbord"]);
});

test("en tom typ säger noindex och lovar ingenting i titeln", async () => {
  // Mattor är en typ i katalogen; har lagret inga är sidan ett tomt löfte och ska inte indexeras.
  const head = await seoFor("/butik/mobel/mattor", "");
  assert.ok(head);
  if (head.noindex) {
    assert.ok(!/\d+ till salu/.test(head.title), "en tom sida får inte lova ett antal");
    assert.ok(!head.jsonLd?.includes("FAQPage"), "frågor om pris utan ett pris att svara med");
  } else {
    assert.match(head.title, /\d+ till salu/);
  }
});

test("typsidan med varor svarar på frågorna i text OCH i strukturerad data", async () => {
  const head = await seoFor("/butik/mobel/soffor", "");
  assert.ok(head);
  if (head.noindex) return; // Tomt lager i den här körningen — inget att pröva mot.
  assert.match(head.body ?? "", /<h2>Vanliga frågor<\/h2>/);
  assert.match(head.body ?? "", /Vad kostar en begagnad soffa/);
  assert.ok(head.jsonLd?.includes('"FAQPage"'));
  assert.ok(head.jsonLd?.includes('"ItemList"'));
  assert.match(head.body ?? "", /href="\/butik\/objekt\//, "utan produktlänkar hittar en robot aldrig till en möbel");
  assert.match(head.body ?? "", /href="\/butik\/kategori\/soffor"/, "vägen upp till kategorin");
});

test("landningssidan och kategorisidan länkar till typsidorna — en sida ingen länkar till rankar inte", async () => {
  const landning = await seoFor("/butik", "");
  const typer = typeFacetsMerged(await (await import("../server/src/butik/inventory.js")).allProducts());
  if (typer.length === 0) return;
  assert.match(landning?.body ?? "", /href="\/butik\/mobel\//);
  const forsta = MOBELTYPER.find((t) => t.slug === typer[0].slug)!;
  const kategori = await seoFor(`/butik/kategori/${forsta.categorySlug}`, "");
  assert.match(kategori?.body ?? "", new RegExp(`href="/butik/mobel/${forsta.slug}"`));
});

test("sitemapen tar med typsidorna som har varor, och bara dem", async () => {
  const { sitemapXml } = await import("../server/src/butik/sitemap.js");
  const { allProducts } = await import("../server/src/butik/inventory.js");
  const xml = await sitemapXml();
  const med = new Set(typeFacetsMerged(await allProducts()).map((t) => t.slug));
  for (const t of MOBELTYPER) {
    assert.equal(xml.includes(`/butik/mobel/${t.slug}<`), med.has(t.slug), `${t.slug}: sitemapen och hyllan säger olika saker`);
  }
});
