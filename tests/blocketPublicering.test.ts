// ─── Blocket-publiceringen körd mot en attrapp med shadow DOM ────────────────
//
// Varje test här motsvarar en bugg som en skarp körning mot blocket.se hittade den 8 september 2026.
// De är skrivna för att FALLA om fixen tas bort — inte för att bekräfta att koden gör det den gör.
//
// Attrappen (blocketAttrapp.ts) är byggd av web components med öppna shadow roots, precis som
// Blockets Warp-formulär. Det är hela poängen: den förra attrappen använde vanliga `<select>` och
// `<input type="radio">` i light-DOM, och den blinda koden gick rakt igenom den utan att en enda av
// de sju buggarna syntes.
//
// VAD DE HÄR TESTERNA INTE BEVISAR: att Blockets verkliga markup ser ut så här i dag. Det kan bara en
// körning mot sajten svara på. De bevisar att vårt flöde är rätt — ordningen, värdena,
// verifieringarna, stoppunkten för torrkörning och att kvittoadressen översätts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { startaAttrapp, type Attrapp, type AttrappOptions } from "./blocketAttrapp.js";
import { startBrowser } from "../server/src/integrations/blocket/browser.js";
import { driveBlocketForm, type BlocketPublishPlan } from "../server/src/integrations/blocket/publish.js";
import { readRadios, setSelectByOptionText, waitForForm } from "../server/src/integrations/blocket/form.js";
import { handlePackagePage } from "../server/src/integrations/blocket/shipping.js";
import type { BlocketStep } from "../server/src/types.js";

// Två riktiga filer på disk. Attrappen bryr sig bara om namnen, men `setInputFiles` vill ha filer.
const BILDKATALOG = mkdtempSync(path.join(tmpdir(), "loopa-blocket-bilder-"));
const BILDER = ["img_0.jpg", "img_1.jpg"].map((namn) => {
  const fil = path.join(BILDKATALOG, namn);
  writeFileSync(fil, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]));
  return fil;
});
process.on("exit", () => rmSync(BILDKATALOG, { recursive: true, force: true }));

const BESKRIVNING = "Fåtölj i grått tyg. Besiktigad av Loopa. Inga skador utöver normalt slitage.";

function plan(patch: Partial<BlocketPublishPlan> = {}): BlocketPublishPlan {
  return {
    title: "IKEA Strandmon fåtölj i grått",
    loopaId: "LP-TEST-0001",
    category: { main: "Möbler och inredning", sub: "Soffor och fåtöljer", product: "Fåtöljer" },
    price: 1200,
    priceSource: "listing",
    condition: "Bra skick",
    measurements: { height: 80, width: 82, depth: 96 },
    brand: "IKEA",
    postalCode: "11234",
    imageCount: BILDER.length,
    dryRun: true,
    ...patch,
  };
}

interface Korning {
  attrapp: Attrapp;
  steg: BlocketStep[];
  resultat: Awaited<ReturnType<typeof driveBlocketForm>> | null;
  fel: Error | null;
}

/** Startar attrappen, kör hela formulärflödet mot den och städar efter sig. */
async function kor(opts: { plan?: Partial<BlocketPublishPlan>; attrapp?: AttrappOptions } = {}): Promise<Korning> {
  const attrapp = await startaAttrapp(opts.attrapp ?? {});
  process.env.BLOCKET_BAS_URL = attrapp.bas;

  const steg: BlocketStep[] = [];
  const session = await startBrowser();
  let resultat: Korning["resultat"] = null;
  let fel: Error | null = null;

  try {
    resultat = await driveBlocketForm(
      session.page,
      session.context,
      { plan: plan(opts.plan), description: BESKRIVNING, files: BILDER },
      (name, status, details) => steg.push({ name, status, at: new Date().toISOString(), ...(details ? { details } : {}) }),
    );
  } catch (err) {
    fel = err instanceof Error ? err : new Error(String(err));
  } finally {
    await session.browser.close().catch(() => null);
    await attrapp.stang();
  }

  return { attrapp, steg, resultat, fel };
}

test("attrappen är faktiskt shadow-DOM — light-DOM ser noll fält, locators ser alla", async () => {
  // Grundmätningen bakom fem av de sju buggarna, som ett test. Faller den är attrappen inte längre
  // trogen förlagan, och allt annat här nere bevisar mindre än det ser ut att göra.
  const attrapp = await startaAttrapp();
  process.env.BLOCKET_BAS_URL = attrapp.bas;
  const session = await startBrowser();
  try {
    await session.page.goto(`${attrapp.bas}/recommerce/create/abc123`, { waitUntil: "domcontentloaded" });
    await session.page.waitForTimeout(500);

    const lightDom = await session.page.evaluate(() => ({
      inputs: document.querySelectorAll("input:not([type=file])").length,
      selects: document.querySelectorAll("select").length,
      textareas: document.querySelectorAll("textarea").length,
    }));
    assert.deepEqual(lightDom, { inputs: 0, selects: 0, textareas: 0 }, "fälten ska ligga i shadow roots");

    const viaLocator = await waitForForm(session.page);
    assert.ok(viaLocator.visible > 0, "locators måste se fälten som document.querySelectorAll är blind för");
  } finally {
    await session.browser.close().catch(() => null);
    await attrapp.stang();
  }
});

test("torrkörningen fyller i allt och stannar före sista knappen", async () => {
  const { attrapp, steg, resultat, fel } = await kor();
  assert.equal(fel, null, fel?.message);
  assert.equal(resultat?.status, "dry-run");
  assert.equal(resultat?.url, null, "en torrkörning har ingen annons att peka på");

  const lage = attrapp.lage;
  assert.equal(lage.publicerad, false, "torrkörningen får aldrig publicera");
  assert.equal(lage.paket, null, "sista knappen trycktes aldrig");

  // FIX 7: kortet, inte utkastet.
  assert.ok(lage.besokta.includes("/recommerce/create/abc123"), "Torget-kortet skulle ha öppnats");
  assert.ok(!lage.besokta.some((v) => v.includes("utkast-20990506")), "ett gammalt utkast öppnades i stället för en ny annons");

  // Sälj var INTE förvalt i attrappen — "Bortskänkes" var det.
  assert.equal(lage.transaktionstyp, "Sälj", "annonsen skulle ha skänkts bort i stället för att säljas");

  // FIX 3: lövet måste bli satt, inte bara underkategorin.
  assert.equal(lage.formular?.underkategori, "Soffor och fåtöljer");
  assert.equal(lage.formular?.produkttyp, "Fåtöljer");
  assert.equal(lage.formular?.skick, "Bra skick - varsamt använd");

  // FIX 2: beskrivningen i beskrivningsfältet, inte i bildtextfältet.
  assert.equal(lage.formular?.beskrivning, BESKRIVNING);
  assert.equal(lage.formular?.bildtext, "", "annonstexten hamnade i bildtextfältet");

  // Exakt etikettmatchning: höjden i Höjd, ingenting i Sitthöjd.
  assert.equal(lage.formular?.hojd, "80");
  assert.equal(lage.formular?.sitthojd, "", "möbelns höjd skrevs in som sitthöjd");
  assert.equal(lage.formular?.bredd, "82");
  assert.equal(lage.formular?.djup, "96");

  assert.equal(lage.formular?.rubrik, "IKEA Strandmon fåtölj i grått");
  assert.equal(lage.formular?.pris, "1200");
  assert.equal(lage.formular?.postnummer, "11234");
  assert.equal(lage.formular?.marke, "IKEA");
  assert.equal(lage.bilder.length, BILDER.length, "Blockets uppladdare tappar bilder som kommer för tätt");

  // FIX 6: fraktvalet stod på "Stor" från början.
  assert.equal(lage.fraktval, "Jag kan inte skicka varan");

  // FIX 4: knappen är <w-button> med texten utanför den <button> som ligger i skuggan.
  const vidare = steg.find((s) => s.name.startsWith("Vidare från formuläret"));
  assert.ok(vidare, "steget som lämnar formuläret saknas");
  assert.ok(
    vidare!.name.includes("w-button"),
    `Fortsätt-knappen träffades av "${vidare!.name}" — button:has-text() ska inte kunna matcha en w-button`,
  );
});

test("skarp körning trycker sista knappen och lämnar tillbaka den publika annonsadressen", async () => {
  const { attrapp, resultat, fel } = await kor({ plan: { dryRun: false } });
  assert.equal(fel, null, fel?.message);
  assert.equal(resultat?.status, "published");
  assert.equal(attrapp.lage.publicerad, true);
  assert.equal(attrapp.lage.paket, "Bas", "det gratis paketet skulle ha valts");
  // Kvittoadressen fungerar bara för den inloggade — det är den publika som ska sparas.
  assert.equal(resultat?.url, `${attrapp.bas}/24720589`);
  assert.ok(resultat!.receiptUrl.includes("ad-receipt"));
});

test("utkastvakten avbryter hellre än skriver över någon annans annons", async () => {
  const { fel, attrapp } = await kor({ attrapp: { utkastRubrik: "Bokhylla Karamel från Hannah Home" } });
  assert.ok(fel, "körningen skulle ha avbrutits");
  assert.match(fel!.message, /utkast/i);
  assert.equal(attrapp.lage.formular, null, "ingenting fick skickas in i någon annans utkast");
});

test("utkastvakten fortsätter när ett tomt formulär går att få", async () => {
  const { fel, attrapp } = await kor({
    attrapp: { utkastRubrik: "Bokhylla Karamel från Hannah Home", utkastForsvinner: true },
  });
  assert.equal(fel, null, fel?.message);
  assert.equal(attrapp.lage.formular?.rubrik, "IKEA Strandmon fåtölj i grått");
});

test("paketsidan: alternativ utan egen etikett läses ur förälderelementet och väljs verifierat", async () => {
  // Regressionstestet för felet som stoppade den första skarpa körningen: "Paketsidan har ett betalt
  // paket valt ()" — med tomma parenteser. Paketsidans w-radio saknar name, role, aria-labelledby,
  // aria-label OCH egen text, så etiketten blev tom, valet gick inte att verifiera, och vakten läste
  // vårt eget Bas-val som ett namnlöst betalt paket.
  const attrapp = await startaAttrapp();
  process.env.BLOCKET_BAS_URL = attrapp.bas;
  const session = await startBrowser();
  try {
    await session.page.goto(`${attrapp.bas}/choose-products`, { waitUntil: "domcontentloaded" });
    await session.page.waitForTimeout(500);

    const innan = await readRadios(session.page);
    assert.deepEqual(
      innan.map((r) => r.label),
      ["Bas", "Plus", "Premium"],
      "etiketterna måste hämtas ur förälderelementet när alternativet självt saknar dem",
    );
    assert.ok(!innan.some((r) => r.checked), "inget alternativ är förvalt på paketsidan");

    await handlePackagePage(session.page, () => {});

    const efter = await readRadios(session.page);
    assert.equal(efter.find((r) => r.label === "Bas")?.checked, true, "Bas skulle ha valts");
    assert.ok(!efter.some((r) => r.checked && r.label !== "Bas"), "inget betalt paket får bli valt");
  } finally {
    await session.browser.close().catch(() => null);
    await attrapp.stang();
  }
});

test("kategorival: exakt träff i ALLA listor prövas före luddig i någon", async () => {
  // Renodlad fälla 3. Den tomma listan har den luddiga träffen ("Soffor och fåtöljer" innehåller
  // "fåtöljer"), den fyllda har den exakta ("Fåtöljer"). Går matchningen lista för lista väljs fel.
  const attrapp = await startaAttrapp();
  process.env.BLOCKET_BAS_URL = attrapp.bas;
  const session = await startBrowser();
  try {
    await session.page.goto(`${attrapp.bas}/prov/listor`, { waitUntil: "domcontentloaded" });
    await session.page.waitForTimeout(500);
    const traff = await setSelectByOptionText(session.page, "Fåtöljer");
    assert.equal(traff.picked, "Fåtöljer");
    assert.equal(traff.strategy, "exakt");
  } finally {
    await session.browser.close().catch(() => null);
    await attrapp.stang();
  }
});
