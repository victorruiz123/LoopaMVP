// ─── Referensbilder och mått ur appens webbvyer (2026-10-29) ─────────────────────────────────────────────────────────────────────────────
//
// Fältprov: bildjakten (sökmotorer, 40 s) gav bara EN av fyra modeller en bild, och säljaren väntade en halv minut på det. Googles bildsök i appens dolda webbvy ger rådata
// (miniatyradress, sidtitel, storlek) på ett par sekunder; servern väljer och kontrollerar. Måttfrågan kommer efter korten. Här prövas det servern gör med rådatan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.LOOPA_JOBS_DIR = mkdtempSync(path.join(tmpdir(), "loopa-extbilder-jobs-"));
process.env.LOOPA_KANDIDATBILDER_DIR = mkdtempSync(path.join(tmpdir(), "loopa-extbilder-kb-"));
process.on("exit", () => {
  rmSync(process.env.LOOPA_JOBS_DIR!, { recursive: true, force: true });
  rmSync(process.env.LOOPA_KANDIDATBILDER_DIR!, { recursive: true, force: true });
});

const { pickImageRows, pickReferenceRows, chooseReferenceIndex, arMarknadsplats, valjReferensbild, undertypForKandidat } = await import("../server/src/externalImages.js");
const { mergeExternalSpec, specHasFacts, waitForExternalSpecs, singleVariantSpec } = await import("../server/src/externalIdentify.js");
const { settReferensKontroll, glomBildtypsavgoranden, undertypI } = await import("../server/src/candidateType.js");
const { createJob, getJob, persist } = await import("../server/src/jobStore.js");
const { applyExternalImages, applyExternalSpecs, expectExternalSpecs } = await import("../server/src/pipeline/identify.js");
const sharp = createRequire(new URL("../server/src/kandidatbild.ts", import.meta.url))("sharp") as typeof import("../server/node_modules/sharp");

const row = (alt: string, src = `https://encrypted-tbn0.gstatic.com/images?q=${encodeURIComponent(alt)}`, w = 225, h = 225) => ({ src, alt, w, h });

test("pickImageRows: titeln ska nämna modellen, får inte säga en annan typ, och märke + typ i titeln ger försteg", () => {
  const rows = [
    row("Sits Quattro Sofa - Contemporary Elegance | Tilly"),
    row("SITS Quattro Sofas, Armchairs and Corner Groups"),
    row("Sits Stella Armchair | Cookes Furniture"),
    row("Quattro fåtölj | Folkhemmet"),
    row("Sits Quattro Armchair | Snug Interiors"),
    row("Quattro fåtölj | Folkhemmet", "https://encrypted-tbn0.gstatic.com/images?q=bred", 738, 369),
  ];
  const out = pickImageRows(rows, "Quattro", "Sits", "fåtölj");
  assert.deepEqual(out, [
    rows[4].src, // märke + typ
    rows[1].src, // märke, flera typer i titeln: bildkontrollen avgör — men märket väger tyngre än typen
    rows[3].src, // bara typen, inget märke: reserv
  ]);
  assert.ok(!out.includes(rows[0].src), "'Sofa' i titeln för en fåtölj");
  assert.ok(!out.includes(rows[2].src), "titeln nämner Stella, inte Quattro");
  assert.ok(!out.includes(rows[5].src), "bredare än 1,75: en banner, inte en produktbild");
});

test("pickImageRows: dubbletter, tomma adresser, data-adresser och ren skräpdata ger inga bilder, högst sex rader", () => {
  const same = row("Impulse fåtölj | A", "https://x.test/a.jpg");
  const rows = [same, same, row("Impulse fåtölj | B", "data:image/gif;base64,AAAA"), row("Impulse fåtölj | C", ""), ...Array.from({ length: 8 }, (_, i) => row(`Impulse fåtölj | ${i}`, `https://x.test/${i}.jpg`))];
  const out = pickImageRows(rows, "Impulse", "Sits", "fåtölj");
  assert.equal(out.length, 6);
  assert.equal(new Set(out).size, 6);
  assert.deepEqual(pickImageRows(undefined, "Impulse", "Sits", "fåtölj"), []);
  assert.deepEqual(pickImageRows([null, 3, {}], "Impulse", "Sits", "fåtölj"), []);
  assert.deepEqual(pickImageRows(rows, "", "Sits", "fåtölj"), []);
});

test("mergeExternalSpec: identiteten från identifieringen, mått och material från måttsvaret, källor utan dubbletter; en tom spec räknas inte som fakta", () => {
  const base = { identity: { model: "Impulse", variant: "standard", category: "fåtölj" }, dimensions: [], materials: [], sourcesUsed: [{ url: "https://a.se/", title: null, kind: "other" }], missing: ["pris"] };
  const add = {
    identity: { model: "Sits Impulse", variant: null, category: null },
    dimensions: [{ type: "overall_width", label: "Bredd", value: 92, valueMax: null, unit: "cm", appliesTo: null, sourceUrl: null, quote: null }],
    materials: [{ component: "Ben", material: "metall", detail: null, appliesTo: null, sourceUrl: null, quote: null }],
    sourcesUsed: [{ url: "https://a.se/", title: null, kind: "other" }, { url: "https://b.se/", title: null, kind: "other" }],
    missing: ["pris", "vikt"],
  };
  const m = mergeExternalSpec(base, add) as typeof add & { identity: { model: string; variant: string; category: string } };
  assert.equal(m.identity.model, "Impulse");
  assert.equal(m.identity.variant, "standard");
  assert.equal(m.identity.category, "fåtölj");
  assert.equal(m.dimensions.length, 1);
  assert.equal(m.materials.length, 1);
  assert.deepEqual(m.sourcesUsed.map((s) => s.url), ["https://a.se/", "https://b.se/"]);
  assert.deepEqual(m.missing, ["pris", "vikt"]);
  assert.equal(specHasFacts(base), false);
  assert.equal(specHasFacts(m), true);
  assert.equal(specHasFacts(null), false);
  assert.equal(specHasFacts({ dimensions: [], materials: [{ component: "x" }] }), true);
});

// ── servern tar emot rådatan ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

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

async function jobbMedKandidater(models: string[]) {
  const job = await createJob(null);
  (job as unknown as { identity: unknown }).identity = { brand: "Sits", model: "" };
  job.identityStatus = "needs_selection";
  job.candidates = models.map((model) => ({ brand: "Sits", model, variant: null, productType: "fåtölj", confidence: "likely", distinguishingDetail: null }));
  await persist(job);
  return job.id;
}

test("applyExternalImages: första godkända bilden i svarets ordning blir kortets bild; en modell utan godkänd bild lämnas orörd; en bild som redan finns behålls", async () => {
  const id = await jobbMedKandidater(["Impulse", "Stella", "Colorado"]);
  const j0 = (await getJob(id))!;
  j0.candidates![2].imageUrl = "/api/kandidatbild/redan.jpg";
  await persist(j0);
  const impulse = [row("Impulse fåtölj | Folkhemmet", "https://t.test/ritning.jpg"), row("Sits Impulse Armchair | Snug", "https://t.test/foto.jpg")];
  const stella = [row("Stella fåtölj | A", "https://t.test/s1.jpg")];
  glomBildtypsavgoranden();
  // Bildkontrollen: bara "foto.jpg" är ett foto av en fåtölj. Ritningen (Impulse) och Stella-bilden förkastas.
  settReferensKontroll(async (_b, _f, _u, adress) => ({ typ: adress === lokal("https://t.test/foto.jpg"), katalog: null, undertyp: null }));
  try {
    await medFetch(async () => {
      const r = await applyExternalImages(id, [
        { model: "Impulse", rows: impulse },
        { model: "Stella", rows: stella },
        { model: "Colorado", rows: [row("Colorado fåtölj | A", "https://t.test/c.jpg")] },
      ]);
      assert.deepEqual(r.set, ["Impulse"]);
      assert.deepEqual(r.none, ["Stella"]);
    });
  } finally {
    settReferensKontroll(null);
    glomBildtypsavgoranden();
  }
  const job = (await getJob(id))!;
  const by = (m: string) => job.candidates!.find((c) => c.model === m)!;
  assert.equal(by("Impulse").imageUrl, lokal("https://t.test/foto.jpg"));
  assert.equal(by("Stella").imageUrl, undefined, "ingen godkänd bild: ingen ändring, så att bildjakten fortfarande får fylla i");
  assert.equal(by("Colorado").imageUrl, "/api/kandidatbild/redan.jpg", "en bild som redan finns skrivs aldrig över");
});

test("applyExternalSpecs 'failed' släpper specsteget (specPending av) utan att röra specen, och waitForExternalSpecs väntar bara medan den är på väg", async () => {
  const id = await jobbMedKandidater(["Impulse"]);
  const job = (await getJob(id))!;
  job.externalFacts = { model: "Impulse", spec: { dimensions: [], materials: [] }, links: [], at: Date.now(), specPending: true };
  await persist(job);
  const t0 = Date.now();
  const venta = waitForExternalSpecs(id, 5000);
  await new Promise((r) => setTimeout(r, 700));
  const r = await applyExternalSpecs(id, { failed: "Det verkar inte finnas något svar" });
  assert.equal(r.ok, true);
  await venta;
  assert.ok(Date.now() - t0 < 4000, "väntan släpptes av svaret, inte av tidsgränsen");
  const efter = (await getJob(id))!.externalFacts!;
  assert.equal(efter.specPending, false);
  assert.equal(specHasFacts(efter.spec), false, "en tom spec ersätter aldrig Loopas egen specsökning");
  const t1 = Date.now();
  await waitForExternalSpecs(id, 5000);
  assert.ok(Date.now() - t1 < 1000, "ingen väntan när inget är på väg");
});

test("pickImageRows: en titel utan märke måste åtminstone säga typen — annars är 'Hugo' lika gärna ett annat märkes Hugo", () => {
  const rows = [row("Hugo | Annan Butik"), row("Hugo fåtölj | Folkhemmet"), row("Sits Hugo | Annan Butik")];
  const out = pickImageRows(rows, "Hugo", "Sits", "fåtölj");
  assert.deepEqual(out, [rows[2].src, rows[1].src], "märket i titeln (10 p) går före typen i titeln (3 p); varken typ eller märke utesluts");
  assert.ok(!out.includes(rows[0].src));
});

// ── referensbilden ska visa MODELLEN, aldrig en andrahandsannons eller säljarens egen bild (2026-11-02) ─────────────────────────────────────

test("pickReferenceRows: en andrahandsmarknads titel hamnar sist och är märkt — Googles första träff på NORRNÄS var en Tradera-annons med en källarbild", () => {
  const rows = [
    row("6 köksstolar Norrnäs IKEA | Köp på Tradera (755512406)", "https://t.test/tradera.jpg"),
    row("NORRNÄS Stol, björk/Ransta grå - IKEA", "https://t.test/ikea.jpg"),
    row("IKEA Norrnäs stol begagnad | Blocket", "https://t.test/blocket.jpg"),
    row("IKEA Norrnäs stol - Pinterest", "https://t.test/pin.jpg"),
  ];
  const out = pickReferenceRows(rows, "NORRNÄS", "IKEA", "stol");
  assert.equal(out[0].src, "https://t.test/ikea.jpg");
  assert.equal(out[0].marketplace, false);
  assert.deepEqual(out.slice(1).map((r) => r.marketplace), [true, true, true], "resten är märkta, men kvar som reserv");
  assert.deepEqual(pickImageRows(rows, "NORRNÄS", "IKEA", "stol")[0], "https://t.test/ikea.jpg");
  assert.equal(arMarknadsplats("Sits Impulse fåtölj | Folkhemmet"), false);
  assert.equal(arMarknadsplats("Soffa till salu - Facebook Marketplace"), true);
});

test("chooseReferenceIndex: katalogfoto först, annars första godkända bild som inte kommer från en andrahandsmarknad, annars ingen", () => {
  const c = (local: boolean, marketplace: boolean, typ: boolean | null, katalog: boolean | null) => ({ local, marketplace, typ, katalog });
  assert.equal(chooseReferenceIndex([c(true, false, true, false), c(true, true, true, true)]), 1, "ett katalogfoto går före, också från en annan sajt");
  assert.equal(chooseReferenceIndex([c(true, true, true, false), c(true, false, true, false)]), 1, "ögonblicksbilden från en marknad hoppas över");
  assert.equal(chooseReferenceIndex([c(true, true, true, false), c(true, true, true, null)]), -1, "bara andrahandsbilder: ingen bild hellre än en annans källarbild");
  assert.equal(chooseReferenceIndex([c(false, false, true, true), c(true, false, false, true)]), -1, "kunde inte hämtas / fel typ räknas aldrig");
  assert.equal(chooseReferenceIndex([c(true, false, null, null)]), 0, "kontrollerna kunde inte göras: bilden får stå (som förut)");
  assert.equal(chooseReferenceIndex([]), -1);
});

test("applyExternalImages: en andrahandsannonsens bild väljs inte som kortets bild, ett katalogfoto väljs, och väntan släpps först vid final (eller när alla fick bild)", async () => {
  const id = await jobbMedKandidater(["Norrnäs", "Ekedalen"]);
  const j0 = (await getJob(id))!;
  j0.externalImagesPending = true;
  await persist(j0);
  const tradera = row("6 fåtöljer Norrnäs | Köp på Tradera", "https://t.test/tradera.jpg");
  const ikea = row("EKEDALEN Fåtölj - IKEA", "https://t.test/ekedalen.jpg");
  glomBildtypsavgoranden();
  settReferensKontroll(async (_b, _f, _u, adress) => ({ typ: true, katalog: adress === lokal("https://t.test/ekedalen.jpg"), undertyp: null }));
  try {
    await medFetch(async () => {
      const r1 = await applyExternalImages(id, [{ model: "Norrnäs", rows: [tradera] }, { model: "Ekedalen", rows: [ikea] }], { final: false });
      assert.deepEqual(r1.set, ["Ekedalen"]);
      assert.deepEqual(r1.none, ["Norrnäs"], "den enda träffen var en Tradera-annons: ingen bild");
      assert.equal((await getJob(id))!.externalImagesPending, true, "ett andra försök väntar: väljarskärmen väntar vidare");
      // Andra försöket: en IKEA-bild som katalogkontrollen godkänner.
      glomBildtypsavgoranden();
      settReferensKontroll(async () => ({ typ: true, katalog: true, undertyp: null }));
      const r2 = await applyExternalImages(id, [{ model: "Norrnäs", rows: [row("NORRNÄS fåtölj - IKEA katalog", "https://t.test/norrnas.jpg")] }], { final: true });
      assert.deepEqual(r2.set, ["Norrnäs"]);
    });
  } finally {
    settReferensKontroll(null);
    glomBildtypsavgoranden();
  }
  const job = (await getJob(id))!;
  assert.equal(job.externalImagesPending, false, "final släpper väntan");
  assert.equal(job.candidates!.find((c) => c.model === "Norrnäs")!.imageUrl, lokal("https://t.test/norrnas.jpg"));
  assert.equal(job.candidates!.find((c) => c.model === "Ekedalen")!.imageUrl, lokal("https://t.test/ekedalen.jpg"));
});

// ── barstol eller matstol, snabbare val, och slutbesked (2026-11-03) ────────────────────────────────────────────────────────────────────

test("undertypI / undertypForKandidat: en NORDVIKEN-BARSTOL läses ur kandidatens egna ord, aldrig ur svarets inledning — en matstol som alternativ blir inte en barstol", () => {
  assert.equal(undertypI("NORDVIKEN (Barstol / Bänkhöjd stol)"), "barstol");
  assert.equal(undertypI("https://www.ikea.com/se/sv/p/nordviken-barstol-svart-80369112/"), "barstol");
  assert.equal(undertypI("STEFAN Stol, brunsvart/Knisa grå"), null);
  const svar = [
    "Stolen på bilden är en barstol från IKEA. Här är de 4 mest sannolika förslagen:",
    "1. NORDVIKEN (Barstol / Bänkhöjd stol)",
    "   Status: Aktuell modell",
    "   Länk: https://www.ikea.com/se/sv/p/nordviken-barstol-svart-80369112/",
    "2. STEFAN (Matstol)",
    "   Säkerhet: 20 %",
  ].join("\n");
  assert.equal(undertypForKandidat(svar, "NORDVIKEN", [null, "exakt matchning"]), "barstol");
  assert.equal(undertypForKandidat(svar, "STEFAN", ["https://www.ikea.com/ph/en/p/stefan-chair-brown-black-40512089/", "ribbad rygg"]), null, "svarets inledning säger barstol, men STEFAN är en matstol");
  assert.equal(undertypForKandidat("1. NÄSINGE\n   Säkerhet: 95 %", "NÄSINGE", [null]), null);
  // En annan modells produktsida som sourceUrl säger inget om den här modellen (alternativen får ibland NORDVIKEN-sidan).
  const nordvikenSida = "https://www.ikea.com/se/sv/p/nordviken-barstol-svart-80369112/";
  assert.equal(undertypForKandidat("2. STEFAN\n   Säkerhet: 20 %", "STEFAN", ["ribbad rygg"], nordvikenSida), null);
  assert.equal(undertypForKandidat("2. NORDVIKEN\n   Säkerhet: 90 %", "NORDVIKEN", [], nordvikenSida), "barstol", "modellens egen sida räknas");
});

test("pickReferenceRows med undertyp: en titel som säger matstol utesluts, en titel som säger barstol går först", () => {
  const rows = [
    row("NORDVIKEN stol, svart - IKEA", "https://t.test/stol.jpg"),
    row("NORDVIKEN matstol svart | IKEA", "https://t.test/matstol.jpg"),
    row("NORDVIKEN barstol, svart, 75 cm - IKEA", "https://t.test/barstol.jpg"),
  ];
  const out = pickReferenceRows(rows, "NORDVIKEN", "IKEA", "stol", "barstol").map((r) => r.src);
  assert.deepEqual(out, ["https://t.test/barstol.jpg", "https://t.test/stol.jpg"], "matstolen är en annan möbel med samma namn; titeln 'stol' utan bar ligger efter och prövas av bildkontrollen");
  assert.equal(pickReferenceRows(rows, "NORDVIKEN", "IKEA", "stol").length, 3, "utan undertyp gäller bara familjen, som förut");
});

test("valjReferensbild: första godkända katalogfotot vinner så snart dess svar finns — en långsam rad längre ned väntas inte på", async () => {
  const ok = { local: true, marketplace: false, typ: true, katalog: true, undertyp: true };
  const nej = { local: true, marketplace: false, typ: true, katalog: false, undertyp: true };
  let langsamKlar = false;
  const langsam = new Promise<typeof ok>((r) => setTimeout(() => { langsamKlar = true; r(ok); }, 1500));
  const t0 = Date.now();
  const i = await valjReferensbild([Promise.resolve(nej), Promise.resolve(ok), langsam]);
  assert.equal(i, 1);
  assert.equal(langsamKlar, false, "väntade inte på rad 3");
  assert.ok(Date.now() - t0 < 500);
  // Fel undertyp (matstolen för en barstol) räknas aldrig, inte ens som reserv.
  assert.equal(await valjReferensbild([Promise.resolve({ ...ok, undertyp: false }), Promise.resolve({ ...nej, undertyp: false })]), -1);
  // Inget katalogfoto: reserven, första godkända icke-marknadsbilden.
  assert.equal(await valjReferensbild([Promise.resolve({ ...nej, marketplace: true }), Promise.resolve(nej)]), 1);
  assert.equal(await valjReferensbild([]), -1);
});

test("applyExternalImages: en matstol godkänns inte för en barstol, och final ger kort utan bild beskedet 'ingen bild' (null) i stället för att låta dem stå som 'letar'", async () => {
  const id = await jobbMedKandidater(["Nordviken", "Stefan"]);
  const j0 = (await getJob(id))!;
  (j0.identity as { brand: string }).brand = "IKEA";
  j0.candidates![0].productType = "stol";
  j0.candidates![0].undertyp = "barstol";
  j0.candidates![1].productType = "stol";
  j0.externalImagesPending = true;
  await persist(j0);
  const rader = [row("NORDVIKEN barstol, svart - IKEA", "https://t.test/nord-bar.jpg"), row("NORDVIKEN stol, svart - IKEA", "https://t.test/nord-mat.jpg")];
  glomBildtypsavgoranden();
  const fragor: Array<string | null> = [];
  // Bildkontrollen ser skillnaden: bara "nord-bar.jpg" är en barstol. Stefan har inga rader alls.
  settReferensKontroll(async (_b, _f, undertyp, adress) => {
    fragor.push(undertyp);
    return { typ: true, katalog: true, undertyp: undertyp ? adress === lokal("https://t.test/nord-bar.jpg") : null };
  });
  try {
    await medFetch(async () => {
      const r1 = await applyExternalImages(id, [{ model: "Nordviken", rows: [rader[1]] }, { model: "Stefan", rows: [] }], { final: false });
      assert.deepEqual(r1.set, [], "den enda träffen var en matstol: ingen bild hellre än fel bild");
      assert.deepEqual([...r1.none].sort(), ["Nordviken", "Stefan"]);
      const mellan = (await getJob(id))!;
      assert.equal(mellan.candidates![0].imageUrl, undefined, "inte sista listan: skärmen får vänta på ett andra försök");
      const r2 = await applyExternalImages(id, [{ model: "Nordviken", rows: [rader[0]] }], { final: true });
      assert.deepEqual(r2.set, ["Nordviken"]);
    });
  } finally {
    settReferensKontroll(null);
    glomBildtypsavgoranden();
  }
  assert.ok(fragor.every((u) => u === "barstol"), "undertypen gick med i varje bildkontroll");
  const job = (await getJob(id))!;
  assert.equal(job.candidates![0].imageUrl, lokal("https://t.test/nord-bar.jpg"));
  assert.equal(job.candidates![1].imageUrl, null, "final: Stefan fick aldrig någon bild, och det är nu ett besked");
  assert.equal(job.externalImagesPending, false);
});

// ── variant, mått, material och nypris för modellen SÄLJAREN VALDE (2026-11-02) ─────────────────────────────────────────────────────────

test("singleVariantSpec: inga varianter, ett mått per typ och ett material per del, och nyprisets källa fylls i ur länkarna — aldrig en begagnatsajt", () => {
  const links = ["https://www.tradera.com/item/1/norrnas", "https://www.ikea.com/se/sv/p/norrnas-stol-vit-60177492/", "https://example.se/katalog.pdf"];
  const spec = {
    identity: { model: "NORRNÄS", variant: "Vit stomme, grå sits" },
    variants: [{ label: "vit", differsBy: null, sourceUrl: null }, { label: "svart", differsBy: null, sourceUrl: null }],
    dimensions: [
      { type: "overall_width", value: 42, appliesTo: "vit" },
      { type: "overall_width", value: 44, appliesTo: "svart" },
      { type: "seat_height", value: 46, appliesTo: null },
    ],
    materials: [
      { component: "Klädsel", material: "Polyester, grå", appliesTo: null },
      { component: "klädsel", material: "Bomull (valbart)", appliesTo: "annan färg" },
      { component: "Stomme", material: "Massiv bok, vitlackad", appliesTo: "vit" },
    ],
    retailPriceSek: 595,
    retailPriceSourceUrl: null,
    sourcesUsed: [],
  };
  const out = singleVariantSpec(spec, "NORRNÄS", "IKEA", links) as typeof spec & { retailPriceSourceUrl: string | null; sourcesUsed: Array<{ url: string }> };
  assert.deepEqual(out.variants, []);
  assert.deepEqual(out.dimensions.map((d) => [d.type, d.value, d.appliesTo]), [["overall_width", 42, null], ["seat_height", 46, null]], "första raden per mått, utan appliesTo");
  assert.deepEqual(out.materials.map((m) => [m.component, m.material, m.appliesTo]), [["Klädsel", "Polyester, grå", null], ["Stomme", "Massiv bok, vitlackad", null]]);
  assert.equal(out.retailPriceSek, 595);
  assert.equal(out.retailPriceSourceUrl, "https://www.ikea.com/se/sv/p/norrnas-stol-vit-60177492/", "modellens egen sida, aldrig Tradera");
  assert.ok(out.sourcesUsed.some((s) => s.url === out.retailPriceSourceUrl), "priset hänförs till en källa som ingår i sourcesUsed");
  // Svaret pekade själv ut en länk för priset: den behålls.
  assert.equal((singleVariantSpec({ ...spec, retailPriceSourceUrl: links[2] }, "NORRNÄS", "IKEA", links) as typeof out).retailPriceSourceUrl, links[2]);
  // Bara en begagnatsajt att peka på: priset får ingen källa (specsteget kastar det då).
  assert.equal((singleVariantSpec(spec, "NORRNÄS", "IKEA", [links[0]]) as typeof out).retailPriceSourceUrl, null);
  // Inget pris: ingen källa heller.
  assert.equal((singleVariantSpec({ ...spec, retailPriceSek: null }, "NORRNÄS", "IKEA", links) as typeof out).retailPriceSourceUrl, null);
});

test("expectExternalSpecs sätter väntan på svaret för den valda modellen (och ingen gissad variantlista); ett jobb som inte är ett appjobb lämnas orört", async () => {
  const id = await jobbMedKandidater(["Impulse", "Stella"]);
  assert.equal(await expectExternalSpecs(id, "Stella"), false, "inget appjobb: servern gör som förut");
  assert.equal((await getJob(id))!.externalFacts, undefined);
  const j = (await getJob(id))!;
  j.externalIdentify = true;
  j.externalFacts = { model: "Impulse", spec: { identity: { model: "Impulse" } }, links: ["https://sits.se/impulse"], at: 1 };
  await persist(j);
  assert.equal(await expectExternalSpecs(id, "Stella"), true);
  const efter = (await getJob(id))!;
  assert.equal(efter.externalFacts!.model, "Stella");
  assert.equal(efter.externalFacts!.specPending, true);
  assert.deepEqual(efter.externalFacts!.spec, {}, "förslag 1:s identitet ärvs inte av en annan modell");
  assert.deepEqual(efter.externalFacts!.links, ["https://sits.se/impulse"]);
  assert.deepEqual(efter.variantOptions, [], "AI-läget avgör varianten: ingen variantfråga till säljaren");
});

test("applyExternalSpecs: ett sent svar på en TIDIGARE fråga (säljaren hann byta modell) varken fyller i specen eller släpper väntan", async () => {
  const id = await jobbMedKandidater(["Impulse", "Stella"]);
  const j = (await getJob(id))!;
  j.externalIdentify = true;
  j.externalFacts = { model: "Stella", spec: {}, links: [], at: Date.now(), specPending: true };
  await persist(j);
  const r = await applyExternalSpecs(id, { failed: "sent svar", model: "Impulse" });
  assert.equal(r.ok, false);
  assert.equal((await getJob(id))!.externalFacts!.specPending, true, "väntan på Stella pågår fortfarande");
  const ok = await applyExternalSpecs(id, { failed: "inget svar", model: "STELLA" });
  assert.equal(ok.ok, true);
  assert.equal((await getJob(id))!.externalFacts!.specPending, false);
});

// ── testläget: bara identifiering och måttsökning (2026-10-30) ──────────────────────────────────────────────────────────────────────────

test("identifyOnly: jobbet startar utan skickbedömning, och priset hoppas över utan att räknas som ett fall", async () => {
  const { createConditionJob } = await import("../server/src/jobStore.js").then(() => import("../server/src/jobCreate.js"));
  const out = await createConditionJob(
    { images: [{ dataUrl: `data:image/jpeg;base64,${JPEG.toString("base64")}`, viewLabel: null }], brand: "Sits", model: null, externalIdentify: true, identifyOnly: true },
    null,
    null,
    false,
    true, // skipGrading, så som handleCreateJob sätter den för ett identifyOnly-jobb
  );
  assert.ok(!("error" in out), JSON.stringify(out));
  const job = (await getJob((out as { jobId: string }).jobId))!;
  assert.equal(job.externalIdentify, true);
  assert.equal(job.identityStatus, "identifying");
  assert.equal(job.tasks?.condition?.status, "cancelled", "ingen skickbedömning startades");
  assert.ok(!job.result, "inget skickresultat");
  // Jobbets klocka (jobCreate.ts) tickar tills jobbet är klart; utan det här håller den testprocessen vid liv.
  job.progress = { stage: "done", message: "klart" };
  await persist(job);
  await new Promise((r) => setTimeout(r, 1500));
});
