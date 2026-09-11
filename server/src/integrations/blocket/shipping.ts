/**
 * De två sidorna efter formuläret: frakt och annonspaket.
 *
 * Lätta att glömma och dyra att missa. Utan dem blir annonsen aldrig publicerad, och det fraktsätt
 * Blocket väljer åt oss är fel: en fåtölj får inte plats i 120x45x45 och ska inte ligga ute med
 * köpskydd och paketfrakt.
 */

import type { Page } from "playwright";
import { chooseRadio, clickFirstVisible, pageHasText, readRadios } from "./form.js";
import type { Logga } from "./diag.js";

/**
 * Fraktalternativet Loopa-möbler ska ha: ingen frakt genom Blocket.
 *
 * Annonsen lovar hemleverans med de 600 kronorna INRÄKNADE I PRISET (se hemleverans.ts), och Loopa
 * bokar budfirman efter köpet. Väljs ett av Blockets egna fraktsätt betalar köparen frakt en andra
 * gång i deras kassa — exakt det dubbeluttag som fick beloppet att bakas in i priset från början.
 * En soffa går dessutom inte som paket.
 */
const NO_SHIPPING = /jag kan inte skicka varan/i;

/**
 * FIX 6: väljer "Jag kan inte skicka varan", och kontrollerar att det blev så.
 *
 * Fraktvalet blev "Stor" i tio körningar utan att något syntes: sidan har inga `input[type=radio]`
 * och ingen `role=radio`, alternativen är `<w-radio name="package-size">` och valet står som
 * attributet `checked` på komponenten. Läsningen och verifieringen ligger i `chooseRadio`.
 *
 * Ett felval här är inte kosmetiskt. Blocket Paket lovar köparen en frakt som inte finns, och begär
 * mått och vikt vi inte har.
 */
export async function handleShippingPage(page: Page, logga: Logga): Promise<void> {
  let visible = await pageHasText(page, /frakt och leverans/i, 2000);
  if (!visible) {
    await page.waitForTimeout(2000);
    visible = await pageHasText(page, /frakt och leverans/i, 2000);
  }
  if (!visible) {
    // Fraktsidan visas inte för alla kategorier och konton. Att den saknas är inget fel.
    logga("Ingen fraktsida — går vidare", "ok", { url: page.url() });
    return;
  }
  logga("Fraktsidan visas", "ok", { url: page.url() });

  const choice = await chooseRadio(page, NO_SHIPPING);
  const target = choice.options.find((o) => NO_SHIPPING.test(o.label));

  if (!target) {
    // Alternativet finns inte. Att klicka något annat vore att välja ett fraktsätt vi inte kan hålla.
    logga('Inget alternativ hette "Jag kan inte skicka varan"', "error", { alternativ: choice.options });
    throw new Error(
      'Fraktsidan hade inget alternativ som matchade "Jag kan inte skicka varan". ' +
        "Blocket har byggt om sidan — körningen avbryts hellre än väljer ett fraktsätt Loopa inte kan hålla.",
    );
  }

  if (!choice.ok) {
    logga("Fraktvalet gick inte att sätta", "error", { valt: choice.wrong, alternativ: choice.options });
    throw new Error(
      `Kunde inte välja "Jag kan inte skicka varan" på fraktsidan${
        choice.wrong.length ? ` — sidan står kvar på "${choice.wrong.join(", ")}"` : ""
      }. Annonsen skulle annars gå ut med fel fraktsätt.`,
    );
  }

  logga(choice.alreadySet ? "Rätt fraktval var redan gjort (verifierat)" : 'Valde "Jag kan inte skicka varan" (verifierat)', "ok", {
    alternativ: choice.options,
  });

  await clickFirstVisible(page, ['button:has-text("Fortsätt")'], 8000);
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => null);
  await page.waitForTimeout(3000);
  logga("Vidare från fraktsidan", "ok", { url: page.url() });
}

/**
 * Paketsidan: väljer annonspaketet "Bas", som är gratis.
 *
 * Här ligger den enda knappen i hela flödet som kan kosta pengar. Därför slutar kedjan av strategier
 * med ett FEL i stället för med en gissning: railway-proxyn klickar på fasta koordinater när allt
 * annat misslyckats ([513, 210] och fyra till), och på just den här sidan är en felträff ett köpt
 * uppgraderingspaket. Hellre en avbruten körning än en faktura.
 */
export async function handlePackagePage(page: Page, logga: Logga): Promise<void> {
  let onPage = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    onPage =
      /choose-products/i.test(page.url()) ||
      (await pageHasText(page, /nästan klart/i, 700)) ||
      ((await pageHasText(page, /^\s*Bas\s*$/i, 500)) && (await pageHasText(page, /Gratis/i, 500)));
    if (onPage) break;
    await page.waitForTimeout(500);
  }
  if (!onPage) {
    logga("Ingen paketsida — går vidare", "ok", { url: page.url() });
    return;
  }

  logga("Paketsidan visas", "ok", { url: page.url() });
  // Korten renderas i en andra omgång, efter att sidans data hämtats.
  await page.waitForTimeout(3000);

  let picked: string | null = null;

  // Är paketen en radiogrupp går valet att göra OCH verifiera på samma sätt som fraktvalet: klicka
  // komponenten, läs tillbaka `checked`. Att i stället klicka på etiketten bredvid är en gissning —
  // den träffar en `<span>` som kanske vidarebefordrar klicket till sitt alternativ och kanske inte,
  // och på just den här sidan är skillnaden mellan gratis och betalt.
  const asRadio = await chooseRadio(page, /^bas$/i);
  if (asRadio.options.some((o) => /^bas$/i.test(o.label))) {
    if (!asRadio.ok) {
      logga("Kunde inte välja paketet Bas", "error", { alternativ: asRadio.options });
      throw new Error(
        `Kunde inte välja det gratis paketet "Bas"${asRadio.wrong.length ? ` — sidan står på "${asRadio.wrong.join(", ")}"` : ""}.`,
      );
    }
    picked = asRadio.alreadySet ? "redan valt (verifierat)" : "w-radio (verifierat)";
  }

  for (const sel of [':text-is("Bas")', 'text="Bas"']) {
    if (picked) break;
    const hits = page.locator(sel);
    const count = await hits.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const box = await hits.nth(i).boundingBox({ timeout: 2000 }).catch(() => null);
      if (!box || box.width <= 0) continue;
      await hits.nth(i).click({ timeout: 3000, force: true }).catch(() => null);
      await page.waitForTimeout(600);
      picked = `${sel}[${i}]`;
      break;
    }
  }

  if (!picked) {
    // "Gratis" står i Bas-kortet. Hittar vi det hittar vi kortet.
    const free = page.getByText("Gratis", { exact: true }).first();
    if (await free.isVisible({ timeout: 8000 }).catch(() => false)) {
      const box = await free.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
        await page.waitForTimeout(600);
        picked = "Gratis-etiketten";
      }
    }
  }

  if (!picked) {
    logga("Hittade inget gratis annonspaket", "error", { url: page.url() });
    throw new Error(
      'Kunde inte välja det gratis paketet "Bas" på paketsidan. Körningen avbryts hellre än gissar — ' +
        "ett felklick här köper ett betalt paket. Kör med BLOCKET_SYNLIG=1 och se hur sidan ser ut.",
    );
  }

  // Sista kontrollen oavsett hur valet gjordes: står ett BETALT paket som valt får körningen inte gå
  // vidare. Är sidan byggd av kort utan radioroll finns ingenting att läsa, och då säger loggen det
  // rakt ut i stället för att låta ett overifierat klick se ut som ett verifierat val.
  //
  // EN TOM ETIKETT ÄR INTE BEVIS. Det här villkoret saknade `r.label` en gång, och då avbröt vakten
  // en körning som gjort allting rätt: paketsidans alternativ bar ingen egen etikett, vårt eget
  // Bas-val lästes som en namnlös vald ruta, och felet blev "Paketsidan har ett betalt paket valt ()"
  // — med tomma parenteser, eftersom det inte fanns något att sätta dit. En vakt som inte kan namnge
  // vad den anklagar ska inte fälla körningen.
  const radios = await readRadios(page);
  const paidChecked = radios.filter((r) => r.checked && r.label && !/^bas$/i.test(r.label)).map((r) => r.label);
  if (paidChecked.length) {
    logga("Ett betalt paket är valt", "error", { valt: paidChecked });
    throw new Error(`Paketsidan har ett betalt paket valt (${paidChecked.join(", ")}). Avbryter hellre än publicerar mot en faktura.`);
  }
  logga(`Valde paketet Bas (${picked})`, "ok", {
    verifierat: radios.some((r) => /^bas$/i.test(r.label) && r.checked),
    radios,
  });
}
