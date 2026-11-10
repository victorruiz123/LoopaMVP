// Bilden på varje förslag — inte på några av dem.
//
// Väljarskärmen visar upp till fyra modeller, och det är BILDEN säljaren väljer på: namnen säger
// ingenting för den som inte redan vet vad möbeln heter. En kandidat utan bild är därför i praktiken
// ett förslag utan innehåll, och felet var aldrig att fel bild valdes utan att ingen hittades.
//
// Testerna nedan vaktar de fyra ställen där en bild gick förlorad fastän den fanns: sidan bar den
// någon annanstans än i og-taggen, sidan avvisade hämtningen, adressen pekade på en borttagen bild,
// eller så tog en annan kandidat den enda sida som gick att använda. Kravet på att sidan ska HANDLA
// om modellen är orört — en bild på fel möbel är fortfarande värre än en tom ruta.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { isListingPage, resolveCandidateImages, type SourceRef } from "../server/src/candidateImages.js";
import { dugerSomProduktbild, lokalKandidatbild, registreradKandidatbild, slappKandidatbildsregister } from "../server/src/kandidatbild.js";
import { bekraftarTyp, engelskTyp, familjerI, glomBildtypsavgoranden, motsagerTyp, settBildtypKontroll, typfamilj } from "../server/src/candidateType.js";
import type { ModelCandidate } from "../server/src/types.js";

const IMAGE = "image/jpeg";

/**
 * EGEN KATALOG FÖR TESTET.
 *
 * Miniatyrerna skrivs till disk och modellerna skrivs i ett register. Utan den här raden hade
 * körningen lagt "Sits NORDVIKEN" i driftens register, och nästa säljare med en NORDVIKEN hade fått
 * en bild ur ett test. Katalogen töms mellan varje prov, så inget läcker mellan dem heller.
 */
process.env.LOOPA_KANDIDATBILDER_DIR = mkdtempSync(path.join(tmpdir(), "loopa-kandidatbild-"));

const sharp = createRequire(new URL("../server/src/kandidatbild.ts", import.meta.url))(
  "sharp",
) as typeof import("../server/node_modules/sharp");

/**
 * Bytesen mocken lämnar ut för en bildadress.
 *
 * RIKTIGA BYTES, inte en tom kropp med rätt innehållstyp. Kedjan hämtar numera hem bilden, avkodar
 * den och skalar den — det är den hämtningen som ÄR kontrollen (se kandidatbild.ts) — så en tom
 * kropp betyder "ingen bild" och varenda prov hade fallit. 600 px, alltså över spärren mot ikoner.
 */
const BILDBYTES = await sharp({
  create: { width: 600, height: 450, channels: 3, background: { r: 190, g: 175, b: 155 } },
})
  .jpeg()
  .toBuffer();

/**
 * Adressen en hämtad bild får hos oss. Samma summa som kandidatbild.ts räknar.
 *
 * Proven pekar ut VILKEN källbild som ska väljas, och det är fortfarande det de mäter — bara att
 * svaret nu är vår egen adress för den bilden i stället för butikens.
 */
function lokal(url: string): string {
  return `/api/kandidatbild/${createHash("sha1").update(url).digest("hex")}.jpg`;
}

interface Reply {
  body?: string;
  /** Bytes för en bildadress, om de ska vara något annat än den vanliga produktbilden (till exempel en bred banner). */
  bytes?: Buffer;
  status?: number;
  type?: string;
  /** Sidan svarar 403 på allt som inte ser ut som en webbläsare. */
  browserOnly?: boolean;
  /** Strömmen dör mitt i kroppen, som när tidsgränsen slår an under en stor sida. */
  brokenStream?: boolean;
}

/** Sökmotorerna, alla adresser under samma värd. Vilken av dem tur ordningen väljer spelar ingen roll. */
const ENGINES = [
  "https://html.duckduckgo.com/",
  "https://lite.duckduckgo.com/",
  "https://www.bing.com/",
  "https://search.brave.com/",
  "https://www.mojeek.com/",
];
const searchAnswers = (body: string): Record<string, Reply> => Object.fromEntries(ENGINES.map((e) => [e, { body }]));

const candidate = (model: string): ModelCandidate => ({
  brand: "Sits",
  model,
  variant: null,
  productType: null,
  confidence: "strong",
  distinguishingDetail: null,
});

const source = (url: string, qualityTier: 1 | 2 | 3 = 1): SourceRef => ({ title: new URL(url).hostname, url, qualityTier });

/** En liten webb: adresserna som finns svarar, alla andra ger 404 precis som på riktigt. */
async function withWeb(routes: Record<string, Reply>, fn: (calls: string[]) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const ua = String((init?.headers as Record<string, string> | undefined)?.["user-agent"] ?? "");
    calls.push(`${method} ${url}`);
    // Exakt adress först, annars den registrerade adress som är en inledning till den — så kan ett
    // helt sökmotorvärdnamn besvaras utan att testet behöver återskapa frågesträngen tecken för tecken.
    const reply = routes[url] ?? routes[Object.keys(routes).find((k) => url.startsWith(k) && k.endsWith("/")) ?? ""];
    if (!reply) return new Response("finns inte", { status: 404, headers: { "content-type": "text/html" } });
    if (reply.browserOnly && ua.includes("LoopaCondition")) {
      return new Response("nej tack", { status: 403, headers: { "content-type": "text/html" } });
    }
    if (reply.brokenStream && method !== "HEAD") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(reply.body ?? ""));
            // Felet kommer EFTER att första biten hunnit läsas — så ser en tidsgräns ut som slår an
            // mitt i en stor sida: huvudet är framme, resten kommer aldrig.
            setTimeout(() => controller.error(new DOMException("aborted", "TimeoutError")), 5);
          },
        }),
        { headers: { "content-type": "text/html" } },
      );
    }
    const type = reply.type ?? "text/html";
    // En bildadress lämnar ut riktiga bytes; allt annat sin text. Se BILDBYTES.
    const kropp = method === "HEAD" ? null : type.startsWith("image/") ? (reply.bytes ?? BILDBYTES) : (reply.body ?? "");
    return new Response(kropp, { status: reply.status ?? 200, headers: { "content-type": type } });
  }) as unknown as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
    // Nästa prov ska leta på nytt: en kvarliggande miniatyr eller registerpost hade gjort provet
    // beroende av vilken ordning proven råkade köras i.
    rmSync(process.env.LOOPA_KANDIDATBILDER_DIR!, { recursive: true, force: true });
    slappKandidatbildsregister();
  }
}

test("bilden hämtas ur JSON-LD när og-taggen saknas", async () => {
  const page = `<html><head><title>NORDVIKEN Barstol | Butiken</title>
    <script type="application/ld+json">
      {"@type":"Product","name":"NORDVIKEN","image":["https://butiken.se/media/nordviken.jpg"]}
    </script></head><body><h1>NORDVIKEN</h1></body></html>`;
  await withWeb(
    {
      "https://butiken.se/p/nordviken": { body: page },
      "https://butiken.se/media/nordviken.jpg": { type: IMAGE },
    },
    async () => {
      const [c] = await resolveCandidateImages([candidate("NORDVIKEN")], [source("https://butiken.se/p/nordviken")]);
      assert.equal(c.imageUrl, lokal("https://butiken.se/media/nordviken.jpg"));
      assert.equal(c.imageSource, "https://butiken.se/p/nordviken", "påståendet ska gå att kontrollera");
    },
  );
});

test("saknar sidan metadata läses produktbilden ur den, aldrig loggan", async () => {
  const page = `<html><head><title>Impulse fåtölj | Butiken</title></head><body>
    <img class="site-logo" src="https://butiken.se/img/logo.png" width="300" height="300" alt="Butiken">
    <img src="https://butiken.se/img/impulse-stor.jpg" width="1200" height="900" alt="Impulse fåtölj">
    <img src="https://butiken.se/img/liten.jpg" width="80" height="60" alt="miniatyr">
  </body></html>`;
  await withWeb(
    {
      "https://butiken.se/impulse": { body: page },
      "https://butiken.se/img/logo.png": { type: IMAGE },
      "https://butiken.se/img/impulse-stor.jpg": { type: IMAGE },
      "https://butiken.se/img/liten.jpg": { type: IMAGE },
    },
    async () => {
      const [c] = await resolveCandidateImages([candidate("Impulse")], [source("https://butiken.se/impulse")]);
      assert.equal(c.imageUrl, lokal("https://butiken.se/img/impulse-stor.jpg"));
    },
  );
});

test("en död bildadress lämnar plats åt nästa bild på samma sida", async () => {
  const page = `<html><head><title>Julia 3-sits | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/borttagen.jpg"></head>
    <body><img src="https://butiken.se/img/julia.jpg" width="900" height="700" alt="Julia"></body></html>`;
  await withWeb(
    {
      "https://butiken.se/julia": { body: page },
      "https://butiken.se/img/borttagen.jpg": { status: 404, type: IMAGE },
      "https://butiken.se/img/julia.jpg": { type: IMAGE },
    },
    async () => {
      const [c] = await resolveCandidateImages([candidate("Julia")], [source("https://butiken.se/julia")]);
      assert.equal(c.imageUrl, lokal("https://butiken.se/img/julia.jpg"), "en 404 är en tom ruta hos säljaren");
    },
  );
});

test("en sida som avvisar robotnamnet hämtas om som en vanlig besökare", async () => {
  const page = `<html><head><title>Alex fåtölj | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/alex.jpg"></head><body></body></html>`;
  await withWeb(
    {
      "https://butiken.se/alex": { body: page, browserOnly: true },
      "https://butiken.se/img/alex.jpg": { type: IMAGE },
    },
    async (calls) => {
      const [c] = await resolveCandidateImages([candidate("Alex")], [source("https://butiken.se/alex")]);
      assert.equal(c.imageUrl, lokal("https://butiken.se/img/alex.jpg"));
      assert.equal(calls.filter((c2) => c2 === "GET https://butiken.se/alex").length, 2, "ett försök till, inte fler");
    },
  );
});

/**
 * Fördelningen, som är det fel som drabbade flest: sidorna fanns, men fel kandidat tog dem.
 *
 * Kollektionssidan nämner båda modellerna och är den starkaste träffen för båda. Girigt tog den
 * första kandidaten den — fastän den hade en egen produktsida att ta i stället — och den andra blev
 * utan bild trots att en fanns åt den.
 */
test("den enda sida en kandidat kan använda tas inte av en som har fler val", async () => {
  const kollektion = `<html><head><title>Alex och Julia | Sits</title>
    <meta property="og:image" content="https://sits.se/img/kollektion.jpg"></head><body></body></html>`;
  const alexSida = `<html><head><title>Alex fåtölj | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/alex.jpg"></head><body></body></html>`;
  await withWeb(
    {
      "https://sits.se/kollektion": { body: kollektion },
      "https://butiken.se/stol/alex": { body: alexSida },
      "https://sits.se/img/kollektion.jpg": { type: IMAGE },
      "https://butiken.se/img/alex.jpg": { type: IMAGE },
    },
    async () => {
      const out = await resolveCandidateImages(
        [candidate("Alex"), candidate("Julia")],
        [source("https://sits.se/kollektion", 1), source("https://butiken.se/stol/alex", 3)],
      );
      assert.equal(out[0].imageUrl, lokal("https://butiken.se/img/alex.jpg"), "Alex har en egen sida och ska ta den");
      assert.equal(out[1].imageUrl, lokal("https://sits.se/img/kollektion.jpg"), "Julia har bara kollektionssidan");
      assert.notEqual(out[0].imageUrl, out[1].imageUrl, "två kandidater delar aldrig bild");
    },
  );
});

test("hoppet följer länktexten när adressen bara är ett artikelnummer", async () => {
  const kategori = `<html><head><title>Barstolar | Butiken</title></head><body>
    <a href="https://butiken.se/p/1043821"><span>NORDVIKEN barstol</span></a>
    <a href="https://butiken.se/p/2200100"><span>FRANKLIN barstol</span></a>
  </body></html>`;
  const produkt = `<html><head><title>NORDVIKEN Barstol 63 cm | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/nordviken.jpg"></head><body></body></html>`;
  await withWeb(
    {
      "https://butiken.se/barstolar": { body: kategori },
      "https://butiken.se/p/1043821": { body: produkt },
      "https://butiken.se/img/nordviken.jpg": { type: IMAGE },
    },
    async () => {
      const [c] = await resolveCandidateImages([candidate("NORDVIKEN")], [source("https://butiken.se/barstolar")]);
      assert.equal(c.imageUrl, lokal("https://butiken.se/img/nordviken.jpg"));
    },
  );
});

test("två hopp i följd: startsidan bär ingen bild men vägen dit", async () => {
  const start = `<html><head><title>Butiken – möbler</title></head><body>
    <a href="https://butiken.se/kampanj/nordviken">Veckans erbjudande</a></body></html>`;
  const kampanj = `<html><head><title>Kampanj | Butiken</title></head><body>
    <a href="https://butiken.se/p/nordviken-barstol">NORDVIKEN barstol</a></body></html>`;
  const produkt = `<html><head><title>NORDVIKEN Barstol | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/nordviken.jpg"></head><body></body></html>`;
  await withWeb(
    {
      "https://butiken.se/": { body: start },
      "https://butiken.se/kampanj/nordviken": { body: kampanj },
      "https://butiken.se/p/nordviken-barstol": { body: produkt },
      "https://butiken.se/img/nordviken.jpg": { type: IMAGE },
    },
    async () => {
      const [c] = await resolveCandidateImages([candidate("NORDVIKEN")], [source("https://butiken.se/")]);
      assert.equal(c.imageUrl, lokal("https://butiken.se/img/nordviken.jpg"));
    },
  );
});

/**
 * Delresultatet: den som fortfarande letas får INGET besked, den som är klar får sin bild.
 *
 * Skillnaden mellan `undefined` och `null` är hela kontraktet mot väljarskärmen — `null` betyder
 * "slut på letande" och stoppar dess pollning. Skrevs det ut i ett delresultat skulle bilden som
 * landar en runda senare aldrig nå skärmen.
 */
test("det som redan hittats skrivs ut innan resten letats upp", async () => {
  const alexSida = `<html><head><title>Alex fåtölj | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/alex.jpg"></head><body></body></html>`;
  const oversikt = `<html><head><title>Sortiment | Butiken</title></head><body>
    <a href="https://butiken.se/p/9911">Julia soffa</a></body></html>`;
  const juliaSida = `<html><head><title>Julia 3-sits | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/julia.jpg"></head><body></body></html>`;
  await withWeb(
    {
      "https://butiken.se/alex": { body: alexSida },
      "https://butiken.se/sortiment": { body: oversikt },
      "https://butiken.se/p/9911": { body: juliaSida },
      "https://butiken.se/img/alex.jpg": { type: IMAGE },
      "https://butiken.se/img/julia.jpg": { type: IMAGE },
    },
    async () => {
      const delar: ModelCandidate[][] = [];
      const out = await resolveCandidateImages(
        [candidate("Alex"), candidate("Julia")],
        [source("https://butiken.se/alex"), source("https://butiken.se/sortiment")],
        (partial) => {
          delar.push(partial);
        },
      );
      assert.equal(delar.length, 1, "ett delresultat, innan hoppet");
      assert.equal(delar[0][0].imageUrl, lokal("https://butiken.se/img/alex.jpg"), "Alex bild ska inte vänta in Julia");
      assert.equal("imageUrl" in delar[0][1], false, "Julia letas fortfarande — inget besked ännu");
      assert.equal(out[0].imageUrl, lokal("https://butiken.se/img/alex.jpg"));
      assert.equal(out[1].imageUrl, lokal("https://butiken.se/img/julia.jpg"));
    },
  );
});

test("en sida som inte handlar om modellen ger fortfarande ingen bild", async () => {
  const page = `<html><head><title>Soffor | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/nagon-annan.jpg"></head>
    <body><img src="https://butiken.se/img/ocksa-fel.jpg" width="900" height="700"></body></html>`;
  await withWeb(
    {
      "https://butiken.se/soffor": { body: page },
      "https://butiken.se/img/nagon-annan.jpg": { type: IMAGE },
      "https://butiken.se/img/ocksa-fel.jpg": { type: IMAGE },
    },
    async () => {
      const [c] = await resolveCandidateImages([candidate("Saturday")], [source("https://butiken.se/soffor")]);
      assert.equal(c.imageUrl, null, "en bild på fel möbel är värre än en tom ruta");
      assert.equal(c.pageSpecs, null);
    },
  );
});

/**
 * Det dyraste felet som fanns: EN långsam sida tog bilderna för ALLA kandidater.
 *
 * Hämtningens tidsgräns gäller hela svaret, kroppen med. Slog den an mitt i strömmen kastade
 * läsningen ett fel som gick rakt ut ur hela omgången — och varje kandidat i jobbet stod utan bild
 * för att en sida var stor. Nu används det som hanns läsas, och `<head>` kommer först i strömmen.
 */
test("en sida vars ström dör mitt i lämnar ifrån sig det som hanns läsas", async () => {
  const alexHuvud = `<html><head><title>Alex fåtölj | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/alex.jpg"></head><body>`;
  const juliaSida = `<html><head><title>Julia 3-sits | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/julia.jpg"></head><body></body></html>`;
  await withWeb(
    {
      "https://butiken.se/alex": { body: alexHuvud, brokenStream: true },
      "https://butiken.se/julia": { body: juliaSida },
      "https://butiken.se/img/alex.jpg": { type: IMAGE },
      "https://butiken.se/img/julia.jpg": { type: IMAGE },
    },
    async () => {
      const out = await resolveCandidateImages(
        [candidate("Alex"), candidate("Julia")],
        [source("https://butiken.se/alex"), source("https://butiken.se/julia")],
      );
      assert.equal(out[0].imageUrl, lokal("https://butiken.se/img/alex.jpg"), "huvudet hanns läsas — bilden står där");
      assert.equal(out[1].imageUrl, lokal("https://butiken.se/img/julia.jpg"), "grannens sida rörs inte av att en annan föll");
    },
  );
});

/**
 * IKEA svarar 200 OK på en produktadress som inte finns och lämnar ut hela sortimentssidan.
 *
 * Adressen bär modellnamnet — den kom ur modellens egen gissning — men sidan handlar inte om
 * modellen, och dess bilder är kategorifoton. Sidans EGEN utpekade bild (og:image) hade fått
 * användas; en bild vi själva plockar ur kroppen kräver att titeln nämner modellen.
 */
test("en sida som bara har modellnamnet i adressen får inte låna ut sina egna bilder", async () => {
  const sortiment = `<html><head><title>Se hela sortimentet | Butiken</title></head><body>
    <img src="https://butiken.se/img/kok.jpg" width="1200" height="900" alt="Kök">
    <img src="https://butiken.se/img/soffor.jpg" width="1200" height="900" alt="Soffor">
  </body></html>`;
  await withWeb(
    {
      "https://butiken.se/p/franklin-barstol-70359092/": { body: sortiment },
      "https://butiken.se/img/kok.jpg": { type: IMAGE },
      "https://butiken.se/img/soffor.jpg": { type: IMAGE },
      ...searchAnswers("<html><body>inga träffar</body></html>"),
    },
    async () => {
      const [c] = await resolveCandidateImages(
        [{ ...candidate("FRANKLIN"), sourceUrl: "https://butiken.se/p/franklin-barstol-70359092/" }],
        [],
      );
      assert.equal(c.imageUrl, null, "ett kategorifoto under fel namn är värre än en tom ruta");
    },
  );
});

/**
 * Sista utvägen, och den som bär flest: fråga en sökmotor rakt ut.
 *
 * Kandidaten har ingen källa och en gissad adress som inte finns. Före sökningen fanns det ingenting
 * att hämta för den — den var dömd att bli en tom ruta oavsett hur bra resten av kedjan var.
 */
test("hittas ingen sida frågas en sökmotor efter modellen", async () => {
  const traffar = `<html><body>
    <a href="https://butiken.se/p/franklin-barstol">FRANKLIN barstol, hopfällbar</a>
  </body></html>`;
  const produkt = `<html><head><title>FRANKLIN Barstol | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/franklin.jpg"></head><body></body></html>`;
  await withWeb(
    {
      ...searchAnswers(traffar),
      "https://butiken.se/p/franklin-barstol": { body: produkt },
      "https://butiken.se/img/franklin.jpg": { type: IMAGE },
    },
    async (calls) => {
      const [c] = await resolveCandidateImages([candidate("FRANKLIN")], []);
      assert.equal(c.imageUrl, lokal("https://butiken.se/img/franklin.jpg"));
      assert.ok(
        calls.some((call) => ENGINES.some((e) => call.includes(e))),
        "sökningen ska ha gjorts",
      );
    },
  );
});

/**
 * Butikens egen sökruta — före sökmotorn, för den kan inte strypas och butiken har sin egen produkt.
 *
 * Modellens gissade adress är fel, men VÄRDNAMNET i den stämmer. Träfflistan är däremot ingen
 * produktsida: den visar soffan, fotpallen och klädseln bredvid varandra, och dess egen bild är
 * vilken som helst av dem. Bara länkarna därifrån får användas.
 */
test("butikens sökruta leder till möbeln, och träfflistans egen bild lånas aldrig", async () => {
  const traffLista = `<html><head><title>Sökresultat: Oxford | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/kampanjbanner.jpg"></head><body>
    <a href="https://butiken.se/p/oxford-kladsel/1">Oxford klädsel</a>
    <a href="https://butiken.se/p/oxford-3-sits-soffa/2">Oxford 3-sits soffa</a>
  </body></html>`;
  const soffa = `<html><head><title>Oxford 3-sits soffa | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/oxford-soffa.jpg"></head><body></body></html>`;
  await withWeb(
    {
      "https://butiken.se/sok?q=Oxford": { body: traffLista },
      "https://butiken.se/p/oxford-3-sits-soffa/2": { body: soffa },
      "https://butiken.se/img/oxford-soffa.jpg": { type: IMAGE },
      "https://butiken.se/img/kampanjbanner.jpg": { type: IMAGE },
      ...searchAnswers("<html><body>inga träffar</body></html>"),
    },
    async () => {
      const [c] = await resolveCandidateImages(
        [{ ...candidate("Oxford"), productType: "soffa", sourceUrl: "https://butiken.se/p/oxford-3-sits-soffa/999999" }],
        [],
      );
      assert.equal(c.imageUrl, lokal("https://butiken.se/img/oxford-soffa.jpg"), "möbelns sida, inte klädselns");
      assert.equal(c.imageSource, "https://butiken.se/p/oxford-3-sits-soffa/2");
    },
  );
});

/** Klädseln är inte soffan — inte ens när båda sidorna heter EKTORP och båda bär en bild. */
test("möbelns egen sida vinner över sidan om möbelns klädsel", async () => {
  const kladsel = `<html><head><title>EKTORP Klädsel för 3-sitssoffa | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/tyg.jpg"></head><body></body></html>`;
  const soffa = `<html><head><title>EKTORP 3-sitssoffa | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/soffa.jpg"></head><body></body></html>`;
  await withWeb(
    {
      "https://butiken.se/p/ektorp-kladsel": { body: kladsel },
      "https://butiken.se/p/ektorp-soffa": { body: soffa },
      "https://butiken.se/img/tyg.jpg": { type: IMAGE },
      "https://butiken.se/img/soffa.jpg": { type: IMAGE },
    },
    async () => {
      const [c] = await resolveCandidateImages(
        [candidate("EKTORP")],
        // Klädselsidan står FÖRST och har högre källkvalitet — bara tillbehörsstraffet skiljer dem åt.
        [source("https://butiken.se/p/ektorp-kladsel", 1), source("https://butiken.se/p/ektorp-soffa", 3)],
      );
      assert.equal(c.imageUrl, lokal("https://butiken.se/img/soffa.jpg"));
    },
  );
});

/**
 * `&amp;` i en länk är HTML, inte adress.
 *
 * Butikslänkar bär sina varianter i frågesträngen. Hämtas adressen med taggen kvar svarar servern
 * 200 på något annat — rätt titel, halv sida, inga produktbilder — och kandidaten blev utan bild
 * fastän den stod på sin egen produktsida.
 */
test("länkens frågesträng avkodas innan den hämtas", async () => {
  const kategori = `<html><head><title>Soffor | Butiken</title></head><body>
    <a href="https://butiken.se/p/julia?ben=ek&amp;tyg=lin">Julia 3-sits soffa</a></body></html>`;
  const produkt = `<html><head><title>Julia 3-sits soffa | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/julia.jpg"></head><body></body></html>`;
  await withWeb(
    {
      "https://butiken.se/soffor": { body: kategori },
      "https://butiken.se/p/julia?ben=ek&tyg=lin": { body: produkt },
      "https://butiken.se/img/julia.jpg": { type: IMAGE },
      ...searchAnswers("<html><body>inga träffar</body></html>"),
    },
    async () => {
      const [c] = await resolveCandidateImages([candidate("Julia")], [source("https://butiken.se/soffor")]);
      assert.equal(c.imageUrl, lokal("https://butiken.se/img/julia.jpg"));
    },
  );
});

/**
 * Tiden är slut — och det är ett besked, inte en tystnad.
 *
 * Jaktens steg hade var sitt tak men inget gemensamt, och taken multiplicerar: åtta steg, och två av
 * dem frågar fem sökmotorer för varje kandidat som saknar bild. En kandidatlista kunde på sina egna
 * tak hålla på i flera minuter, och hela den tiden stod `imageUrl` som `undefined` — "letar
 * fortfarande" — så väljarskärmen visade en skimrande platshållare som aldrig tog slut.
 *
 * Det viktiga är därför inte bara ATT jakten slutar, utan att den som blir utan får sitt `null`. Och
 * att den som redan hittat sin bild behåller den: en tidsgräns ska kosta letandet, aldrig fynden.
 */
test("när tiden är ute får den som saknar bild ett nej, inte fortsatt väntan", async () => {
  const alexSida = `<html><head><title>Alex fåtölj | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/alex.jpg"></head><body></body></html>`;
  await withWeb(
    {
      "https://butiken.se/alex": { body: alexSida },
      "https://butiken.se/img/alex.jpg": { type: IMAGE },
      // Svaret på Julia FINNS där ute. Det är bara ingen som hinner fråga efter det.
      ...searchAnswers(`<html><body><a href="https://butiken.se/p/julia">Julia 3-sits</a></body></html>`),
    },
    async (calls) => {
      const out = await resolveCandidateImages(
        [candidate("Alex"), candidate("Julia")],
        [source("https://butiken.se/alex")],
        undefined,
        // Budgeten är slut redan när slingan börjar — det är läget efter en lång första runda.
        0,
      );
      assert.equal(out[0].imageUrl, lokal("https://butiken.se/img/alex.jpg"), "en tidsgräns kostar letandet, inte fynden");
      assert.equal(out[1].imageUrl, null, "ingen bild hittades — sagt rakt ut, så skärmen slutar vänta");
      assert.equal(
        calls.some((call) => ENGINES.some((e) => call.includes(e))),
        false,
        "ingen motor frågas efter att tiden gått ut",
      );
    },
  );
});

// ─── Produktsidor ur forskningen, och aldrig en begagnatsajt ──────────────────

test("modellens egna produktsidor används — och en begagnatannons hämtas aldrig, hur bra bilden än vore", async () => {
  const katalog = `<html><head><title>NORRNÄS stol | Retro Katalog</title>
    <meta property="og:image" content="https://retro.se/media/norrnas.jpg"></head><body><h1>NORRNÄS stol</h1></body></html>`;
  const annons = `<html><head><title>IKEA NORRNÄS stolar | Tradera</title>
    <meta property="og:image" content="https://img.tradera.net/norrnas-i-nagons-hem.jpg"></head><body>IKEA NORRNÄS</body></html>`;
  await withWeb(
    {
      "https://retro.se/katalog/norrnas": { body: katalog },
      "https://retro.se/media/norrnas.jpg": { type: IMAGE },
      "https://www.tradera.com/item/1/ikea-norrnas": { body: annons },
      "https://img.tradera.net/norrnas-i-nagons-hem.jpg": { type: IMAGE },
    },
    async (calls) => {
      const c0: ModelCandidate = {
        ...candidate("NORRNÄS"),
        brand: "IKEA",
        sourceUrl: "https://www.tradera.com/item/1/ikea-norrnas",
        productPages: ["https://retro.se/katalog/norrnas", "https://www.blocket.se/annons/x/ikea-norrnas"],
      };
      const [c] = await resolveCandidateImages([c0], []);
      assert.equal(c.imageUrl, lokal("https://retro.se/media/norrnas.jpg"));
      assert.equal(c.imageSource, "https://retro.se/katalog/norrnas");
      assert.ok(!calls.some((x) => /tradera|blocket/.test(x)), `begagnatsajter hämtades: ${calls.filter((x) => /tradera|blocket/.test(x)).join(", ")}`);
    },
  );
});

test("finns bara en begagnatannons att gå på blir svaret 'ingen bild' (null) — aldrig en bild ur någon annans hem, aldrig 'letar'", async () => {
  const annons = `<html><head><title>IKEA NORRNÄS stolar | Tradera</title>
    <meta property="og:image" content="https://img.tradera.net/x.jpg"></head><body>IKEA NORRNÄS</body></html>`;
  await withWeb(
    {
      "https://www.tradera.com/item/1/ikea-norrnas": { body: annons },
      "https://img.tradera.net/x.jpg": { type: IMAGE },
    },
    async (calls) => {
      const [c] = await resolveCandidateImages(
        [{ ...candidate("NORRNÄS"), brand: "IKEA", sourceUrl: "https://www.tradera.com/item/1/ikea-norrnas" }],
        [],
        undefined,
        2_000,
      );
      assert.equal(c.imageUrl, null, "null = ingen bild hittades; undefined hade fått rutan att skimra för evigt");
      assert.ok(!calls.some((x) => /tradera\.(com|net)/.test(x)));
    },
  );
});

// ─── Bilder som inte är produktbilder ────────────────────────────────────────────────────────────
//
// Mätt i en riktig körning (2026-10-21, Sits): Brandon fick en reklambanner med tillverkarens logga och Quattro solstolar ur en butiks
// träfflista. Ingen av dem var en bild av möbeln, och ingenting jämförde dem någonsin med säljarens. Spärrarna nedan är billiga och
// bygger inte på något anrop till modellen: en bred banner är ingen produktbild, och en träfflista är ingen produktsida.

const BANNER = await sharp({ create: { width: 1200, height: 630, channels: 3, background: { r: 230, g: 225, b: 215 } } }).jpeg().toBuffer();

test("bannerspärren: en bild bredare än 1,75 gånger sin höjd duger inte som produktbild, en 3:2-bild och en stående gör det", () => {
  assert.equal(dugerSomProduktbild(1200, 630), false, "1,9: en reklambanner");
  assert.equal(dugerSomProduktbild(1920, 1080), false, "1,78: en hjältebild");
  assert.equal(dugerSomProduktbild(900, 600), true, "1,5: en vanlig produktbild");
  assert.equal(dugerSomProduktbild(600, 900), true, "stående");
  assert.equal(dugerSomProduktbild(500, 500), true, "kvadratisk");
  assert.equal(dugerSomProduktbild(150, 150), false, "en ikon");
});

test("en sidas bannerbild lånas inte ut — nästa bild på sidan får chansen", async () => {
  const produkt = `<html><head><title>Brandon fåtölj | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/sits-banner.jpg"></head>
    <body><img src="https://butiken.se/img/brandon-fatolj.jpg" width="600" height="450" alt="Brandon fåtölj"></body></html>`;
  await withWeb(
    {
      "https://butiken.se/p/brandon-fatolj": { body: produkt },
      "https://butiken.se/img/sits-banner.jpg": { type: IMAGE, bytes: BANNER },
      "https://butiken.se/img/brandon-fatolj.jpg": { type: IMAGE },
    },
    async () => {
      const [c] = await resolveCandidateImages([{ ...candidate("Brandon"), sourceUrl: "https://butiken.se/p/brandon-fatolj" }], []);
      assert.equal(c.imageUrl, lokal("https://butiken.se/img/brandon-fatolj.jpg"), "produktbilden, inte bannern");
    },
  );
});

test("finns bara en banner att gå på blir svaret 'ingen bild' (null) — hellre säljarens egen bild än en reklambanner", async () => {
  const produkt = `<html><head><title>Brandon fåtölj | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/sits-banner.jpg"></head><body></body></html>`;
  await withWeb(
    {
      "https://butiken.se/p/brandon-fatolj": { body: produkt },
      "https://butiken.se/img/sits-banner.jpg": { type: IMAGE, bytes: BANNER },
      ...searchAnswers("<html><body>inga träffar</body></html>"),
    },
    async () => {
      const [c] = await resolveCandidateImages([{ ...candidate("Brandon"), sourceUrl: "https://butiken.se/p/brandon-fatolj" }], []);
      assert.equal(c.imageUrl, null);
    },
  );
});

test("en miniatyr som lades på disk före bannerspärren används inte vid nästa uppslag", async () => {
  const dir = process.env.LOOPA_KANDIDATBILDER_DIR!;
  const url = "https://butiken.se/img/gammal-banner.jpg";
  const namn = `${createHash("sha1").update(url).digest("hex")}.jpg`;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, namn), await sharp({ create: { width: 400, height: 210, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg().toBuffer());
  await withWeb({ [url]: { type: IMAGE, bytes: BANNER } }, async () => {
    assert.equal(await lokalKandidatbild(url, null), null, "den kvarliggande bannern gäller inte, och hämtningen av den nya avvisas också");
  });
});

test("träfflistan en sökmotor lämnar ut lånas aldrig ut som kandidatens sida, hur tydligt adressen än nämner modellen", async () => {
  assert.equal(isListingPage("https://folkhemmet.com/search?type=article,page,product&options%5Bprefix%5D=last&q=Quattro&sort_by=relevance"), true);
  assert.equal(isListingPage("https://butiken.se/sok?q=Oxford"), true);
  assert.equal(isListingPage("https://butiken.se/search/results"), true);
  assert.equal(isListingPage("https://www.ikea.com/se/sv/p/nordviken-barstol-svart-s90351234/"), false);
  assert.equal(isListingPage("https://sits.eu/collection/impulse/"), false);

  const traffar = `<html><body><a href="https://butiken.se/search?q=Quattro">Quattro</a></body></html>`;
  const lista = `<html><head><title>Quattro – Sök | Butiken</title>
    <meta property="og:image" content="https://butiken.se/img/solstolar.jpg"></head><body></body></html>`;
  await withWeb(
    {
      ...searchAnswers(traffar),
      "https://butiken.se/search?q=Quattro": { body: lista },
      "https://butiken.se/img/solstolar.jpg": { type: IMAGE },
    },
    async () => {
      const [c] = await resolveCandidateImages([candidate("Quattro")], []);
      assert.equal(c.imageUrl, null, "solstolar ur en träfflista är ingen bild av Quattro");
      assert.equal(c.pageSpecs ?? undefined, undefined, "och dess tabeller hör inte heller till modellen");
    },
  );
});

// ─── Möbeltypen på bilden (2026-10-29) ───────────────────────────────────────────────────────────────────────────────────────────────────
//
// Fältprov med Sits: fyra förslag på FÅTÖLJER visades med hörnsoffor. Märkets kollektionssida bär modellen i alla utföranden och en soffa som huvudbild.

test("typfamilj och texterna: armchair är en fåtölj, inte en stol, och en kollektionssida säger ingenting om typen", () => {
  assert.equal(typfamilj("fåtölj"), "fatolj");
  assert.equal(typfamilj("Armchair"), "fatolj");
  assert.equal(typfamilj("hörnsoffa"), "soffa");
  assert.equal(typfamilj("matstol"), "stol");
  assert.equal(typfamilj("soffa och fåtölj"), null, "två typer i ett svar säger inget entydigt");
  assert.equal(typfamilj(null), null);
  assert.equal(typfamilj("möbel"), null);
  assert.deepEqual([...familjerI("Sits Brandon Armchair | Snug")], ["fatolj"]);
  assert.deepEqual([...familjerI("https://www.snug-interiors.com/sits-brandon-armchair/p661")], ["fatolj"]);
  assert.equal(familjerI("Stella furniture collection | Sits").size, 0);
  assert.equal(motsagerTyp("Hugo sofa | Butiken", "fatolj"), true);
  assert.equal(motsagerTyp("Stella furniture collection", "fatolj"), false);
  assert.equal(motsagerTyp("Ektorp 3-sits soffa", "soffa"), false);
  assert.equal(bekraftarTyp("Ektorp 3-sits soffa", "soffa"), true);
  assert.equal(engelskTyp("fåtölj"), "armchair");
  assert.equal(engelskTyp(null), null);
});

const fatolj = (model: string): ModelCandidate => ({ ...candidate(model), productType: "fåtölj" });
const kollektionssida = (modell: string, bild: string) =>
  `<html><head><title>${modell} furniture collection | Sits</title><meta property="og:image" content="${bild}"></head><body></body></html>`;

/** Ett eget svar på "är bilden ett foto av en fåtölj?" — ett för alla bilder, eller en funktion av bildens adress hos oss — och en logg över vilka bilder som faktiskt frågades. */
async function medBildkontroll(svar: boolean | null | ((lokalAdress: string) => boolean | null), fn: (fragade: string[]) => Promise<void>): Promise<void> {
  const fragade: string[] = [];
  glomBildtypsavgoranden();
  settBildtypKontroll(async (_bytes, _fam, lokalAdress) => {
    fragade.push(lokalAdress);
    return typeof svar === "function" ? svar(lokalAdress) : svar;
  });
  try {
    await fn(fragade);
  } finally {
    settBildtypKontroll(null);
    glomBildtypsavgoranden();
  }
}

test("en återförsäljarsida som säger 'armchair' går före kollektionssidan, så kollektionssidans soffbild behöver aldrig prövas", async () => {
  await medBildkontroll(() => true, async (fragade) => {
    await withWeb(
      {
        "https://sits.eu/collection/stella/": { body: kollektionssida("Stella", "https://sits.eu/img/stella-horn.jpg") },
        "https://butiken.se/sits-stella-armchair": { body: `<html><head><title>Sits Stella armchair | Butiken</title><meta property="og:image" content="https://butiken.se/img/stella-fatolj.jpg"></head></html>` },
        "https://sits.eu/img/stella-horn.jpg": { type: IMAGE },
        "https://butiken.se/img/stella-fatolj.jpg": { type: IMAGE },
      },
      async () => {
        const [c] = await resolveCandidateImages([fatolj("Stella")], [source("https://sits.eu/collection/stella/", 1), source("https://butiken.se/sits-stella-armchair", 3)]);
        assert.equal(c.imageUrl, lokal("https://butiken.se/img/stella-fatolj.jpg"));
        assert.equal(c.imageSource, "https://butiken.se/sits-stella-armchair");
        assert.deepEqual(fragade, [lokal("https://butiken.se/img/stella-fatolj.jpg")], "bara den valda bilden prövas");
      },
    );
  });
});

test("en måttritning eller en soffbild på rätt sida förkastas, och sidans nästa bild får chansen", async () => {
  const sida = `<html><head><title>Sits Impulse armchair | Butiken</title><meta property="og:image" content="https://butiken.se/img/ritning.webp"></head>
    <body><img src="https://butiken.se/img/foto.jpg" width="900" height="900" alt=""></body></html>`;
  await medBildkontroll((a) => a === lokal("https://butiken.se/img/foto.jpg"), async (fragade) => {
    await withWeb(
      { "https://butiken.se/impulse": { body: sida }, "https://butiken.se/img/ritning.webp": { type: IMAGE }, "https://butiken.se/img/foto.jpg": { type: IMAGE } },
      async () => {
        const [c] = await resolveCandidateImages([fatolj("Impulse")], [source("https://butiken.se/impulse", 1)]);
        assert.equal(c.imageUrl, lokal("https://butiken.se/img/foto.jpg"), "ritningen (sidans og:image) visar inte fåtöljen som ett foto");
        assert.equal(fragade.length, 2);
      },
    );
  });
});

test("modellnamnet som bara förekommer en gång i en annan produkts sida ('Casa Nova Einrichtungen') ger ingen bild åt Nova", async () => {
  const sida = `<html><head><title>SIRI - Armchairs from SITS | Architonic</title><meta property="og:image" content="https://arch.se/siri.jpg"></head>
    <body><a href="https://arch.se/casa-nova-einrichtungen"><img alt="Casa Nova Einrichtungen" src="https://arch.se/logos/casa-nova-einrichtungen-logo.png"></a>
    <a href="https://arch.se/casa-nova-einrichtungen/kontakt">Kontakt</a><script>var r = {"name":"Casa Nova Einrichtungen","slug":"casa-nova-einrichtungen"};</script>
    Siri Siri Siri armchair. Retailer: Casa Nova Einrichtungen. Siri</body></html>`;
  await medBildkontroll(true, async () => {
    await withWeb(
      { "https://arch.se/siri": { body: sida }, "https://arch.se/siri.jpg": { type: IMAGE } },
      async () => {
        const [c] = await resolveCandidateImages([fatolj("Nova")], [source("https://arch.se/siri", 1)]);
        assert.equal(c.imageUrl, null, "ett ord i ett butiksnamn är ingen sida om Nova");
      },
    );
  });
});

test("kollektionssidans bild prövas: visar den fel typ används den inte, och kandidaten blir utan bild i stället för med en soffa", async () => {
  await medBildkontroll(false, async (fragade) => {
    await withWeb(
      { "https://sits.eu/collection/stella/": { body: kollektionssida("Stella", "https://sits.eu/img/stella-horn.jpg") }, "https://sits.eu/img/stella-horn.jpg": { type: IMAGE } },
      async () => {
        const [c] = await resolveCandidateImages([fatolj("Stella")], [source("https://sits.eu/collection/stella/", 1)]);
        assert.equal(c.imageUrl, null, "en soffa i stället för fåtöljen är värre än en tom ruta");
        assert.equal(fragade.length, 1, "bilden frågades en gång, inte en gång per jaktsteg");
      },
    );
  });
});

test("visar kollektionssidans bild rätt typ, eller går kontrollen inte att göra, behålls bilden", async () => {
  for (const svar of [true, null]) {
    await medBildkontroll(svar, async () => {
      await withWeb(
        { "https://sits.eu/collection/stella/": { body: kollektionssida("Stella", "https://sits.eu/img/stella.jpg") }, "https://sits.eu/img/stella.jpg": { type: IMAGE } },
        async () => {
          const [c] = await resolveCandidateImages([fatolj("Stella")], [source("https://sits.eu/collection/stella/", 1)]);
          assert.equal(c.imageUrl, lokal("https://sits.eu/img/stella.jpg"), `svar ${svar}`);
        },
      );
    });
  }
});

test("en sida vars titel säger 'sofa' är ingen sida om en fåtölj: varken bild eller mått lånas därifrån", async () => {
  await medBildkontroll(true, async (fragade) => {
    await withWeb(
      { "https://butiken.se/hugo": { body: `<html><head><title>Hugo sofa | Butiken</title><meta property="og:image" content="https://butiken.se/img/hugo.jpg"></head></html>` }, "https://butiken.se/img/hugo.jpg": { type: IMAGE } },
      async () => {
        const [c] = await resolveCandidateImages([fatolj("Hugo")], [source("https://butiken.se/hugo", 1)]);
        assert.equal(c.imageUrl, null);
        assert.equal(c.imageSource, null);
        assert.equal(fragade.length, 0);
      },
    );
  });
});

test("registret nycklas på typen: Brandon som fåtölj och Brandon som soffa är två bilder", async () => {
  await medBildkontroll(true, async () => {
    await withWeb(
      { "https://sits.eu/collection/brandon/": { body: kollektionssida("Brandon", "https://sits.eu/img/brandon.jpg") }, "https://sits.eu/img/brandon.jpg": { type: IMAGE } },
      async () => {
        await resolveCandidateImages([fatolj("Brandon")], [source("https://sits.eu/collection/brandon/", 1)]);
        assert.equal(await registreradKandidatbild("Sits", "Brandon", "fatolj"), lokal("https://sits.eu/img/brandon.jpg"));
        assert.equal(await registreradKandidatbild("Sits", "Brandon", "soffa"), null, "fåtöljens bild lånas inte ut till soffan");
        assert.equal(await registreradKandidatbild("Sits", "Brandon"), null);
      },
    );
  });
});

test("galleriet på kollektionssidan: filen vars namn säger modellen OCH fåtölj väljs framför huvudbildens hörnsoffa", async () => {
  const galleri = Array.from({ length: 8 }, (_, i) => i === 6 ? "IMPULSE_armchair_aniline_1_latte_2.webp" : i === 7 ? "JENNY_armchair_wide.webp" : `IMPULSE_3seater_kin_${i}.webp`)
    .map((f) => `<img src="https://sits.eu/static/${f}" width="1200" height="800" alt="">`).join("");
  const sida = `<html><head><title>Impulse furniture collection | Sits</title><meta property="og:image" content="https://sits.eu/og-image.jpg"></head><body>${galleri}</body></html>`;
  await medBildkontroll((a) => a === lokal("https://sits.eu/static/IMPULSE_armchair_aniline_1_latte_2.webp"), async (fragade) => {
    await withWeb(
      { "https://sits.eu/collection/impulse/": { body: sida }, "https://sits.eu/og-image.jpg": { type: IMAGE }, "https://sits.eu/static/IMPULSE_armchair_aniline_1_latte_2.webp": { type: IMAGE } },
      async () => {
        const [c] = await resolveCandidateImages([fatolj("Impulse")], [source("https://sits.eu/collection/impulse/", 1)]);
        assert.equal(c.imageUrl, lokal("https://sits.eu/static/IMPULSE_armchair_aniline_1_latte_2.webp"));
        assert.equal(fragade[0], lokal("https://sits.eu/static/IMPULSE_armchair_aniline_1_latte_2.webp"), "filen vars namn säger modellen och typen prövas först — soffbilden i og:image kommer aldrig före");
      },
    );
  });
});

test("en fil som säger en ANNAN typ i namnet väljs aldrig för en fåtölj, och en annan modells fil räcker inte som bevis", async () => {
  const sida = `<html><head><title>Impulse furniture collection | Sits</title></head><body>
    <img src="https://sits.eu/static/IMPULSE_3seater_kin.webp" width="1200" height="800" alt="">
    <img src="https://sits.eu/static/JENNY_armchair_wide.webp" width="1200" height="800" alt=""></body></html>`;
  await medBildkontroll(false, async (fragade) => {
    await withWeb(
      { "https://sits.eu/collection/impulse/": { body: sida }, "https://sits.eu/static/IMPULSE_3seater_kin.webp": { type: IMAGE }, "https://sits.eu/static/JENNY_armchair_wide.webp": { type: IMAGE } },
      async () => {
        const [c] = await resolveCandidateImages([fatolj("Impulse")], [source("https://sits.eu/collection/impulse/", 1)]);
        assert.equal(c.imageUrl, null, "soffan är utesluten på namnet, Jennys fåtölj prövas som vilken bild som helst — och visar inte Impulse-saken ens");
        assert.equal(fragade.length, 1, "bara Jennys fil frågades: soffans namn dömde den ut utan en titt");
      },
    );
  });
});
