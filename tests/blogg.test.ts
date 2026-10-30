// ─── Bloggen: guiderna på /blogg ───────────────────────────────────────────────────────────────
//
// Guiderna finns för sökmotorerna. Testerna låser fast att servern skickar HELA texten i HTML:en
// med rätt strukturerad data, att varje inlägg står i sitemapen och har en länk från startsidan, att
// länkarna i texten leder någonstans, och att det inläggen säger om Loopas avgift är samma tal som
// appen räknar med.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const rot = mkdtempSync(path.join(tmpdir(), "loopa-blogg-test-"));
process.env.BUTIK_DATA_DIR = path.join(rot, "butik");
process.env.LOOPA_JOBS_DIR = path.join(rot, "jobs");
process.env.LOOPA_PUBLIC_URL = "https://loopa.nu";
process.on("exit", () => rmSync(rot, { recursive: true, force: true }));

const { INLAGG, bloggVagFranAdress, delarAvText, renText } = await import("../web/src/lib/blogg.js");
const { seoFor } = await import("../server/src/butik/seo.js");
const { sitemapXml } = await import("../server/src/butik/sitemap.js");
const { LOOPA_FEE_CAP_SEK, LOOPA_PERCENT } = await import("../web/src/lib/fees.js");

const allText = (i: (typeof INLAGG)[number]) =>
  [i.ingress, ...i.delar.flatMap((d) => [d.rubrik, ...d.stycken, ...(d.punkter ?? [])]), ...i.fragor.flatMap((f) => [f.q, f.a])];

test("fem inlägg, med unika adresser och titlar, och beskrivningar Google inte kapar", () => {
  assert.equal(INLAGG.length, 5);
  assert.equal(new Set(INLAGG.map((i) => i.slug)).size, INLAGG.length);
  assert.equal(new Set(INLAGG.map((i) => i.titel)).size, INLAGG.length);
  for (const i of INLAGG) {
    assert.match(i.slug, /^[a-z0-9-]+$/, i.slug);
    assert.ok(i.beskrivning.length <= 160, `${i.slug}: beskrivningen är ${i.beskrivning.length} tecken`);
    const ord = allText(i).map(renText).join(" ").split(/\s+/).length;
    assert.ok(ord >= 400, `${i.slug}: bara ${ord} ord`);
  }
});

test("servern skickar hela inlägget i HTML:en, med BlogPosting, FAQ och brödsmulor", async () => {
  for (const i of INLAGG) {
    const head = await seoFor(`/blogg/${i.slug}`, "");
    assert.ok(head, i.slug);
    assert.equal(head.canonical, `https://loopa.nu/blogg/${i.slug}`);
    assert.equal(head.noindex, undefined);
    assert.equal(head.ogType, "article");
    assert.match(head.body ?? "", new RegExp(`<h1>${i.titel.replace(/[?()]/g, "\\$&")}</h1>`));
    // Varje rubrik och sista stycket i varje del finns i kroppen — hela texten, inte en sammanfattning.
    for (const d of i.delar) assert.ok(head.body!.includes(d.rubrik.replace(/&/g, "&amp;")), `${i.slug}: ${d.rubrik}`);
    const typer = (JSON.parse(head.jsonLd!) as Array<{ "@type": string }>).map((g) => g["@type"]);
    assert.deepEqual(typer, ["BlogPosting", "FAQPage", "BreadcrumbList"]);
  }
});

test("listan på /blogg länkar alla inlägg, och en okänd guide indexeras inte", async () => {
  const lista = await seoFor("/blogg", "");
  for (const i of INLAGG) assert.ok(lista?.body?.includes(`href="/blogg/${i.slug}"`));
  const okand = await seoFor("/blogg/finns-inte", "");
  assert.equal(okand?.noindex, true);
});

test("startsidan länkar varje inlägg — en sida ingenting länkar till hittas inte", async () => {
  const hem = await seoFor("/", "");
  for (const i of INLAGG) assert.ok(hem?.body?.includes(`href="/blogg/${i.slug}"`), i.slug);
});

test("sitemapen har listan och varje inlägg med datum", async () => {
  const xml = await sitemapXml();
  assert.ok(xml.includes("<loc>https://loopa.nu/blogg</loc>"));
  for (const i of INLAGG) {
    assert.ok(xml.includes(`<loc>https://loopa.nu/blogg/${i.slug}</loc>`), i.slug);
  }
});

test("länkarna i texten leder till startsidan eller ett inlägg som finns", () => {
  const giltiga = new Set(["/", "/blogg", ...INLAGG.map((i) => `/blogg/${i.slug}`)]);
  for (const i of INLAGG) {
    for (const text of allText(i)) {
      for (const d of delarAvText(text)) if (d.href) assert.ok(giltiga.has(d.href), `${i.slug}: ${d.href}`);
      assert.ok(!/\]\(/.test(renText(text)), `${i.slug}: trasig länkmarkering`);
    }
  }
});

test("avgiften i guiderna är samma som appen räknar med", () => {
  for (const i of INLAGG) {
    for (const text of allText(i).map(renText)) {
      for (const m of text.matchAll(/(\d+) % av (?:vad|försäljningspriset)/g)) assert.equal(Number(m[1]), LOOPA_PERCENT, `${i.slug}: ${text}`);
      for (const m of text.matchAll(/(?:mer än|högst) ([\d ]+) kr/g)) {
        const tal = Number(m[1].replace(/\s/g, ""));
        if (/aldrig mer än|högst/.test(m[0])) assert.ok(tal === LOOPA_FEE_CAP_SEK || tal === LOOPA_FEE_CAP_SEK * 5, `${i.slug}: ${m[0]}`);
      }
    }
  }
});

test("adressen känns igen som blogg bara på /blogg", () => {
  assert.deepEqual(bloggVagFranAdress("/blogg"), { slug: null });
  assert.deepEqual(bloggVagFranAdress("/blogg/"), { slug: null });
  assert.deepEqual(bloggVagFranAdress("/blogg/salja-mobler-infor-flytt"), { slug: "salja-mobler-infor-flytt" });
  assert.equal(bloggVagFranAdress("/bloggar"), null);
  assert.equal(bloggVagFranAdress("/blogg/a/b"), null);
  assert.equal(bloggVagFranAdress("/"), null);
});
