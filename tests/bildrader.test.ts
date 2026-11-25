// GOOGLES BILDRADER (server/src/serpapi/bildrader.ts): modellkortens bilder ur den råa sidan. Konstruerad sida med samma uppbyggnad som SerpApis; inga nätanrop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.LOOPA_KANDIDATBILDER_DIR = mkdtempSync(path.join(tmpdir(), "loopa-bildrader-"));
process.on("exit", () => rmSync(process.env.LOOPA_KANDIDATBILDER_DIR!, { recursive: true, force: true }));

const sharp = createRequire(path.resolve("server/package.json"))("sharp");
const { lasGoogleBilder, bildKandidater, aliasUrSvaret, forberedGoogleBilder, valjGoogleBilder } = await import("../server/src/serpapi/bildrader.js");

const jpeg = async (bredd: number, hojd: number, farg: string): Promise<Buffer> => sharp({ create: { width: bredd, height: hojd, channels: 3, background: farg } }).jpeg().toBuffer();
const ruta = `data:image/jpeg;base64,${(await jpeg(300, 225, "#808080")).toString("base64")}`;

/** En bild i en rad: taggen, bilddatan efter den (originalets adress) och skriptet som fyller taggen. `citat` är hur citattecknen skrivs i datan. */
function bild(id: string, titel: string, original: string, sida: string, citat = '"'): string {
  const q = (v: string) => `${citat}${v}${citat}`;
  const data = [q("https://encrypted-tbn0.gstatic.com/images?q\\u003dtbn:abc"), 300, 150, q(original), 900, 450, q(sida)].join(",");
  return `<img id="${id}" alt="${titel}" src="data:image/gif;base64,R0lGOD"><!--x|||[[${data}]]--><script>sn._setImageSrc('${id}','${ruta.replace(/\//g, "\\/")}${id}')</script>`;
}

const SIDA =
  `<h3>Märket Alfa</h3>` +
  bild("b1", "Beta fåtölj | Butiken", "https://butik.example/beta.jpg", "https://butik.example/beta") +
  bild("b2", "Alfa fåtölj | Blocket", "https://annons.example/alfa.jpg", "https://www.blocket.se/annons/1") +
  bild("b3", "Alfa fåtölj | Butiken", "https://butik.example/alfa.jpg", "https://butik.example/alfa") +
  `<h3>Märket Gamma</h3>` +
  bild("b4", "Gamma fåtölj | Butiken", "https://butik.example/gamma.jpg", "https://butik.example/gamma", "&quot;") +
  `<img id="egen" alt="Bild för visuell sökning"><script>sn._setImageSrc('egen','${ruta.replace(/\//g, "\\/")}')</script>`;
const SVAR = "### 1. Märket Alfa (säljs även under namnet Beta)\n### 2. Märket Gamma\n### 3. Märket Delta";
const MODELLER = ["Alfa", "Gamma", "Delta"];

test("läsningen: originalets adress och källsidan, med vanliga citattecken och &quot;; säljarens egen bild räknas inte", () => {
  const bilder = lasGoogleBilder(SIDA);
  assert.deepEqual(bilder.map((b) => b.original), ["https://butik.example/beta.jpg", "https://annons.example/alfa.jpg", "https://butik.example/alfa.jpg", "https://butik.example/gamma.jpg"]);
  assert.equal(bilder[3].kalla, "https://butik.example/gamma");
});

test("urvalet: modellens namn går före det andra namnet, andrahand sållas bort, utan träff i titeln blir det inget", () => {
  const bilder = lasGoogleBilder(SIDA);
  const kandidater = (model: string) => bildKandidater(bilder, SIDA, { brand: "Märket", model, productType: "fåtölj" }, aliasUrSvaret(SVAR, model), MODELLER).map((b) => b.titel);
  assert.deepEqual(aliasUrSvaret(SVAR, "Alfa"), ["Beta"]);
  assert.deepEqual(kandidater("Alfa"), ["Alfa fåtölj | Butiken", "Beta fåtölj | Butiken"]);
  assert.deepEqual(kandidater("Delta"), []);
});

test("kortbilden: ett brett original fylls ut till 4:3; går originalet inte att hämta används Googles ruta; en sida utan bilder fäller inget", async () => {
  const brett = await jpeg(900, 450, "#336699");
  const fore = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => (String(input).endsWith("alfa.jpg") ? new Response(new Uint8Array(brett), { status: 200 }) : new Response("nej", { status: 403 }))) as typeof fetch;
  try {
    assert.equal(await forberedGoogleBilder(SVAR, "https://sida.example", (async () => new Response(SIDA)) as typeof fetch), 4);
    const valda = await valjGoogleBilder("jobb-test", SVAR, MODELLER.map((model) => ({ brand: "Märket", model, productType: "fåtölj" })));
    const matt = async (model: string) => {
      const m = await sharp(readFileSync(path.join(process.env.LOOPA_KANDIDATBILDER_DIR!, path.basename(valda.get(model)!.url)))).metadata();
      return `${m.width}x${m.height}`;
    };
    assert.equal(await matt("Alfa"), "640x480", "originalet, utfyllt");
    assert.equal(await matt("Gamma"), "300x225", "originalet nekades: Googles ruta");
    assert.equal(valda.has("Delta"), false);
  } finally {
    globalThis.fetch = fore;
  }
  assert.equal(await forberedGoogleBilder("annat svar", null), 0);
  assert.equal(await forberedGoogleBilder("annat svar", "https://sida.example", (async () => new Response("", { status: 500 })) as typeof fetch), 0);
  assert.equal((await valjGoogleBilder("jobb-test", "okänt svar", [{ brand: "Märket", model: "Alfa" }])).size, 0);
});
