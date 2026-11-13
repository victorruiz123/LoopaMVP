// ─── Referensbildkedjan A → C → B (2026-11-09) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Inga nätanrop och inga betalda anrop: sidhämtningen, det jämförande valet och Gemini-sökningen byts ut (settSidhamtare, settBildvaljare, settSokare) och bildnedladdningen serveras av en låtsas-fetch.
// Det som prövas är KEDJAN: vad som släpps igenom, vad som avvisas och vilket steg som körs när.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-refkedja-jobs-"));
process.env.LOOPA_KANDIDATBILDER_DIR = mkdtempSync(path.join(tmpdir(), "loopa-refkedja-kb-"));
delete process.env.LOOPA_REFERENCE_CHAIN;
process.on("exit", () => {
  rmSync(process.env.LOOPA_JOBS_DIR!, { recursive: true, force: true });
  rmSync(process.env.LOOPA_KANDIDATBILDER_DIR!, { recursive: true, force: true });
});

const R = await import("../server/src/referensbild.js");
const { createJob, getJob, persist } = await import("../server/src/jobStore.js");
const { applyExternalImages } = await import("../server/src/pipeline/identify.js");
const { registreradKandidatbild } = await import("../server/src/kandidatbild.js");
const sharp = createRequire(new URL("../server/src/kandidatbild.ts", import.meta.url))("sharp") as typeof import("../server/node_modules/sharp");

const JPEG = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 190, g: 175, b: 155 } } }).jpeg().toBuffer();
const lokal = (url: string) => `/api/kandidatbild/${createHash("sha1").update(url).digest("hex")}.jpg`;
async function medFetch(fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}
const fatolj = (brand: string, model: string, sourceUrl?: string): import("../server/src/referensbild.js").RefKandidat => ({ brand, model, productType: "fåtölj", undertyp: null, sourceUrl: sourceUrl ?? null });
const barstol = (brand: string, model: string, sourceUrl?: string): import("../server/src/referensbild.js").RefKandidat => ({ brand, model, productType: "stol", undertyp: "barstol", sourceUrl: sourceUrl ?? null });

// ── Steg A: vad är en produktsida? (mätt på 48 sparade länkar, docs/bildstrategi-2026-11-09.md) ─────────────────────────────────────────────────────────────────────────────────────

test("arProduktsida: riktiga produktsidor godkänns; startsidor, kategorier, kollektioner, annonser, prisjämförare, tillbehör, andra typer och sidor utan modellens namn avvisas", () => {
  const ok = (url: string, c = fatolj("Sits", "Impulse")) => R.arProduktsida(url, c);
  // godkänns
  assert.ok(R.arProduktsida("https://www.ikea.com/se/sv/p/nordviken-barstol-baenkhoejd-svart-00424693/", barstol("IKEA", "NORDVIKEN")));
  assert.ok(R.arProduktsida("https://www.ikea.com/us/en/p/rosentorp-bar-stool-with-backrest-counter-height-black-10619930/", barstol("IKEA", "ROSENTORP")));
  assert.ok(ok("https://tibergsmobler.se/produkter/impulse-fatolj"));
  assert.ok(R.arProduktsida("https://www.podfurniture.ie/products/sally-armchair", fatolj("Sits", "Sally")));
  // avvisas: startsida, kategori, kollektion, sök
  assert.ok(!ok("https://sits.eu/"));
  assert.ok(!ok("https://sits.eu/products/armchairs/"), "modellens namn saknas i sökvägen");
  assert.ok(!ok("https://sits.eu/collection/impulse/"), "kollektionssida: trasig og:image och miljöbilder");
  assert.ok(!R.arProduktsida("https://www.ikea.com/se/sv/cat/ekedalen-serie-38609/", barstol("IKEA", "EKEDALEN")), "kategori/serie");
  assert.ok(!R.arProduktsida("https://www.ikea.com/se/sv/search/?q=nordviken", barstol("IKEA", "NORDVIKEN")));
  // avvisas: annons, prisjämförare, andra sajter som inte är produktsidor
  assert.ok(!R.arProduktsida("https://www.blocket.se/recommerce/forsale/item/27543172", fatolj("Sits", "Palma")));
  assert.ok(!R.arProduktsida("https://www.pricerunner.se/pl/343-1/IKEA-NORDVIKEN-Barstol-priser", barstol("IKEA", "NORDVIKEN")));
  assert.ok(!R.arProduktsida("https://issuu.com/sits.eu/docs/impulse", fatolj("Sits", "Impulse")));
  assert.ok(!ok("https://tibergsmobler.se/produkter/kladsel-till-impulse-fatolj"), "klädsel är ett tillbehör, inte möbeln");
  // avvisas: annan typ i sökvägen (soffan för en fåtölj) och annan modell
  assert.ok(!ok("https://tibergsmobler.se/varumarken/sits/soffor/impulse-soffa"), "en soffa-sida för en fåtölj");
  assert.ok(!ok("https://tibergsmobler.se/produkter/jenny-fatolj"), "fel modell");
  assert.ok(!ok("inte en adress"));
  assert.ok(!ok("ftp://x.test/impulse"));
});

test("lasSida + sidanArModellen: bilder ur JSON-LD, og:image och twitter:image (loggor bort); identiteten läses ur adress, titel och märkesfält, ALDRIG ur brödtexten ('sits' är svenska för 'seat')", () => {
  const html = `<html><head><title>Impulse Fåtölj | Tyg | Designa själv | Sits | Tibergs Möbler</title>
    <meta property="og:title" content="Impulse Fåtölj"><meta property="og:image" content="/media/impulse-1.jpg">
    <meta name="twitter:image" content="https://cdn.test/impulse-2.jpg">
    <script type="application/ld+json">{"@type":"Product","name":"Impulse","brand":{"@type":"Brand","name":"Sits"},"image":["https://cdn.test/impulse-0.jpg",{"url":"https://cdn.test/logo.png"}]}</script></head>
    <body><h1>Impulse Fåtölj</h1><p>Mjuk sits och hög rygg</p></body></html>`;
  const s = R.lasSida(html, "https://tibergsmobler.se/produkter/impulse-fatolj");
  assert.deepEqual(s.bilder, ["https://cdn.test/impulse-0.jpg", "https://tibergsmobler.se/media/impulse-1.jpg", "https://cdn.test/impulse-2.jpg"], "JSON-LD först, sedan og:image och twitter:image; logo.png bort");
  assert.equal(s.jsonldMarke, "Sits");
  assert.ok(s.titlar.some((t: string) => t.includes("Impulse Fåtölj")));
  assert.ok(R.sidanArModellen(fatolj("Sits", "Impulse"), s));
  // märket bara i brödtexten ("hög sits"): inget belägg
  const utanMarke = R.lasSida(`<html><head><title>Impulse Fåtölj</title></head><body>En fåtölj med bekväm sits. Sits sits sits.</body></html>`, "https://annan.se/produkter/impulse-fatolj");
  assert.equal(utanMarke.jsonldMarke, null);
  assert.ok(!R.sidanArModellen(fatolj("Sits", "Impulse"), utanMarke), "märket 'Sits' i brödtexten räknas inte");
  // fel modell
  assert.ok(!R.sidanArModellen(fatolj("Sits", "Jenny"), s));
});

test("belaggIAdress: märket OCH modellen i bildens eller sidans adress (fångade Jackie, Logan och Madison i mätningen, släppte igenom de rätta)", () => {
  const b = (brand: string, model: string, ...u: string[]) => R.belaggIAdress({ brand, model }, u);
  assert.ok(b("Sits", "Palma", "https://www.bohus.no/pimcorecdn/Leverand%C3%B8rer/Sits/Produkter/PALMA/112448/image.jpg"));
  assert.ok(b("Sits", "Brandon", "https://www.taskers.com/media/catalog/x.jpg", "https://www.taskers.com/sits-brandon-armchair"));
  assert.ok(b("IKEA", "INGEMAR", "https://www.remodelista.com/wp-content/uploads/2015/03/img/sub/ikea-ingemar-321x.jpg"));
  assert.ok(!b("Sits", "Jackie", "https://www.ncnordiccare.se/wp-content/uploads/Jackie_531.png", "https://www.ncnordiccare.se/produkter/jackie-531/"), "fel märke");
  assert.ok(!b("Sits", "Logan", "https://www.finnishdesignshop.com/sv-se/produkt/offset-1-sitssoffa-med-los-kladsel-logan-jasmine"), "'sitssoffa' är inte ordet Sits");
  assert.ok(!b("Sits", "Madison", "https://www.swedese.se/produkter/fatoljer/madison--fatolj-"), "fel märke");
  assert.ok(!b("Sits", "Impulse", undefined, ""));
});

// ── Steg A: hela vägen för en kandidat ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("steg A: en produktlänk ger bilden efter ett jämförande val; avvisas när länken inte är en produktsida, sidan inte visar märket och modellen, eller valet säger att ingen duger", async () => {
  const anrop: string[] = [];
  const valdaAv: Array<{ ord: string; antal: number }> = [];
  R.settSidhamtare(async (url: string) => {
    anrop.push(url);
    if (url.includes("tibergs")) return R.lasSida(`<html><head><title>Impulse Fåtölj | Sits | Tibergs</title><meta property="og:image" content="https://cdn.test/a.jpg"><meta name="twitter:image" content="https://cdn.test/b.jpg"></head></html>`, url);
    if (url.includes("annan")) return R.lasSida(`<html><head><title>Impulse Fåtölj</title><meta property="og:image" content="https://cdn.test/c.jpg"></head><body>sits sits</body></html>`, url);
    if (url.includes("ikea")) return R.lasSida(`<html><head><title>NORDVIKEN barstol</title><meta property="og:image" content="https://cdn.test/n.jpg"></head></html>`, url);
    return null;
  });
  let svar: number | null = 1;
  R.settBildvaljare(async (ctx: { ord: string }, kand: unknown[]) => {
    valdaAv.push({ ord: ctx.ord, antal: kand.length });
    return svar;
  });
  try {
    await medFetch(async () => {
      const a = await R.losFranProduktlank(fatolj("Sits", "Impulse", "https://tibergsmobler.se/produkter/impulse-fatolj"), "job-a");
      assert.equal(a?.steg, "A");
      assert.equal(a?.url, lokal("https://cdn.test/b.jpg"), "valet pekade på bild nummer 2 av två");
      assert.equal(a?.source, "https://tibergsmobler.se/produkter/impulse-fatolj");
      assert.deepEqual(valdaAv.at(-1), { ord: "fåtölj", antal: 2 });
      // IKEA barstol: typens ord i valet är "barstol"
      svar = 0;
      const n = await R.losFranProduktlank(barstol("IKEA", "NORDVIKEN", "https://www.ikea.com/se/sv/p/nordviken-barstol-svart-00424693/"), "job-a");
      assert.equal(n?.url, lokal("https://cdn.test/n.jpg"));
      assert.equal(valdaAv.at(-1)!.ord, "barstol");

      const antalFore = anrop.length;
      assert.equal(await R.losFranProduktlank(fatolj("Sits", "Brandon", "https://sits.eu/"), "job-a"), null, "startsida: sidan hämtas inte ens");
      assert.equal(await R.losFranProduktlank(fatolj("Sits", "Quattro", null as unknown as string), "job-a"), null, "ingen länk");
      assert.equal(anrop.length, antalFore, "ingen sidhämtning för länkar som inte är produktsidor");
      assert.equal(await R.losFranProduktlank(fatolj("Sits", "Impulse", "https://annan.se/produkter/impulse-fatolj"), "job-a"), null, "märket står bara i brödtexten");
      assert.equal(await R.losFranProduktlank(fatolj("Sits", "Impulse", "https://spard.se/produkter/impulse-fatolj"), "job-a"), null, "sidan gick inte att hämta (403)");
      svar = null;
      assert.equal(await R.losFranProduktlank(fatolj("Sits", "Impulse", "https://tibergsmobler.se/produkter/impulse-fatolj"), "job-a"), null, "valet: ingen bild duger");
    });
  } finally {
    R.settSidhamtare(null);
    R.settBildvaljare(null);
  }
});

test("losProduktsidor: alla kandidater parallellt, och ett tak för hela steget — den som inte hinner är inte klar och går vidare", async () => {
  R.settSidhamtare(async (url: string) => {
    if (url.includes("langsam")) await new Promise((r) => setTimeout(r, 400));
    return R.lasSida(`<html><head><title>Impulse Fåtölj | Sits</title><meta property="og:image" content="https://cdn.test/${url.includes("langsam") ? "l" : "s"}.jpg"></head></html>`, url);
  });
  R.settBildvaljare(async () => 0);
  try {
    await medFetch(async () => {
      const ut = await R.losProduktsidor("job-p", [fatolj("Sits", "Impulse", "https://snabb.se/produkter/impulse-fatolj"), fatolj("Sits", "Impulse", "https://langsam.se/produkter/impulse-fatolj")], 150);
      assert.deepEqual([...ut.keys()], ["Impulse"]);
      assert.equal(ut.get("Impulse")!.url, lokal("https://cdn.test/s.jpg"), "den snabba hann, den långsamma föll på taket");
    });
  } finally {
    R.settSidhamtare(null);
    R.settBildvaljare(null);
  }
});

// ── Steg B: Gemini med webbsök ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("steg B: tas emot bara om märket OCH modellen står i adressen och bilden går att hämta och klarar valet; fel märke, ingen länk och ett fel avvisas", async () => {
  const fraga: string[] = [];
  let nasta: { image_url?: string; page_url?: string } | "fel" | null = null;
  R.settSokare(async (c: { model: string }, _jobId: string, maxSok: number) => {
    fraga.push(`${c.model}/${maxSok}`);
    if (nasta === "fel") throw new Error("nätet föll");
    return nasta;
  });
  R.settBildvaljare(async () => 0);
  try {
    await medFetch(async () => {
      nasta = { image_url: "https://www.taskers.com/media/sits-brandon-armchair.jpg", page_url: "https://www.taskers.com/sits-brandon-armchair" };
      const ok = await R.losFranSokning(fatolj("Sits", "Brandon"), "job-b");
      assert.equal(ok?.steg, "B");
      assert.equal(ok?.url, lokal("https://www.taskers.com/media/sits-brandon-armchair.jpg"));
      assert.equal(ok?.source, "https://www.taskers.com/sits-brandon-armchair");
      assert.ok(Number(fraga[0].split("/")[1]) >= 1 && Number(fraga[0].split("/")[1]) <= 3, "ett tak på sökfrågor skickas med");

      nasta = { image_url: "https://www.ncnordiccare.se/wp-content/uploads/Jackie_531.png", page_url: "https://www.ncnordiccare.se/produkter/jackie-531/" };
      assert.equal(await R.losFranSokning(fatolj("Sits", "Jackie"), "job-b"), null, "fel märke");
      // Flera alternativ: fel märke avvisas på adressen, resten hämtas och valet tar bästa (här: det första som återstår).
      nasta = { alternativ: [
        { image_url: "https://www.ncnordiccare.se/wp-content/uploads/Jackie_531.png", page_url: "https://www.ncnordiccare.se/produkter/jackie-531/" },
        { image_url: "https://www.taskers.com/media/sits-quattro-armchair.jpg", page_url: "https://www.taskers.com/sits-quattro-armchair" },
        { image_url: "https://t.test/sits-quattro-2.jpg", page_url: "" },
      ] } as never;
      const fl = await R.losFranSokning(fatolj("Sits", "Quattro"), "job-b");
      assert.equal(fl?.url, lokal("https://www.taskers.com/media/sits-quattro-armchair.jpg"), "valet tog första av de giltiga");
      assert.equal(await R.losFranSokning(fatolj("Sits", "Jackie"), "job-b").then((x: unknown) => x), null, "bara fel märke: inget B-alternativ duger");
      nasta = { image_url: "", page_url: "" };
      assert.equal(await R.losFranSokning(fatolj("Sits", "Palma"), "job-b"), null, "ingen länk");
      nasta = "fel";
      assert.equal(await R.losFranSokning(fatolj("Sits", "Palma"), "job-b"), null, "ett fel är inget svar");
    });
  } finally {
    R.settSokare(null);
    R.settBildvaljare(null);
  }
});

// ── Hela kedjan genom applyExternalImages: C för dem som har rader, B sist och bara för dem som saknar bild ─────────────────────────────────────────────────────────────────────────

async function jobbMedKandidater(kandidater: Array<{ model: string; imageUrl?: string; sourceUrl?: string }>) {
  const job = await createJob(null);
  (job as unknown as { identity: unknown }).identity = { brand: "Sits", model: "" };
  job.identityStatus = "needs_selection";
  job.externalImagesPending = true;
  job.candidates = kandidater.map((k) => ({ brand: "Sits", model: k.model, variant: null, productType: "fåtölj", confidence: "likely", distinguishingDetail: null, ...(k.imageUrl ? { imageUrl: k.imageUrl } : {}), ...(k.sourceUrl ? { sourceUrl: k.sourceUrl } : {}) }));
  // AI-lägets identifieringssvar med en beskrivning per modell: det bildvalet och registret behöver (utan det sparas ingen bild i registret).
  job.identityResearch = { researchText: ["IDENTIFIERING (Googles AI-läge)", ...kandidater.map((k, i) => `### ${i + 1}. ${k.model} (80 %)\n- Motivering: En stoppad fåtölj.`)].join("\n"), sources: [] };
  await persist(job);
  return job.id;
}
const rad = (alt: string, src: string, source = "Tibergs Möbler", page = "https://tibergsmobler.se/x") => ({ src, alt, w: 600, h: 600, source, page });

test("applyExternalImages med kedjan: C väljer bland raderna som klarat reglerna, B körs bara när appens lista är slutgiltig och bara för modeller som saknar bild, och väntan släpps först efter B", async () => {
  const id = await jobbMedKandidater([{ model: "Impulse", imageUrl: "/api/kandidatbild/frangenA.jpg" }, { model: "Brandon" }, { model: "Colin" }, { model: "Alex" }]);
  const sokta: string[] = [];
  const valdaBland: number[] = [];
  R.settBildvaljare(async (_ctx: unknown, kand: unknown[]) => {
    valdaBland.push(kand.length);
    return 0;
  });
  R.settSokare(async (c: { model: string }) => {
    sokta.push(c.model);
    return c.model === "Colin" ? { image_url: "https://t.test/sits-colin-armchair.jpg", page_url: "https://t.test/sits-colin" } : { image_url: "", page_url: "" };
  });
  try {
    await medFetch(async () => {
      const grupper = [
        // Brandon: tre rader med märket (en prisjämförare ska bort), Colin: bara en annan tillverkares rad (ingen "Sits"), Alex: inga rader alls
        { model: "Brandon", rows: [rad("Sits Brandon Armchair | Snug", "https://t.test/b1.jpg"), rad("Brandon Fåtölj - Sits", "https://t.test/b2.jpg"), rad("Brandon 3-seater Sofa - Sits", "https://t.test/b4.jpg"), rad("Sits Brandon (1 butiker) se bästa priserna", "https://t.test/b3.jpg", "PriceRunner", "https://www.pricerunner.se/pl/1")] },
        { model: "Colin", rows: [rad("Colin snurrfåtölj | Newport", "https://t.test/c1.jpg", "Newport", "https://newport.se/colin")] },
      ];
      // Första postningen (final: false): C körs, B INTE.
      const r1 = await applyExternalImages(id, grupper, { final: false });
      assert.deepEqual(r1.set, ["Brandon"]);
      assert.deepEqual(sokta, [], "B körs inte före den slutgiltiga listan");
      assert.equal((await getJob(id))!.externalImagesPending, true);
      assert.deepEqual(valdaBland, [2], "det jämförande valet fick de två raderna som klarade reglerna (prisjämföraren och soffan var bort)");
      // Slutgiltig lista: B för Colin och Alex (Impulse har redan bild och Brandon fick sin i C).
      const r2 = await applyExternalImages(id, [], { final: true });
      assert.deepEqual(sokta.sort(), ["Alex", "Colin"]);
      assert.deepEqual(r2.set, ["Colin"]);
    });
  } finally {
    R.settBildvaljare(null);
    R.settSokare(null);
  }
  const job = (await getJob(id))!;
  const bild = (m: string) => job.candidates!.find((c) => c.model === m)!.imageUrl;
  assert.equal(bild("Impulse"), "/api/kandidatbild/frangenA.jpg", "A:s bild rörs aldrig");
  assert.equal(bild("Brandon"), lokal("https://t.test/b1.jpg"), "C: valet pekade på första raden");
  assert.equal(bild("Colin"), lokal("https://t.test/sits-colin-armchair.jpg"), "B");
  assert.equal(bild("Alex"), null, "ingen bild: ett besked, inte 'letar'");
  assert.equal(job.externalImagesPending, false, "väntan släpps efter B");
  assert.equal(job.candidates!.find((c) => c.model === "Colin")!.imageSource, "https://t.test/sits-colin");
  // Registret: C:s och B:s bilder sparas under appens nycklar, så nästa säljare slipper hela kedjan.
  assert.equal(await registreradKandidatbild("Sits", "Brandon", "g:fatolj"), lokal("https://t.test/b1.jpg"));
  assert.equal(await registreradKandidatbild("Sits", "Colin", "g:fatolj"), lokal("https://t.test/sits-colin-armchair.jpg"));
});

test("applyExternalImages med kedjan: föll appens bildsökning (tom lista) frågar B om ALLA som saknar bild; LOOPA_REFERENCE_CHAIN=0 stänger av B", async () => {
  const id = await jobbMedKandidater([{ model: "Palma" }, { model: "Quattro" }]);
  const sokta: string[] = [];
  R.settSokare(async (c: { model: string }) => {
    sokta.push(c.model);
    return { image_url: `https://t.test/sits-${c.model.toLowerCase()}.jpg`, page_url: "" };
  });
  R.settBildvaljare(async () => 0);
  try {
    await medFetch(async () => {
      await applyExternalImages(id, [], { final: true });
      assert.deepEqual(sokta.sort(), ["Palma", "Quattro"]);
      // Av: samma sak på ett nytt jobb ger ingen sökning och "ingen bild" som besked.
      process.env.LOOPA_REFERENCE_CHAIN = "0";
      const id2 = await jobbMedKandidater([{ model: "Palma" }]);
      sokta.length = 0;
      await applyExternalImages(id2, [], { final: true });
      assert.deepEqual(sokta, [], "kedjan av: ingen B");
      assert.equal((await getJob(id2))!.candidates![0].imageUrl, null);
    });
  } finally {
    delete process.env.LOOPA_REFERENCE_CHAIN;
    R.settSokare(null);
    R.settBildvaljare(null);
  }
  const job = (await getJob(id))!;
  assert.equal(job.candidates![0].imageUrl, lokal("https://t.test/sits-palma.jpg"));
  assert.equal(job.externalImagesPending, false);
});

// ── PREBEN (2026-11-12): två möbler med samma namn, och vad bildvalet vet om dem ───────────────────────────────────────────────────────────────

const { readFileSync } = await import("node:fs");
const render = await import("../server/src/serpapi/render.js");
const ext = await import("../server/src/externalImages.js");
const fixtur = (n: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/serpapi", n), "utf8"));
/** AI-lägets riktiga identifieringssvar för säljarens PREBEN (stoppad stol med stålunderrede), som servern lagrar det. */
const PREBEN_SVAR = render.answerText(fixtur("aimode-preben.json"));

test("beskrivningUr: avsnittet om just PREBEN, utan länkar och källhänvisningar, med artikelnumret som generation; andra modellers avsnitt blandas inte in", () => {
  const b = R.beskrivningUr(PREBEN_SVAR, "PREBEN");
  assert.match(b.beskrivning, /helklädda sitsen/);
  assert.match(b.beskrivning, /grålackerat stål/);
  assert.match(b.beskrivning, /Utgången modell/);
  assert.doesNotMatch(b.beskrivning, /https?:|\[\d\]|BERGMUND|HENRIKSDAL/);
  assert.equal(b.generation, "602.013.31");
  const k = R.beskrivningUr(PREBEN_SVAR, "KÄTTIL");
  assert.match(k.beskrivning, /Aktuell modell/);
  assert.doesNotMatch(k.beskrivning, /PREBEN/);
  assert.equal(k.generation, "", "ingen generation att ange för en aktuell modell utan artikelnummer i sitt avsnitt");
  assert.deepEqual(R.beskrivningUr(PREBEN_SVAR, "FINNSINTE"), { beskrivning: "", generation: "" });
  assert.deepEqual(R.beskrivningUr("", "PREBEN"), { beskrivning: "", generation: "" });
});

test("beskrivningUr: årtiondet används när artikelnummer saknas, annars blir generationen tom", () => {
  assert.equal(R.beskrivningUr("### 1. PREBEN (95 %)\n- Status: Utgången modell (såldes under 1970-talet).\n- Motivering: pinnstol i trä.", "PREBEN").generation, "1970");
  assert.equal(R.beskrivningUr("1. PREBEN (95 %)\nStatus: såldes på 2010-talet.", "PREBEN").generation, "2010");
  assert.equal(R.beskrivningUr("1. IMPULSE (80 %)\nMotivering: stoppad fåtölj.", "IMPULSE").generation, "");
});

test("registerTyp: två möbler med samma namn får olika registernycklar, och utan generation blir nyckeln som förut", () => {
  const c = { model: "PREBEN", productType: "stol", undertyp: null };
  assert.equal(R.registerTyp(c, PREBEN_SVAR), "g:stol:602.013.31");
  assert.equal(R.registerTyp(c, "1. PREBEN\nStatus: såldes under 1970-talet.\nMotivering: pinnstol."), "g:stol:1970");
  assert.notEqual(R.registerTyp(c, PREBEN_SVAR), R.registerTyp(c, "1. PREBEN\nStatus: såldes under 1970-talet."));
  assert.equal(R.registerTyp({ model: "Impulse", productType: "fåtölj", undertyp: null }, "1. Impulse\nMotivering: stoppad."), "g:fatolj");
  assert.equal(R.registerTyp({ model: "NORDVIKEN", productType: "stol", undertyp: "barstol" }, ""), "g:barstol");
});

test("unikaKallor: samma sida med samma titel tas bara en gång (Instagram-bilden tre gånger), två bilder från samma sida med olika titlar behålls", () => {
  const rader = [
    { id: 1, sida: "https://www.instagram.com/p/ABC/?utm=1", titel: "Vintage IKEA Preben", kalla: "Instagram" },
    { id: 2, sida: "https://instagram.com/p/ABC", titel: "Vintage IKEA  PREBEN", kalla: "Instagram" },
    { id: 3, sida: "https://shop.test/x", titel: "Stol framifrån", kalla: "Shop" },
    { id: 4, sida: "https://shop.test/x", titel: "Stol från sidan", kalla: "Shop" },
    { id: 5, sida: null, titel: "Preben", kalla: "Blocket" },
    { id: 6, sida: null, titel: "preben", kalla: "Blocket" },
    { id: 7, sida: null, titel: "Preben", kalla: "Auctionet" },
  ];
  assert.deepEqual(R.unikaKallor(rader, (r) => r).map((r) => r.id), [1, 3, 4, 5, 7]);
});

test("PREBEN: av de riktiga 40 träffarna gick bara äldre pinnstolar till valet med fem platser — med dubbletterna borta och åtta platser är IKPARTS (den moderna stolen) med", () => {
  const rader = render.imageRows({ images_results: fixtur("bildrader-preben.json") }) as Array<{ src: string; alt: string; source?: string; page?: string }>;
  assert.equal(rader.length, 40);
  const rad = new Map(rader.map((r) => [r.src, r]));
  const klara = ext.pickReferenceRows(rader, "PREBEN", "IKEA", "stol", null).filter((r: { marketplace: boolean }) => !r.marketplace);
  const kallor = (lista: Array<{ src: string }>) => lista.map((r) => rad.get(r.src)?.source);
  assert.ok(!kallor(klara.slice(0, 5)).includes("IKPARTS Spare Parts"), "förut: fem första, och IKPARTS föll bort");
  const nu = R.unikaKallor(klara, (r: { src: string }) => ({ sida: rad.get(r.src)?.page, titel: rad.get(r.src)?.alt, kalla: rad.get(r.src)?.source })).slice(0, R.valMax());
  assert.ok(kallor(nu).includes("IKPARTS Spare Parts"), "nu: IKPARTS med bland valets bilder");
  assert.ok(nu.length >= 5 && nu.length <= 8);
  assert.equal(new Set(nu.map((r: { src: string }) => `${rad.get(r.src)?.page}|${rad.get(r.src)?.alt}`)).size, nu.length, "inga dubbletter kvar");
});

test("byggValjPrompt: beskrivningen och säljarens foto är med, konstruktionen ska stämma (inte 'utförande spelar ingen roll'), och 0 är ett giltigt svar; utan foto hänvisas till beskrivningen", () => {
  const kand = [{ lokal: "/api/kandidatbild/a.jpg", titel: "Pinnstol Preben", kalla: "Auctionet" }, { lokal: "/api/kandidatbild/b.jpg", titel: "IKEA PREBEN reservdelar", kalla: "IKPARTS" }];
  const ctx = { brand: "IKEA", model: "PREBEN", ord: "stol", beskrivning: "Slank, helklädd sits och rygg, grålackerat stål, ben i massiv bok." };
  const med = R.byggValjPrompt(ctx, kand, true);
  assert.match(med.system, /helklädd sits/);
  assert.match(med.system, /FÖRSTA bilden är säljarens egen möbel/);
  assert.match(med.system, /samma KONSTRUKTION som säljarens foto/);
  assert.match(med.system, /SAMMA NAMN KAN HA ANVÄNTS PÅ TVÅ HELT OLIKA MÖBLER/);
  assert.match(med.system, /Svara 0 om ingen bild visar samma konstruktion/);
  assert.doesNotMatch(med.system, /utförande spelar INGEN roll/i);
  assert.match(med.user, /Bild 1: "Pinnstol Preben" \(sajt: Auctionet\)\nBild 2: "IKEA PREBEN reservdelar" \(sajt: IKPARTS\)/);
  const utan = R.byggValjPrompt(ctx, kand, false);
  assert.doesNotMatch(utan.system, /FÖRSTA bilden/);
  assert.match(utan.system, /samma KONSTRUKTION som beskrivningen/);
  const ingenting = R.byggValjPrompt({ brand: "IKEA", model: "PREBEN", ord: "stol" }, kand, false);
  assert.doesNotMatch(ingenting.system, /Så här beskrivs/);
  assert.match(ingenting.system, /Svara 0/);
});

test("valMax: åtta som förval, LOOPA_REFERENS_VAL_MAX ändrar", () => {
  assert.equal(R.valMax(), 8);
  process.env.LOOPA_REFERENS_VAL_MAX = "5";
  try {
    assert.equal(R.valMax(), 5);
  } finally {
    delete process.env.LOOPA_REFERENS_VAL_MAX;
  }
});

test("registret skrivs bara när bilden valts MED underlag, och under en nyckel som bär generationen: en bild utan beskrivning och utan säljarfoto sparas inte", async () => {
  // Jobb UTAN identifieringssvar och utan omslagsbild: ingen beskrivning, inget foto.
  const utan = await jobbMedKandidater([{ model: "Zeta" }]);
  const ju = (await getJob(utan))!;
  ju.identityResearch = undefined;
  await persist(ju);
  R.settSokare(async () => ({ image_url: "https://t.test/sits-zeta.jpg", page_url: "" }));
  R.settBildvaljare(async () => 0);
  try {
    await medFetch(async () => {
      const r = await applyExternalImages(utan, [], { final: true });
      assert.deepEqual(r.set, ["Zeta"], "bilden visas för säljaren");
    });
  } finally {
    R.settSokare(null);
    R.settBildvaljare(null);
  }
  assert.equal(await registreradKandidatbild("Sits", "Zeta", "g:fatolj"), null, "men registret får den inte");

  // Jobb MED ett identifieringssvar som beskriver modellen (och anger artikelnumret): bilden sparas under generationsnyckeln.
  const med = await jobbMedKandidater([{ model: "Omega" }]);
  const j = (await getJob(med))!;
  j.identityResearch = { researchText: "IDENTIFIERING (Googles AI-läge)\n### 1. Omega (90 %)\n- Status: Utgången modell (såldes under 2010-talet).\n- Motivering: Stoppad fåtölj, artikel 702.013.31.", sources: [] };
  await persist(j);
  R.settSokare(async () => ({ image_url: "https://t.test/sits-omega.jpg", page_url: "" }));
  let beskrivningTillValet: unknown = null;
  R.settBildvaljare(async (ctx: { beskrivning?: string }) => {
    beskrivningTillValet = ctx.beskrivning;
    return 0;
  });
  try {
    await medFetch(async () => {
      await applyExternalImages(med, [], { final: true });
    });
  } finally {
    R.settSokare(null);
    R.settBildvaljare(null);
  }
  assert.match(String(beskrivningTillValet), /Stoppad fåtölj/, "B:s bildval fick AI-lägets beskrivning av modellen");
  assert.equal(await registreradKandidatbild("Sits", "Omega", "g:fatolj"), null, "inte under nyckeln utan generation");
  assert.equal(await registreradKandidatbild("Sits", "Omega", "g:fatolj:702.013.31"), lokal("https://t.test/sits-omega.jpg"));
});
