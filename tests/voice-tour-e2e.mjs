// RÖKTEST: hela röstrundan, från talad ljudfil till färdig besiktning.
//
//   node tests/voice-tour-e2e.mjs
//
// Kör den riktiga sidan i en riktig webbläsare, med en SYNTETISK TALFIL som mikrofon och Chromiums
// testbild som kamera. Ingenting mockas på vägen: talet går till Aqua, transkriptet till
// märkesdetekteringen och skadeordlistan, närbilden plockas ur den inspelade videon, och jobbet
// körs genom Gemini som vilket jobb som helst.
//
// KOSTAR RIKTIGA ANROP (en Aqua-transkribering + en Gemini-inspektion). Kör den medvetet.
//
// Förutsättningar:
//   1. npm run server:dev   och   npm run web:dev   igång
//   2. playwright-core + en Chromium-binär tillgänglig (PW_CHROMIUM pekar ut den)
//   3. CONDITION_SERVICE_KEY i miljön (samma som server/.env)
//   4. En talfil: node tests/voice-tour-audio.mjs   skriver den med Windows egen talsyntes
//
// VAD TESTET FAKTISKT BEVISADE första gången det kördes (2026-09-07), och därför är värt att behålla:
//
//   - hela kedjan bär: 11 s tal uppmätt, 6 vyer extraherade, transkript tillbaka, jobb klart
//   - märket "IKEA" plockades ur talet och startade modellsökningen
//   - skadeordet "repa" gav EN automatisk närbild ur rätt ögonblick i filmen
//   - `sellerNotes` fanns kvar på jobbet på disk — hela vägen genom servern
//   - **och viktigast:** säljaren SA att det fanns en repa, kameran visade en grön testbild, och
//     modellen rapporterade NOLL fynd. Ledtråden lockade alltså inte fram ett påhittat fynd, vilket
//     är hela poängen med formuleringen i inspect.ts. Det är den egenskapen som är dyrast att
//     tappa i en framtida promptändring, och billigast att upptäcka här.
import { chromium } from "playwright-core";

const KEY = process.env.CONDITION_SERVICE_KEY;
const WAV = process.env.VOICE_TOUR_WAV ?? new URL("./voice-tour-tal.wav", import.meta.url).pathname.slice(1);
const EXE = process.env.PW_CHROMIUM;
const URL_ = process.env.VOICE_TOUR_URL ?? "https://localhost:5190/voicetour.html";
const RECORD_MS = Number(process.env.VOICE_TOUR_RECORD_MS ?? 20000);

if (!KEY) {
  console.error("CONDITION_SERVICE_KEY saknas — sätt samma värde som i server/.env.");
  process.exit(1);
}

const browser = await chromium.launch({
  ...(EXE ? { executablePath: EXE } : {}),
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    // Talfilen SOM mikrofon. Chromium loopar den, så en 15-sekunders fil räcker för en längre runda.
    `--use-file-for-fake-audio-capture=${WAV}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 390, height: 844 },
  permissions: ["camera", "microphone"],
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[sidfel]", String(e).slice(0, 300)));
page.on("console", (m) => {
  if (m.text().includes("röstrundan")) console.info("[konsol]", m.text().slice(0, 200));
});

const fail = [];
const check = (ok, what) => {
  console.info(`${ok ? "  ✔" : "  ✖"} ${what}`);
  if (!ok) fail.push(what);
};

await page.goto(URL_, { waitUntil: "networkidle" });
await page.fill('input[type="password"]', KEY);
await page.click("text=Starta rundan");

console.info(`Filmar ${RECORD_MS / 1000} s…`);
await page.waitForTimeout(RECORD_MS);
const live = await page.evaluate(() => document.body.innerText);
console.info("\nFilmningsskärmen:");
check(/SPELAR IN/.test(live), "spelar in");
check(/\d+ s tal inspelat/.test(live), `taldetekteringen räknar (${(live.match(/(\d+) s tal/) ?? [])[0] ?? "—"})`);

await page.click('button[aria-label="Avsluta rundan"]');
console.info("\nBearbetar (transkribering + bildrutor + besiktning)…");
await page.waitForFunction(() => document.body.innerText.includes("Ny runda"), { timeout: 300_000 });
await page.waitForTimeout(2000);

const out = await page.evaluate(() => document.body.innerText);
console.info("\nResultatskärmen:");
/* Påståendena matchar INNEHÅLL, inte ordalydelse. Första versionen letade efter exakta rader ur
   gränssnittet ("🎙 ”…”", "närbild automatiskt tagna") och tre av dem föll vid nästa designomgång
   trots att funktionen var hel — ett test som går sönder av en omformulering lär en att ignorera
   det. Orden nedan är sådana som bara kan stå där om steget faktiskt hänt. */
check(/soffbord|IKEA/i.test(out), "transkriptet kom tillbaka från Aqua (talets ord syns)");
check(/IKEA/.test(out), "märket plockat ur talet");
check(/närbild/i.test(out), "närbild tagen ur skadeögonblicket");
check(/ledtråd/i.test(out), "talet märkt som använt av besiktningen");
check(!/Jobbet kunde inte skapas|Analysen misslyckades|Transkriberingen misslyckades/.test(out), "inget fel i flödet");

// Väntar in besiktningen om den fortfarande kör — betyget är sista beviset på att jobbet gick igenom.
const done = await page
  .waitForFunction(() => /Inga skador rapporterade|·\s*(Nyskick|Mycket bra skick|Bra skick|Okej skick)/.test(document.body.innerText), { timeout: 300_000 })
  .then(() => true)
  .catch(() => false);
check(done, "besiktningen kom fram till ett resultat");

console.info("\n=== hela resultatskärmen ===");
console.info(await page.evaluate(() => document.body.innerText));

// VOICE_TOUR_SHOT=nagot.png sparar resultatskärmen. Designarbete på den här sidan är svårt att göra
// blint — en knapp låg en gång med vit text på vit botten i flera omgångar innan någon tittade.
if (process.env.VOICE_TOUR_SHOT) {
  await page.screenshot({ path: process.env.VOICE_TOUR_SHOT, fullPage: true });
  console.info(`\nSkärmbild: ${process.env.VOICE_TOUR_SHOT}`);
}

await browser.close();
if (fail.length) {
  console.error(`\n${fail.length} kontroll(er) föll:\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.info("\nAlla kontroller gröna.");
