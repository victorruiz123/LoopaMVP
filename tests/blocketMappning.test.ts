// ─── Blocket-mappningen: översättningen som ingen märker när den går fel ─────
//
// Det som brister i en publicering är nästan alltid en översättning, och en felöversättning kraschar
// aldrig — den ger en annons i fel kategori, med fel skick eller med en rubrik som slutar mitt i ett
// ord. Ingen av dem syns förrän annonsen redan ligger uppe.
//
// Fyra saker vaktas här, och alla fyra har gått fel på riktigt:
//
// LÖVNAMNEN MÅSTE FINNAS. v40:s kategorikarta pekade på "Matstolar", "Sovrum" och "Förvaring" —
// namn som inte finns i Blockets träd. Fuzzy-matchningen i formuläret valde då något annat, och
// annonsen hamnade en nivå fel utan att någon fick veta det.
//
// RUBRIKEN SKÄRPER, FLYTTAR INTE. Slugen kommer från besiktningen och är den starkare uppgiften.
// Rubriken är säljande text som gärna nämner vad möbeln passar till, och en säng som beskrivs med
// ordet "soffa" ska inte hamna bland sofforna.
//
// UPPSKATTADE MÅTT SKRIVS INTE UT. På Loopas eget kort står en schablon som en uppskattning. I ett
// Blocket-fält finns ingen sådan reservation — där blir den ett påstående säljaren får stå för.
//
// KVITTOT ÄR INTE ANNONSEN. Kvittoadressen fungerar bara för den inloggade. Skickas den vidare får
// mottagaren en inloggningssida i stället för möbeln.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BLOCKET_CONDITION,
  BLOCKET_TREE,
  CATEGORY_BY_SLUG,
  blocketCategoryFor,
  capTitle,
  conditionOptions,
  measurementsFrom,
} from "../server/src/integrations/blocket/mapping.js";
import { isAdUrl, publicUrlFromReceipt } from "../server/src/integrations/blocket/publish.js";

test("varje slug pekar på ett löv som faktiskt finns i Blockets träd", () => {
  for (const [slug, kategori] of Object.entries(CATEGORY_BY_SLUG)) {
    assert.equal(kategori.main, "Möbler och inredning", `${slug} har fel huvudkategori`);
    assert.ok(kategori.sub, `${slug} saknar underkategori`);
    assert.ok(kategori.sub! in BLOCKET_TREE, `${slug}: underkategorin "${kategori.sub}" finns inte i trädet`);
    if (kategori.product) {
      assert.ok(
        BLOCKET_TREE[kategori.sub!].includes(kategori.product),
        `${slug}: lövet "${kategori.product}" finns inte under "${kategori.sub}"`,
      );
    }
  }
});

test("rubriken skärper lövet inom samma underkategori", () => {
  // Slugen `soffor` ger "Soffor". Ordet bäddsoffa i rubriken pekar ut ett smalare löv i SAMMA gren.
  const traff = blocketCategoryFor("soffor", "IKEA Friheten bäddsoffa i grått");
  assert.equal(traff.sub, "Soffor och fåtöljer");
  assert.equal(traff.product, "Bäddsoffor");
});

test("rubriken flyttar aldrig möbeln till en annan underkategori", () => {
  // En säng vars beskrivning nämner soffa ska stanna bland sängarna.
  const traff = blocketCategoryFor("sangar", "Säng i soffbrunt tyg, passar till soffgruppen");
  assert.equal(traff.sub, "Sängar och madrasser");
  assert.equal(traff.product, "Sängar");
});

test("längsta ordet vinner: soffbord blir bord, inte soffa", () => {
  const traff = blocketCategoryFor(null, "Svenskt soffbord i ek");
  assert.equal(traff.sub, "Bord och stolar");
  assert.equal(traff.product, "Soffbord");
});

test("utan slug och utan igenkänt ord hamnar möbeln brett men aldrig fel", () => {
  const traff = blocketCategoryFor(null, "Något helt annat");
  assert.equal(traff.sub, "Övriga möbler och inredning");
  assert.equal(traff.product, null);
});

test("skicket översätts till Blockets egen etikett först", () => {
  assert.equal(BLOCKET_CONDITION.A, "Mycket bra skick");
  assert.equal(BLOCKET_CONDITION.F, "Okej skick");
  // Nyskick är ett påstående om möbelns historia och får aldrig sättas av en bildbesiktning.
  assert.ok(!Object.values(BLOCKET_CONDITION).includes("Nyskick"));

  const alternativ = conditionOptions("Bra skick");
  assert.equal(alternativ[0], "Bra skick - varsamt använd");
  assert.ok(alternativ.length > 1, "en enda sträng räcker inte — Blocket har skrivit om etiketterna");
});

test("uppmätta mått går ut i centimeter, uppskattade går inte ut alls", () => {
  const uppmatt = measurementsFrom({ widthMm: 1995, depthMm: 900, heightMm: 745, estimated: false });
  assert.deepEqual(uppmatt, { height: 75, width: 200, depth: 90 }, "1995 mm är 200 cm för en möbel, inte 199");

  const uppskattat = measurementsFrom({ widthMm: 1995, depthMm: 900, heightMm: 745, estimated: true });
  assert.deepEqual(uppskattat, { height: null, width: null, depth: null });

  assert.deepEqual(measurementsFrom(null), { height: null, width: null, depth: null });
  assert.deepEqual(measurementsFrom({ widthMm: 0, depthMm: null, heightMm: -5, estimated: false }), {
    height: null,
    width: null,
    depth: null,
  });
});

test("rubriken kapas vid ett ordslut, inte mitt i ett ord", () => {
  const lang = "Sits Impulse fåtölj i mycket bra skick med originaltyg";
  const kapad = capTitle(lang);
  assert.ok(kapad.length <= 50);
  assert.ok(!lang.slice(kapad.length, kapad.length + 1).trim() || kapad.endsWith(kapad.split(" ").at(-1)!));
  assert.ok(!kapad.endsWith(" "));
  // Kortare rubriker rörs inte.
  assert.equal(capTitle("IKEA Strandmon"), "IKEA Strandmon");
});

test("kvittoadressen översätts till den publika annonsadressen", () => {
  assert.equal(
    publicUrlFromReceipt("https://www.blocket.se/order-and-payment/ad-receipt?adId=24720589"),
    "https://www.blocket.se/24720589",
  );
  // Attrappen kör på en annan adress — översättningen måste följa med dit.
  assert.equal(publicUrlFromReceipt("http://127.0.0.1:5000/order-and-payment/ad-receipt?adId=24720589", "http://127.0.0.1:5000"), "http://127.0.0.1:5000/24720589");
  assert.equal(publicUrlFromReceipt("https://www.blocket.se/nagot-annat"), null);
});

test("bara riktiga annonsadresser räknas som annonsadresser", () => {
  assert.ok(isAdUrl("https://www.blocket.se/24720589"));
  assert.ok(isAdUrl("https://www.blocket.se/annons/stockholm/fatolj/24720589"));
  assert.ok(isAdUrl("https://www.blocket.se/recommerce/forsale/item/24720589"));
  // Kvittot är inte annonsen.
  assert.ok(!isAdUrl("https://www.blocket.se/order-and-payment/ad-receipt?adId=24720589"));
  assert.ok(!isAdUrl("https://www.blocket.se/mina-annonser"));
});
