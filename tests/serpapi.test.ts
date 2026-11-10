// ─── SerpApi-flödet: samma frågor som det lokala systemet, samma flöde, nyckeln aldrig i ett fel (2026-11-05) ───────────────────────────────────────────────────
//
// Det lokala systemet (scripts/loopa-app-prototype/main.js) frågar Googles AI-läge i en Electron-webbvy. SerpApi-flödet (server/src/serpapi/) frågar samma AI-läge via SerpApi. För att mätningen
// ska säga något måste frågorna vara DE SAMMA och flödet runt dem detsamma: det prövas här mot en låtsas-SerpApi. Inget går ut på nätet.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "test-nyckel-som-aldrig-far-synas-9f3a";
process.env.SERPAPI_API_KEY = KEY;
process.env.SERPAPI_PUBLIC_URL = "https://loopa-test.example";
process.env.SERPAPI_SKIP_REACHABILITY = "1";
process.env.LOOPA_SERPAPI_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "loopa-serpapi-log-"));
process.on("exit", () => fs.rmSync(process.env.LOOPA_SERPAPI_LOG_DIR!, { recursive: true, force: true }));

const prompts = await import("../server/src/serpapi/prompts.js");
const render = await import("../server/src/serpapi/render.js");
const ext = await import("../server/src/externalImages.js");
const ctype = await import("../server/src/candidateType.js");
const { http, serpApiSearch, SerpApiError } = await import("../server/src/serpapi/client.js");
const session = await import("../server/src/serpapi/session.js");
const aimode = await import("../server/src/serpapi/aimode.js");

const ROOT = path.resolve(import.meta.dirname, "..");
// Frågorna genereras ur appskalets main.js (scripts/loopa-app-prototype/, ett lokalt verktyg som inte ligger i repot). Finns filen, jämförs frågorna med den ord för ord; annars hoppas jämförelsen över
// och server/src/serpapi/prompts.ts (den incheckade, genererade filen) gäller som den är.
const mainJsPath = path.join(ROOT, "scripts/loopa-app-prototype/main.js");
const mainJs = fs.existsSync(mainJsPath) ? fs.readFileSync(mainJsPath, "utf8") : "";
const harMainJs = mainJs.length > 0;

// --- Samma frågor som main.js ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Kör main.js:s egna frågefunktioner (utan Electron): koden mellan "FRÅGORNA TILL AI-LÄGET" och layout(), plus undertypUr. */
function lokala() {
  const bit = (fran: string, till: string) => {
    const a = mainJs.indexOf(fran);
    const b = mainJs.indexOf(till, a);
    assert.ok(a >= 0 && b > a, `hittar inte ${fran}`);
    return mainJs.slice(a, b);
  };
  const kod = bit("const TYP_ORD", "function layout()") + "\n" + bit("function undertypUr", "/**\n * BILDSÖKNINGARNA STARTAR TIDIGT");
  return new Function(kod + "\nreturn { PROMPT, MORE_PROMPT, SPEC_PROMPT, countProposals, proposalNames, undertypUr };")() as {
    PROMPT: typeof prompts.PROMPT;
    MORE_PROMPT: typeof prompts.MORE_PROMPT;
    SPEC_PROMPT: typeof prompts.SPEC_PROMPT;
    countProposals: typeof prompts.countProposals;
    proposalNames: typeof prompts.proposalNames;
    undertypUr: typeof prompts.undertypUr;
  };
}

test("frågorna är ord för ord main.js: identifieringen, fler förslag och måttfrågan, för varje möbeltyp", { skip: !harMainJs && "main.js (lokalt verktyg) finns inte här" }, () => {
  const L = lokala();
  const typer = [null, "fåtölj", "soffa", "stol", "bord", "säng", "annat", "okänd-typ"];
  for (const brand of ["Sits", "IKEA", "", null]) {
    for (const typ of typer) {
      assert.equal(prompts.PROMPT(brand, typ), L.PROMPT(brand, typ), `PROMPT ${brand}/${typ}`);
      assert.equal(prompts.MORE_PROMPT(brand, typ, ["Impulse", "Brandon"]), L.MORE_PROMPT(brand, typ, ["Impulse", "Brandon"]), `MORE ${brand}/${typ}`);
      assert.equal(prompts.MORE_PROMPT(brand, typ, []), L.MORE_PROMPT(brand, typ, []), `MORE tom ${brand}/${typ}`);
      assert.equal(prompts.SPEC_PROMPT(brand, "Impulse", typ), L.SPEC_PROMPT(brand, "Impulse", typ), `SPEC ${brand}/${typ}`);
    }
  }
});

test("namnläsningen är main.js: proposalNames, countProposals och undertypUr ger samma som skalet på samma svar", { skip: !harMainJs && "main.js (lokalt verktyg) finns inte här" }, () => {
  const L = lokala();
  const svar = [
    "1. Sits Impulse – säkerhet 80 %\n2. **Sits Brandon** – aktuell\n3. Stella\n4. Sits Quattro",
    "1⇥NORDVIKEN Barstol (svart)⇥Aktuell⇥100 %\n2⇥INGEMAR Barstol⇥Utgången⇥60 %",
    "Sits Impulse\nSannolikhet: hög\n\nBRANDON\nSäkerhet: medel\n\nAI kan göra misstag\nSITS Quattro Sofas, Armchairs",
    "1. RÄVSTEN\n2. NORRÅKER\n=== FLER FÖRSLAG (svar på en uppföljningsfråga) ===\n3. INGOLF\n4. BERGMUND",
  ];
  for (const s of svar) {
    for (const brand of ["Sits", "IKEA", ""]) {
      assert.deepEqual(prompts.proposalNames(s, brand), L.proposalNames(s, brand));
      assert.equal(prompts.countProposals(s, brand), L.countProposals(s, brand));
    }
  }
  assert.equal(prompts.undertypUr("1. NORDVIKEN (Barstol)", "NORDVIKEN"), L.undertypUr("1. NORDVIKEN (Barstol)", "NORDVIKEN"));
  assert.equal(prompts.undertypUr("1. NORDVIKEN (Matstol)", "NORDVIKEN"), L.undertypUr("1. NORDVIKEN (Matstol)", "NORDVIKEN"));
});

// --- Från SerpApis JSON till text -----------------------------------------------------------------------------------------------------------------------------------------------------

test("markdownToText: tabell blir tabbrader (som sidans innerText), länktext utan adress, ingen fetstil eller rubrikmarkering", () => {
  const md = "### Förslag\n\n| # | Modell | Status |\n|---|:---:|---|\n| 1 | **NORDVIKEN** Barstol | Aktuell |\n| 2 | [INGEMAR](https://www.ikea.com/se/sv/p/ingemar-12345/) | Utgången |\n\nText med `kod`.";
  const t = render.markdownToText(md);
  assert.ok(!t.includes("|") && !t.includes("**") && !t.includes("###") && !t.includes("https://"));
  assert.ok(t.includes("1\tNORDVIKEN Barstol\tAktuell"));
  assert.ok(t.includes("2\tINGEMAR\tUtgången"));
  assert.ok(!/---/.test(t), "skiljeraden ska bort");
  assert.deepEqual(prompts.proposalNames(t, "IKEA"), ["NORDVIKEN", "INGEMAR"]);
});

test("RIKTIGA SVAR från SerpApi (2026-11-07, SÖDERHAMN): inga escapes, inga [n], ingen References-lista, och namnläsningen hittar fyra förslag i varje", () => {
  const dir = fileURLToPath(new URL("./fixtures/serpapi/", import.meta.url));
  const svar = (f: string) => render.answerText(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  for (const f of ["aimode-forsta.json", "aimode-identifiering.json", "aimode-fler-forslag.json"]) {
    const t = svar(f);
    assert.ok(!/\\[()\-.]/.test(t), `${f}: backslash kvar`);
    assert.ok(!/\[\d+\]/.test(t), `${f}: källhänvisning kvar`);
    assert.ok(!/^References$/m.test(t), `${f}: References-listan kvar`);
    assert.equal(prompts.countProposals(t, "IKEA"), 4, `${f}: ${prompts.proposalNames(t, "IKEA").join(", ")}`);
  }
  assert.equal(prompts.proposalNames(svar("aimode-identifiering.json"), "IKEA")[0], "SÖDERHAMN");
});

test("SVAR UTAN location (2026-11-07): Impulse först, ingen UI-text i namnen, och de riktiga produktadresserna hämtas ur text_blocks (references saknas)", () => {
  const dir = fileURLToPath(new URL("./fixtures/serpapi/", import.meta.url));
  for (const f of ["aimode-utan-plats-a1.json", "aimode-utan-plats-c2.json"]) {
    const resp = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.equal(resp.references, undefined, `${f}: förutsättningen är ett svar utan references`);
    const t = render.answerText(resp);
    assert.ok(!/Öppna dialogrutan/.test(t), `${f}: gränssnittstext kvar`);
    const namn = prompts.proposalNames(t, "Sits");
    assert.equal(namn[0], "Impulse", `${f}: ${namn.join(", ")}`);
    assert.ok(!namn.some((n: string) => /Öppna/.test(n)), `${f}: ${namn.join(", ")}`);
    const links = render.collectLinks(resp, t);
    assert.ok(links.some((l: string) => /tibergsmobler\.se\/.*impulse/i.test(l)), `${f}: ingen Impulse-adress bland ${links.join(" ")}`);
    assert.ok(links.every((l: string) => !/google\.com/.test(new URL(l).hostname)), `${f}: Googles egna adresser ska bort`);
  }
});

// --- Referensbilder: vem visar bilden? (2026-11-07) ---------------------------------------------------------------------------------------------------------------------------------

type BildRad = { src: string; alt: string; w: number; h: number; source?: string; page?: string };
const bildrader = JSON.parse(fs.readFileSync(path.join(fileURLToPath(new URL("./fixtures/serpapi/", import.meta.url)), "bildrader.json"), "utf8")) as Record<string, { brand: string; model: string; typ: string; undertyp: string | null; rows: BildRad[] }>;
const valj = (q: string) => {
  const c = bildrader[q];
  return { c, picks: ext.pickReferenceRows(c.rows, c.model, c.brand, c.typ, c.undertyp) as Array<{ src: string; marketplace: boolean }> };
};
const radFor = (c: { rows: BildRad[] }, src: string) => c.rows.find((r) => r.src === src)!;

test("RIKTIGA BILDTRÄFFAR, NORDVIKEN: prisjämföraren PriceRunner (fel möbel på bilden) väljs aldrig, och alla val kommer från IKEA självt (29 av 40 träffar gjorde det)", () => {
  const { c, picks } = valj("IKEA NORDVIKEN barstol");
  assert.ok(picks.length >= 3);
  for (const p of picks) {
    const r = radFor(c, p.src);
    assert.ok(!/pricerunner/i.test(`${r.source} ${r.page}`), `PriceRunner valdes: ${r.alt}`);
    assert.equal(r.source, "IKEA");
  }
});

test("RIKTIGA BILDTRÄFFAR, Palma: Offecct-fåtöljen (…-palma-offecct, titeln utan Sits) väljs inte; varje val har Sits i titeln, i adressen eller som sajt", () => {
  const { c, picks } = valj("Sits Palma fåtölj");
  for (const p of picks) {
    const r = radFor(c, p.src);
    assert.ok(!/offecct/i.test(r.page ?? ""), `Offecct valdes: ${r.alt} ${r.page}`);
    assert.ok(/sits/i.test(`${r.alt} ${r.page} ${r.source}`), `inget märke på valet: ${r.alt} ${r.page}`);
  }
});

test("RIKTIGA BILDTRÄFFAR, Jenny och Impulse: en återförsäljares produktrad ('… - Sits' hos Vision of Home) går före tillverkarens kollektionssida", () => {
  for (const q of ["Sits Jenny fåtölj", "Sits Impulse fåtölj"]) {
    const { c, picks } = valj(q);
    assert.ok(picks.length > 0, q);
    const r = radFor(c, picks[0].src);
    assert.ok(!/collection|kollektion/i.test(r.alt), `${q}: kollektionssida först: ${r.alt}`);
    assert.ok(/sits/i.test(r.alt), `${q}: ${r.alt}`);
  }
});

test("RIKTIGA BILDTRÄFFAR, Quattro och Colin: bara andra märkens möbler med samma namn finns, och då blir det ingen bild (ingen bild hellre än fel bild)", () => {
  assert.deepEqual(valj("Sits Quattro fåtölj").picks, []);
  assert.deepEqual(valj("Sits Colin fåtölj").picks, []);
});

test("bildurval: märket måste stå PÅ RADEN (titel, adress eller sajt): en återförsäljare vars titel saknar märket duger inte, ens när sajten visat märket på en annan rad (Vision of Home sålde \"Nova | Swedese\"); prisjämförare aldrig; rader utan sajt som förut", () => {
  const rad = (alt: string, n: number, source?: string, page?: string): BildRad => ({ src: `https://t.test/${n}.jpg`, alt, w: 600, h: 600, ...(source ? { source } : {}), ...(page ? { page } : {}) });
  const rows = [
    rad("Brandon Fåtölj | Folkhemmet", 1, "Folkhemmet", "https://folkhemmet.com/products/brandon-fatolj"),
    rad("Hugo Fåtölj - Sits", 2, "Folkhemmet", "https://folkhemmet.com/sits/hugo"), // bevisar att Folkhemmet säljer Sits
    rad("Brandon Fåtölj | Annan Butik", 3, "Annan Butik", "https://annanbutik.se/brandon"), // inget belägg
    rad("Sits Brandon fåtölj (1 butiker) se bästa priserna", 4, "PriceRunner", "https://www.pricerunner.se/pl/1/brandon"),
    rad("Brandon Fåtölj | Folkhemmet", 5),
  ];
  const ut = ext.pickReferenceRows(rows, "Brandon", "Sits", "fåtölj").map((r: { src: string }) => r.src);
  assert.ok(!ut.includes("https://t.test/1.jpg"), "märket saknas på raden: ingen bild hellre än fel märke, även hos en återförsäljare som visat märket annars");
  assert.ok(!ut.includes("https://t.test/3.jpg"), "sajt utan belägg");
  assert.ok(!ut.includes("https://t.test/4.jpg"), "prisjämförare");
  assert.ok(ut.includes("https://t.test/5.jpg"), "rad utan sajtuppgift: oförändrat beteende (skalets rader)");
});

test("bildkontrollen: ett tillfälligt fel ('okänt') ger ett omförsök, och 'okänt' stannar inte i cachen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopa-kandbild-"));
  const prevDir = process.env.LOOPA_KANDIDATBILDER_DIR;
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.LOOPA_KANDIDATBILDER_DIR = dir;
  process.env.GEMINI_API_KEY = "test-nyckel-anvands-inte";
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  fs.writeFileSync(path.join(dir, a + ".jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  fs.writeFileSync(path.join(dir, b + ".jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  try {
    let anrop = 0;
    ctype.settReferensKontroll(async () => (++anrop === 1 ? { typ: null, katalog: null, undertyp: null } : { typ: true, katalog: true, undertyp: null }));
    const svar = await ctype.bedomReferensbild(`/api/kandidatbild/${a}.jpg`, "stol", null);
    assert.deepEqual(svar, { typ: true, katalog: true, undertyp: null });
    assert.equal(anrop, 2, "ett omförsök");
    // Två fel i rad: svaret är okänt, och nästa fråga om samma bild ställs på nytt (inget permanent okänt).
    anrop = 0;
    ctype.settReferensKontroll(async () => {
      anrop += 1;
      return { typ: null, katalog: null, undertyp: null };
    });
    await ctype.bedomReferensbild(`/api/kandidatbild/${b}.jpg`, "stol", null);
    const efter = anrop;
    await ctype.bedomReferensbild(`/api/kandidatbild/${b}.jpg`, "stol", null);
    assert.ok(anrop > efter, "okänt cachades inte");
  } finally {
    ctype.settReferensKontroll(null);
    if (prevDir === undefined) delete process.env.LOOPA_KANDIDATBILDER_DIR;
    else process.env.LOOPA_KANDIDATBILDER_DIR = prevDir;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("blocksToText: stycken, rubriker, numrerade listor, nästlade listor och tabeller", () => {
  const t = render.blocksToText([
    { type: "heading", snippet: "Förslag" },
    { type: "paragraph", snippet: "Fåtöljen kan vara:" },
    { type: "list", list_type: "ordered", list: [{ snippet: "Sits Impulse", list: [{ snippet: "aktuell" }] }, { title: "Sits Brandon", snippet: "utgången" }] },
    { type: "table", table: [["Modell", "Säkerhet"], ["Impulse", "80 %"]] },
  ]);
  assert.equal(t, "Förslag\n\nFåtöljen kan vara:\n\n1. Sits Impulse\n  1. aktuell\n2. Sits Brandon: utgången\n\nModell\tSäkerhet\nImpulse\t80 %");
});

test("collectLinks: källkorten först, Googles egna och startsidor bort, skiljetecken bort, samma regler som extract-links.js", () => {
  const links = render.collectLinks(
    {
      references: [{ link: "https://www.sits.se/sv/produkter/impulse/" }, { link: "https://www.google.com/search?q=x" }, { link: "https://www.sits.se/" }, { link: "https://folkhemmet.com/impulse-fatolj." }],
      shopping_results: [{ product_link: "https://www.google.com/shopping/product/1" }],
      reconstructed_markdown: "Se [Impulse](https://www.ikea.com/se/sv/p/impulse-1/) och https://www.facebook.com/x/y samt https://www.nk.se/impulse),",
    },
    "https://www.sits.se/sv/produkter/impulse/ igen",
  );
  assert.deepEqual(links, ["https://www.sits.se/sv/produkter/impulse/", "https://folkhemmet.com/impulse-fatolj", "https://www.ikea.com/se/sv/p/impulse-1/", "https://www.nk.se/impulse"]);
});

test("imageRows: samma form som skalets rader; små bilder och bilder utan http-adress bort", () => {
  const rows = render.imageRows({
    images_results: [
      { thumbnail: "https://encrypted-tbn0.gstatic.com/a", title: "Impulse Fåtölj | Folkhemmet", original_width: 800, original_height: 800 },
      { thumbnail: "https://encrypted-tbn0.gstatic.com/b", title: "liten", original_width: 50, original_height: 50 },
      { thumbnail: "data:image/png;base64,AAAA", title: "inline", original_width: 500, original_height: 500 },
      { original: "https://example.com/c.jpg", title: "utan miniatyr", original_width: 600, original_height: 400 },
    ],
  });
  assert.deepEqual(
    rows.map((r) => [r.src, r.alt, r.w, r.h]),
    [
      ["https://encrypted-tbn0.gstatic.com/a", "Impulse Fåtölj | Folkhemmet", 800, 800],
      ["https://example.com/c.jpg", "utan miniatyr", 600, 400],
    ],
  );
});

// --- Flödet mot en låtsas-SerpApi -------------------------------------------------------------------------------------------------------------------------------------------------------

interface Call {
  params: Record<string, string>;
}
let calls: Call[] = [];
let onAi: (params: Record<string, string>, n: number) => unknown;
let aiN = 0;

const LONG = "Här är min bedömning utifrån bilden och de källor jag hittade, med den mest sannolika modellen först och hur säker jag är på varje förslag. ".repeat(2);
const aiBody = (md: string, token: string | null, refs: Array<{ title: string; link: string; source?: string }> = []) => ({
  search_metadata: { id: `sök-${aiN}`, status: "Success", google_url: "https://www.google.com/search?udm=50" },
  reconstructed_markdown: md,
  references: refs,
  ...(token ? { subsequent_request_token: token } : {}),
});

beforeEach(() => {
  session.resetForTests();
  calls = [];
  aiN = 0;
  process.env.SERPAPI_DAILY_CAP = "100";
  http.sleep = async () => undefined;
  http.fetch = (async (input: unknown) => {
    const u = new URL(String(input));
    const params = Object.fromEntries(u.searchParams.entries());
    calls.push({ params });
    if (params.engine === "google_ai_mode") {
      aiN += 1;
      const r = onAi(params, aiN);
      return new Response(JSON.stringify(r), { status: 200 });
    }
    if (params.engine === "google_images") {
      return new Response(JSON.stringify({ search_metadata: { id: "bild", status: "Success" }, images_results: [{ thumbnail: `https://encrypted-tbn0.gstatic.com/${encodeURIComponent(params.q)}`, title: `${params.q} | Butiken`, original_width: 900, original_height: 900 }] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});

const dataUrl = `data:image/jpeg;base64,${Buffer.from("fake-jpeg-bytes").toString("base64")}`;
const images = () => calls.filter((c) => c.params.engine === "google_images");
const ai = () => calls.filter((c) => c.params.engine === "google_ai_mode");

test("identify + askSpecs: exakt skalets frågor, bilden bara i första frågan, uppföljningen fortsätter med token, bildsökningarna är skalets", async () => {
  onAi = (_p, n) =>
    n === 1
      ? aiBody(`${LONG}\n\n1. **Sits Impulse** – säkerhet 80 %, aktuell\n2. Sits Brandon – säkerhet 60 %\n3. Sits Stella – säkerhet 40 %, utgången\n4. Sits Quattro – säkerhet 30 %`, "tok1", [
          { title: "Impulse Fåtölj | Folkhemmet", link: "https://folkhemmet.com/impulse-fatolj/", source: "Folkhemmet" },
        ])
      : aiBody(`${LONG}\nVariant: vit stomme\nNypris: 10 490 kr\nLänk: https://www.sits.se/sv/produkter/impulse/`, "tok2", [{ title: "Impulse | Sits", link: "https://www.sits.se/sv/produkter/impulse/" }]);

  const { sid } = await aimode.prepare("anv-1", [dataUrl]);
  const s = session.getSession(sid, "anv-1")!;
  assert.match(s.imageUrl!, /^https:\/\/loopa-test\.example\/api\/serpapi\/img\/[A-Za-z0-9_-]{20,}\.jpg$/);
  assert.equal(session.getSession(sid, "annan"), null, "en annan inloggning når inte samtalet");
  assert.equal(session.getImage(s.imageName!)!.buf.toString(), "fake-jpeg-bytes");

  const idn = await aimode.identify(s, "Sits", "fåtölj");
  assert.equal(ai().length, 1, "fyra förslag: ingen fler-förslag-fråga");
  const p1 = ai()[0].params;
  assert.equal(p1.q, prompts.PROMPT("Sits", "fåtölj"));
  assert.equal(p1.image_url, s.imageUrl);
  assert.equal(p1.subsequent_request_token, undefined);
  assert.equal(p1.continuable, "true");
  assert.equal(p1.no_cache, "true");
  assert.equal(p1.hl, "sv");
  assert.equal(p1.gl, "se");
  assert.ok(idn.answer.includes("Sits Impulse"));
  assert.ok(idn.answer.includes("Källor som AI-läget anger:\n- Impulse Fåtölj | Folkhemmet"));
  assert.ok(idn.links.includes("https://folkhemmet.com/impulse-fatolj/"));

  // Bildsökningarna startade redan under identify (som skalets prefetch): en per namngiven modell, med skalets sökord.
  const groups = await aimode.findImages(s, "Sits", [
    { model: "Impulse", productType: "fåtölj" },
    { model: "Brandon", productType: "fåtölj" },
  ]);
  assert.deepEqual(
    images().map((c) => c.params.q).sort(),
    ["Sits Brandon fåtölj produktbild framifrån", "Sits Impulse fåtölj produktbild framifrån", "Sits Quattro fåtölj produktbild framifrån", "Sits Stella fåtölj produktbild framifrån"],
    "fyra sökningar, inga dubbletter när webben frågar efter samma modeller; kedjans fråga har \"produktbild framifrån\" (2026-11-09)",
  );
  assert.equal(groups[0].model, "Impulse");
  assert.equal(groups[0].rows.length, 1);
  const retry = await aimode.findImages(s, "Sits", [{ model: "Impulse", productType: "fåtölj", retry: true }]);
  assert.equal(images().at(-1)!.params.q, "Sits Impulse fåtölj produktbild framifrån", "kedjan har en enda bildsökning: ingen särskild fråga vid andra försöket");
  assert.equal(retry[0].rows.length, 1);

  const sp = await aimode.askSpecs(s, "Sits", "Impulse", "fåtölj");
  const p2 = ai()[1].params;
  assert.equal(p2.q, prompts.SPEC_PROMPT("Sits", "Impulse", "fåtölj"));
  assert.equal(p2.subsequent_request_token, "tok1");
  assert.equal(p2.image_url, undefined, "bilden följer med samtalet, den skickas inte igen");
  assert.ok(sp.answer.includes("Nypris: 10 490 kr"));
  // Länkarna är samtalets alla, som sidans länkar i skalet: identifieringens och måttsvarets.
  assert.deepEqual(sp.links, ["https://folkhemmet.com/impulse-fatolj/", "https://www.sits.se/sv/produkter/impulse/"]);
  assert.equal(s.token, "tok2");
  // Allt som skickades är sparat för granskning, och loggen innehåller aldrig nyckeln.
  const dir = path.join(process.env.LOOPA_SERPAPI_LOG_DIR!, s.id);
  const filer = fs.readdirSync(dir);
  assert.ok(filer.length >= 7);
  for (const f of filer) assert.ok(!fs.readFileSync(path.join(dir, f), "utf8").includes(KEY), `${f} innehåller nyckeln`);
});

test("färre än fyra förslag: MORE_PROMPT med de redan nämnda namnen, samma samtal, svaret får skalets skiljelinje", async () => {
  onAi = (_p, n) =>
    n === 1
      ? aiBody(`${LONG}\n1. Sits Impulse – 80 %\n2. Sits Brandon – 60 %`, "tok1")
      : aiBody(`${LONG}\n1. Sits Stella – 40 %\n2. Sits Quattro – 30 %`, "tok2");
  const { sid } = await aimode.prepare("anv-1", [dataUrl]);
  const s = session.getSession(sid, "anv-1")!;
  const idn = await aimode.identify(s, "Sits", "fåtölj");
  assert.equal(ai().length, 2);
  assert.equal(ai()[1].params.q, prompts.MORE_PROMPT("Sits", "fåtölj", ["Impulse", "Brandon"]));
  assert.equal(ai()[1].params.subsequent_request_token, "tok1");
  assert.ok(idn.answer.includes(aimode.MORE_SEPARATOR));
  assert.deepEqual(prompts.proposalNames(idn.answer, "Sits"), ["Impulse", "Brandon", "Stella", "Quattro"]);
});

test("ett svar utan nya modeller läggs inte till och ger ingen tredje fråga", async () => {
  onAi = (_p, n) => (n === 1 ? aiBody(`${LONG}\n1. Sits Impulse – 80 %\n2. Sits Brandon – 60 %`, "tok1") : aiBody(`${LONG}\n1. Sits Impulse – 80 %`, "tok2"));
  const { sid } = await aimode.prepare("anv-1", [dataUrl]);
  const s = session.getSession(sid, "anv-1")!;
  const idn = await aimode.identify(s, "Sits", "fåtölj");
  assert.equal(ai().length, 2);
  assert.ok(!idn.answer.includes("FLER FÖRSLAG"));
});

test("måttfrågan: två försök när AI-läget inte svarar, samma token båda gångerna", async () => {
  onAi = (_p, n) => {
    if (n === 1) return aiBody(`${LONG}\n1. A1 – 80 %\n2. B2 – 60 %\n3. C3 – 40 %\n4. D4 – 30 %`, "tok1");
    if (n === 2) return aiBody("Det verkar inte finnas något svar för den här sökningen", null);
    return aiBody(`${LONG}\nVariant: vit\nNypris: 10 490 kr`, "tok3");
  };
  const { sid } = await aimode.prepare("anv-1", [dataUrl]);
  const s = session.getSession(sid, "anv-1")!;
  await aimode.identify(s, "Sits", "fåtölj");
  const sp = await aimode.askSpecs(s, "Sits", "Impulse", "fåtölj");
  assert.ok(sp.answer.includes("Nypris"));
  assert.equal(ai().length, 3);
  assert.equal(ai()[1].params.subsequent_request_token, "tok1");
  assert.equal(ai()[2].params.subsequent_request_token, "tok1", "ett misslyckat svar bryter inte samtalet");
});

test("två misslyckade försök kastar: webben får då sin vanliga reserv (Loopas egen specsökning)", async () => {
  onAi = (_p, n) => (n === 1 ? aiBody(`${LONG}\n1. A1 – 80 %\n2. B2 – 60 %\n3. C3 – 40 %\n4. D4 – 30 %`, "tok1") : aiBody("kort", null));
  const { sid } = await aimode.prepare("anv-1", [dataUrl]);
  const s = session.getSession(sid, "anv-1")!;
  await aimode.identify(s, "Sits", "fåtölj");
  await assert.rejects(() => aimode.askSpecs(s, "Sits", "Impulse", "fåtölj"), /måttfrågan gav inget svar/);
});

test("ingen token i första svaret: uppföljningen kastar ett begripligt fel i stället för att starta om utan bilden", async () => {
  onAi = () => aiBody(`${LONG}\n1. A1 – 80 %\n2. B2 – 60 %\n3. C3 – 40 %\n4. D4 – 30 %`, null);
  const { sid } = await aimode.prepare("anv-1", [dataUrl]);
  const s = session.getSession(sid, "anv-1")!;
  await aimode.identify(s, "Sits", "fåtölj");
  // Samma besked som skalet ger när det inte finns något samtal att fortsätta på; ingen ny fråga går iväg.
  await assert.rejects(() => aimode.askSpecs(s, "Sits", "Impulse", "fåtölj"), /inget samtal att fortsätta på/);
  assert.equal(ai().length, 1);
});

test("prepare utan publik adress säger vad som ska sättas", async () => {
  const old = process.env.SERPAPI_PUBLIC_URL;
  delete process.env.SERPAPI_PUBLIC_URL;
  delete process.env.LOOPA_PUBLIC_URL;
  try {
    await assert.rejects(() => aimode.prepare("anv-1", [dataUrl]), /SERPAPI_PUBLIC_URL/);
  } finally {
    process.env.SERPAPI_PUBLIC_URL = old;
  }
});

// --- Nyckeln, felen och taken ------------------------------------------------------------------------------------------------------------------------------------------------------

test("nyckeln skickas bara till SerpApi och finns aldrig i ett felmeddelande", async () => {
  http.fetch = (async (input: unknown) => {
    assert.ok(String(input).includes(`api_key=${KEY}`));
    return new Response(JSON.stringify({ error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" }), { status: 401 });
  }) as typeof fetch;
  await assert.rejects(
    () => serpApiSearch({ engine: "google_images", q: "x" }),
    (e: Error) => e instanceof SerpApiError && e.status === 401 && !e.message.includes(KEY) && /401/.test(e.message),
  );
  // Nätfel: fetch-felet nämner ofta adressen (och därmed nyckeln); texten byts mot en egen.
  http.fetch = (async (input: unknown) => {
    throw new TypeError(`fetch failed for ${String(input)}`);
  }) as typeof fetch;
  await assert.rejects(
    () => serpApiSearch({ engine: "google_images", q: "x" }),
    (e: Error) => !e.message.includes(KEY) && /nå SerpApi/.test(e.message),
  );
});

test("5xx och 429 försöks en gång till; 4xx aldrig", async () => {
  let n = 0;
  http.fetch = (async () => {
    n += 1;
    return n === 1 ? new Response(JSON.stringify({ error: "tillfälligt" }), { status: 503 }) : new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await serpApiSearch({ engine: "google_images", q: "x" }), { ok: true });
  assert.equal(n, 2);
  n = 0;
  http.fetch = (async () => {
    n += 1;
    return new Response(JSON.stringify({ error: "slut på sökningar" }), { status: 429 });
  }) as typeof fetch;
  await assert.rejects(() => serpApiSearch({ engine: "google_images", q: "x" }), /429/);
  assert.equal(n, 2, "429 försöks en gång till och kastar sedan");
  n = 0;
  http.fetch = (async () => {
    n += 1;
    return new Response(JSON.stringify({ error: "fel parameter" }), { status: 400 });
  }) as typeof fetch;
  await assert.rejects(() => serpApiSearch({ engine: "google_images", q: "x" }), /400/);
  assert.equal(n, 1);
});

test("dagstaket stoppar sökningarna innan de går iväg", async () => {
  process.env.SERPAPI_DAILY_CAP = "2";
  onAi = () => aiBody(`${LONG}\n1. A1 – 80 %\n2. B2 – 60 %\n3. C3 – 40 %\n4. D4 – 30 %`, "tok1");
  const { sid } = await aimode.prepare("anv-1", [dataUrl]);
  const s = session.getSession(sid, "anv-1")!;
  await aimode.identify(s, "Sits", "fåtölj"); // 1 fråga + 4 bildsökningar i förväg: bara EN till får plats, resten ger tomma rader
  assert.equal(calls.length, 2, "taket 2: frågan och en bildsökning");
  await assert.rejects(() => aimode.askSpecs(s, "Sits", "Impulse", "fåtölj"), /måttfrågan gav inget svar/);
  assert.equal(calls.length, 2, "ingen sökning gick iväg över taket");
});

// --- Drift: adress, påslag, tak per konto och omförsök i bildkontrollen ------------------------------------------------------------------------------------------------------------------

/** Kör `fn` med miljövariablerna satta (undefined = borttagen) och återställer dem efteråt. */
async function medMiljo(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const fore: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    fore[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(fore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("bildens adress utifrån: SERPAPI_PUBLIC_URL först; loopa.nu (Pages, ingen Worker-rutt för bilden) blir app.loopa.nu; annan adress behålls; ingen ger null", async () => {
  await medMiljo({ SERPAPI_PUBLIC_URL: "https://abc.trycloudflare.com/", LOOPA_PUBLIC_URL: "https://loopa.nu" }, () => assert.equal(session.publicBase(), "https://abc.trycloudflare.com"));
  await medMiljo({ SERPAPI_PUBLIC_URL: undefined, LOOPA_PUBLIC_URL: "https://loopa.nu/" }, () => assert.equal(session.publicBase(), "https://app.loopa.nu"));
  await medMiljo({ SERPAPI_PUBLIC_URL: undefined, LOOPA_PUBLIC_URL: "https://www.loopa.nu" }, () => assert.equal(session.publicBase(), "https://app.loopa.nu"));
  await medMiljo({ SERPAPI_PUBLIC_URL: undefined, LOOPA_PUBLIC_URL: "https://app.loopa.nu" }, () => assert.equal(session.publicBase(), "https://app.loopa.nu"));
  await medMiljo({ SERPAPI_PUBLIC_URL: undefined, LOOPA_PUBLIC_URL: "https://test.example" }, () => assert.equal(session.publicBase(), "https://test.example"));
  await medMiljo({ SERPAPI_PUBLIC_URL: undefined, LOOPA_PUBLIC_URL: undefined }, () => assert.equal(session.publicBase(), null));
  await medMiljo({ SERPAPI_PUBLIC_URL: undefined, LOOPA_PUBLIC_URL: "inte-en-adress" }, () => assert.equal(session.publicBase(), null));
});

test("serpApiEnabled: på med nyckel och adress; av vid LOOPA_SERPAPI=0, saknad nyckel, saknad adress eller nått dygnstak — webben tar då den vanliga vägen", async () => {
  assert.deepEqual(session.serpApiEnabled(), { enabled: true, reason: null });
  await medMiljo({ LOOPA_SERPAPI: "0" }, () => assert.equal(session.serpApiEnabled().enabled, false));
  await medMiljo({ SERPAPI_API_KEY: undefined }, () => assert.match(session.serpApiEnabled().reason ?? "", /SERPAPI_API_KEY/));
  await medMiljo({ SERPAPI_PUBLIC_URL: undefined, LOOPA_PUBLIC_URL: undefined }, () => assert.match(session.serpApiEnabled().reason ?? "", /publik adress/));
  await medMiljo({ SERPAPI_DAILY_CAP: "1" }, () => {
    assert.equal(session.serpApiEnabled().enabled, true);
    session.chargeSearch();
    const r = session.serpApiEnabled();
    assert.equal(r.enabled, false);
    assert.match(r.reason ?? "", /dygnstaket/);
  });
});

test("statusvägen: enabled följer serpApiEnabled, och nyckeln finns aldrig i svaret", async () => {
  const svar: Array<{ status: number; body: any }> = [];
  const send = (_res: unknown, status: number, body: unknown) => svar.push({ status, body });
  const { handleSerpApi } = await import("../server/src/serpapi/routes.js");
  const fraga = async () => handleSerpApi(["status"], { method: "GET" } as never, {} as never, "anv-1", send as never, (async () => ({})) as never);
  assert.equal(await fraga(), true);
  assert.equal(svar[0].status, 200);
  assert.equal(svar[0].body.enabled, true);
  await medMiljo({ SERPAPI_API_KEY: undefined }, async () => {
    await fraga();
    assert.equal(svar[1].body.enabled, false);
    assert.equal(svar[1].body.keySet, false);
  });
  assert.ok(!JSON.stringify(svar).includes(KEY));
});

test("taket per konto: samtalet över taket samma dygn nekas, ett annat konto påverkas inte, och nästa dygn börjar om", async () => {
  await medMiljo({ SERPAPI_MAX_SESSIONS_PER_USER: "2" }, async () => {
    await aimode.prepare("anv-A", [dataUrl]);
    await aimode.prepare("anv-A", [dataUrl]);
    await assert.rejects(() => aimode.prepare("anv-A", [dataUrl]), /tak för SerpApi-samtal/);
    await aimode.prepare("anv-B", [dataUrl]);
    const imorgon = new Date(Date.now() + 36 * 3600 * 1000);
    assert.equal(session.chargeOwnerSession("anv-A", imorgon), 1, "nytt dygn, ny räkning");
  });
});

test("bildkontrollen försöker flera gånger: en tunnel som tappar kontakten en stund fäller inte flödet, men en adress som aldrig svarar gör det och bilden städas bort", async () => {
  await medMiljo({ SERPAPI_SKIP_REACHABILITY: "0" }, async () => {
    let n = 0;
    http.fetch = (async () => {
      n += 1;
      if (n < 3) throw new TypeError("tunneln är nere");
      return new Response("bild", { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;
    const { sid } = await aimode.prepare("anv-1", [dataUrl]);
    assert.ok(session.getSession(sid, "anv-1"));
    assert.equal(n, 3, "två fall och ett lyckat försök");

    n = 0;
    let namn = "";
    http.fetch = (async (input: unknown) => {
      n += 1;
      namn = String(input).split("/").pop()!;
      return new Response("{}", { status: 530 });
    }) as typeof fetch;
    await assert.rejects(() => aimode.prepare("anv-2", [dataUrl]), /går inte att nå utifrån/);
    assert.equal(n, 5, "fem försök, sedan ges det upp");
    assert.equal(session.getImage(namn), null, "bilden ligger inte kvar på en adress ingen når");
  });
});
