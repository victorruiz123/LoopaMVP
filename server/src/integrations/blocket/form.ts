/**
 * Att fylla i ett formulär som är byggt av web components.
 *
 * HELA FILEN VILAR PÅ EN MÄTNING. Blockets annonsformulär är Warp-komponenter (`w-select`,
 * `w-textfield`, `w-textarea`, `w-radio`, `w-button`) och de riktiga fälten ligger i varje komponents
 * shadow root. Uppmätt på formulärsidan den 8 september 2026:
 *
 *     document.querySelectorAll i light-DOM :  0 inputs, 0 selects, 0 textareas
 *     Playwrights locators                  :  3 inputs, 1 select, 1 textarea
 *
 * Locators går genom öppna shadow roots; `page.evaluate(() => document.querySelectorAll(...))` gör
 * det inte. Allt som gick den vägen var alltså BLINT — fem av de sju buggarna i railway-proxy v40
 * hade den grundorsaken. Regeln som följer av det, och som varje funktion här håller:
 *
 *   Sök ALDRIG efter fält med page.evaluate. Sök med locators, och kör evaluate FÖRST när du redan
 *   har elementet i handen.
 *
 * `document.body.innerText` är blint av samma skäl och används inte heller — sidtexten läses med
 * `page.getByText`.
 */

import type { Locator, Page } from "playwright";

/** Fältselektorn. Samma i hela filen, för "finns formuläret?" och "vilka fält finns?" är samma fråga. */
const FIELD_SELECTOR = "select, textarea, input:not([type=hidden]):not([type=file])";

/** Radioalternativ, i alla tre former Blocket kan tänkas använda. `w-radio` är den de faktiskt gör. */
const RADIO_SELECTOR = 'w-radio, input[type="radio"], [role="radio"]';

/**
 * Sant när sidan har texten. Via locator, aldrig via `document.body.innerText`.
 *
 * innerText ser inte in i komponenterna: "Frakt och leverans" står i en `w-heading` och hade räknats
 * som frånvarande. Fraktsidan hoppades då över, och annonsen fick Blockets förvalda fraktsätt.
 */
export async function pageHasText(page: Page, pattern: RegExp, timeout = 1500): Promise<boolean> {
  return await page
    .getByText(pattern)
    .first()
    .isVisible({ timeout })
    .catch(() => false);
}

/**
 * FIX 1: väntar tills formuläret har renderat fält — räknat med locators.
 *
 * Den gamla koden räknade i light-DOM, fick noll, och gav upp med "Torget-formuläret laddades inte"
 * medan formuläret syntes på skärmbilden.
 */
export async function waitForForm(page: Page, timeoutMs = 25_000): Promise<{ fields: number; visible: number }> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "okänd";
  while (Date.now() < deadline) {
    if (!/recommerce\/create/i.test(page.url())) {
      lastReason = `fel adress (${page.url()})`;
    } else {
      const fields = page.locator(FIELD_SELECTOR);
      const count = await fields.count().catch(() => 0);
      let visible = 0;
      for (let i = 0; i < Math.min(count, 10); i++) {
        if (await fields.nth(i).isVisible().catch(() => false)) visible++;
      }
      if (visible > 0) return { fields: count, visible };
      lastReason = `inga fält än (${count} i DOM)`;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`Torget-formuläret renderade aldrig några fält — ${lastReason}.`);
}

/**
 * FIX 4: klickar det första synliga alternativet, och provar `w-button` för varje textselektor.
 *
 * `button:has-text("Fortsätt")` matchar aldrig hos Blocket. Knappen är `<w-button>Fortsätt</w-button>`
 * — texten står i light-DOM UTANFÖR den `<button>` som ligger i skuggan, så has-text på `button`
 * söker i fel element. Varianten läggs till automatiskt så att ingen anropare kan glömma den.
 */
export async function clickFirstVisible(page: Page, selectors: string[], timeout = 5000): Promise<string> {
  const all: string[] = [];
  for (const sel of selectors) {
    all.push(sel);
    if (sel.startsWith("button:has-text(")) all.push(sel.replace(/^button/, "w-button"));
    if (sel.startsWith("a:has-text(")) all.push(sel.replace(/^a/, "w-button"));
  }

  const deadline = Date.now() + timeout;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    for (const sel of all) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          await el.click({ timeout: 3000 });
          return sel;
        }
      } catch (err) {
        lastError = err;
      }
    }
    await page.waitForTimeout(300);
  }
  const last = lastError instanceof Error ? ` Senast: ${lastError.message}` : "";
  throw new Error(`Hittade ingen klickbar av: ${all.slice(0, 4).join(" | ")}.${last}`);
}

/**
 * Fältet inuti en komponent, eller elementet självt när det redan ÄR fältet.
 *
 * FIX 2 i en rad. `page.getByLabel("Beskrivning")` träffar värdelementet `w-textarea`, och
 * `locator.fill()` på det dör med "Element is not an <input>, <textarea>...". Fältet ligger i
 * komponentens shadow root, och dit går en locator men inte fill() på värden.
 *
 * Taggnamn med bindestreck ÄR definitionen av ett custom element, så testet behöver inte veta vilka
 * komponenter Blocket har.
 */
async function innerField(hit: Locator): Promise<Locator> {
  const isComponent = await hit.evaluate((node) => node.tagName.includes("-")).catch(() => false);
  return isComponent ? hit.locator("input, textarea").first() : hit;
}

/** Skriver värdet och knuffar React så att fältet inte ser ifyllt ut men skickas tomt. */
async function setValue(field: Locator, text: string): Promise<void> {
  await field.click({ clickCount: 3, timeout: 2000 }).catch(() => null);
  await field.fill(text, { timeout: 5000 });
  await field.evaluate((node) => {
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    node.dispatchEvent(new Event("blur", { bubbles: true }));
  });
}

export interface FillOptions {
  timeout?: number;
  /**
   * Exakt etikettmatchning. Behövs för måtten: "Höjd" är en delsträng av "Sitthöjd", och en luddig
   * sökning fyller sitthöjden med möbelns höjd — ett fel som ser rätt ut i formuläret och syns först
   * i den publicerade annonsen.
   */
  exact?: boolean;
}

/**
 * FIX 2: fyller fältet vars etikett är `label`, och går in i komponenten när etiketten pekar på den.
 *
 * Kastar när det inte gick. Anroparen får välja om det är värt en fallback eller ett avbrott —
 * rubrik och pris är värda ett avbrott, varumärke är det inte.
 */
export async function fillByLabel(page: Page, label: string, value: string | number, opts: FillOptions = {}): Promise<string> {
  if (value === null || value === undefined || value === "") return "hoppat över";
  const text = String(value);
  const deadline = Date.now() + (opts.timeout ?? 10_000);

  while (Date.now() < deadline) {
    const hit = page.getByLabel(label, { exact: opts.exact ?? false }).first();
    if (await hit.isVisible({ timeout: 800 }).catch(() => false)) {
      try {
        await setValue(await innerField(hit), text);
        return "getByLabel";
      } catch {
        // Etiketten fanns men fältet gick inte att skriva i. Nästa varv, eller nästa strategi.
      }
    }

    // Reserv: etiketten som ett eget element, med fältet i samma rad. Söks med locators, inte i
    // document — annars är sökningen blind för precis de fält vi letar efter.
    const labelled = page
      .locator(`label:text-is("${label}"), span:text-is("${label}"), div:text-is("${label}")`)
      .first();
    if (await labelled.isVisible({ timeout: 500 }).catch(() => false)) {
      for (const scope of [labelled, labelled.locator("xpath=.."), labelled.locator("xpath=../..")]) {
        const field = scope.locator(FIELD_SELECTOR).first();
        if (await field.isVisible({ timeout: 300 }).catch(() => false)) {
          try {
            await setValue(field, text);
            return "etikettgranne";
          } catch {
            // Nästa nivå upp.
          }
        }
      }
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`Fältet "${label}" gick inte att fylla i.`);
}

/** Fyller första fältet som matchar någon av selektorerna. Fallbacken när etiketten bytt namn. */
export async function fillBySelector(page: Page, selectors: string[], value: string | number, timeout = 8000): Promise<string> {
  if (value === null || value === undefined || value === "") return "hoppat över";
  const text = String(value);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 600 }).catch(() => false)) {
        try {
          await setValue(await innerField(el), text);
          return sel;
        } catch {
          // Nästa selektor.
        }
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`Inget fält matchade: ${selectors.slice(0, 3).join(" | ")}.`);
}

export interface SelectResult {
  picked: string;
  field: string;
  listIndex: number;
  strategy: "exakt" | "börjar-med" | "innehåller" | "omvänt";
}

/**
 * FIX 3: väljer ett alternativ, och prövar ALLA listor på den strängare nivån före den luddigare.
 *
 * Utan turordningen händer det här: "Fåtöljer" ska väljas i produktlistan, men underkategorilistan
 * innehåller "Soffor och fåtöljer" — en luddig träff. Går matchningen lista för lista väljs den,
 * underkategorin skrivs om till sig själv, och produktnivån blir aldrig satt. Annonsen publiceras en
 * nivå för högt utan att något ser fel ut. Det var precis vad som hände: kategorin blev "Soffor och
 * fåtöljer" i stället för "Fåtöljer".
 *
 * Listorna räknas upp med locators (de ligger i `w-select`), och alternativen läses först när vi har
 * elementet i handen.
 */
export async function setSelectByOptionText(page: Page, optionText: string): Promise<SelectResult> {
  const target = optionText.trim().toLowerCase();
  const selects = page.locator("select");
  const count = await selects.count().catch(() => 0);

  const lists: Array<{ locator: Locator; options: Array<{ value: string; label: string }>; index: number; filled: boolean }> = [];
  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    if (!(await sel.isVisible().catch(() => false))) continue;
    if (await sel.isDisabled().catch(() => false)) continue;
    const read = await sel
      .evaluate((el) => ({
        options: Array.from((el as HTMLSelectElement).options).map((o) => ({ value: o.value, label: (o.label || o.text || "").trim() })),
        filled: Boolean((el as HTMLSelectElement).value),
      }))
      .catch(() => null);
    if (read && read.options.length > 1) lists.push({ locator: sel, options: read.options, index: i, filled: read.filled });
  }

  // Tomma listor först. En lista som redan har ett värde är en nivå vi passerat, och den ska inte
  // skrivas om av nästa nivås sökning.
  const ordered = [...lists.filter((l) => !l.filled), ...lists.filter((l) => l.filled)];

  const strategies: Array<[SelectResult["strategy"], (label: string) => boolean]> = [
    ["exakt", (l) => l === target],
    ["börjar-med", (l) => l.startsWith(target)],
    ["innehåller", (l) => l.includes(target)],
    ["omvänt", (l) => target.includes(l) && l.length > 3],
  ];

  for (const [strategy, test] of strategies) {
    for (const list of ordered) {
      const found = list.options.find((o) => o.label && test(o.label.toLowerCase()));
      if (!found) continue;
      await list.locator.selectOption(found.value);
      await list.locator.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      // Nästa nivå renderas som svar på change. Utan pausen letar vi i gårdagens DOM.
      await page.waitForTimeout(1200);
      const field = await list.locator.evaluate((el) => (el as HTMLSelectElement).name || el.id || "(namnlös)").catch(() => "(namnlös)");
      return { picked: found.label, field, listIndex: list.index, strategy };
    }
  }
  throw new Error(`Ingen lista hade alternativet "${optionText}".`);
}

export interface RadioOption {
  index: number;
  group: string | null;
  label: string;
  checked: boolean;
}

/**
 * FIX 6, halva: läser radioalternativen som de faktiskt ser ut.
 *
 * Fraktsidan har INGA `input[type=radio]` och ingen `role=radio`. Alternativen är
 * `<w-radio name="package-size">`, etiketten nås via `aria-labelledby` och valet står som ATTRIBUTET
 * `checked` på komponenten — inte som `.checked` på ett fält. Den som läser `.checked` får alltid
 * falskt och tror att inget är valt.
 *
 * `aria-labelledby` slås upp i elementets egen rot, som kan vara en shadow root: `document.getElementById`
 * hittar ingenting där.
 *
 * FÖRFADERFALLBACKEN kommer från paketsidan, som är byggd på ett helt annat sätt än fraktsidan.
 * Uppmätt den 9 september 2026 på `/recommerce/choose-products`:
 *
 *     <w-radio>  utan name, utan role, utan aria-labelledby, utan aria-label, utan egen text
 *
 * Alla tre alternativen såg alltså IDENTISKA ut — enda skillnaden var texten i förälderelementet
 * ("Bas", "Plus", "Premium"). Utan fallbacken blev varje etikett tom, och en tom etikett gick inte
 * att skilja från en annan: valet kunde varken göras på rätt alternativ eller verifieras.
 */
export async function readRadios(page: Page): Promise<RadioOption[]> {
  return await page
    .locator(RADIO_SELECTOR)
    .evaluateAll((els) =>
      els.map((el, i) => {
        const root = el.getRootNode() as Document | ShadowRoot;
        const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
        const fromIds = ids
          .map((id) => {
            const node = "getElementById" in root ? root.getElementById(id) : document.getElementById(id);
            return node ? node.textContent || "" : "";
          })
          .join(" ");
        let label = (fromIds || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();

        // Ingen etikett på själva komponenten: ta närmaste förfader som HAR text. Den första som har
        // det är kortet alternativet ligger i. Längdtaket stoppar vandringen innan den når en sektion
        // som beskriver hela sidan — en "etikett" på 400 tecken är inte en etikett.
        if (!label) {
          let node: Element | null = el;
          for (let step = 0; step < 5 && node; step++) {
            const parent: Element | null = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null);
            if (!parent) break;
            node = parent;
            const text = (node.textContent || "").replace(/\s+/g, " ").trim();
            if (text && text.length <= 140) {
              label = text;
              break;
            }
          }
        }

        return {
          index: i,
          group: el.getAttribute("name"),
          label: label.slice(0, 70),
          checked: el.hasAttribute("checked") || (el as HTMLInputElement).checked === true,
        };
      }),
    )
    .catch(() => [] as RadioOption[]);
}

export interface RadioChoice {
  ok: boolean;
  /** Alternativen som de såg ut EFTER försöket. Går valet fel är det här man ser vad som valdes. */
  options: RadioOption[];
  /** Alternativ i samma grupp som blev valda i stället. Tomt när allt gick rätt. */
  wrong: string[];
  /** Sant när alternativet redan var valt och inget behövde klickas. */
  alreadySet: boolean;
}

/**
 * FIX 6, andra halvan: väljer ett radioalternativ och VERIFIERAR att det blev valt.
 *
 * Att klicka och gå vidare räcker inte. Fraktvalet blev "Stor" — frakt med köpskydd för en fåtölj som
 * inte får plats i 120x45x45 — utan att något syntes i loggen. Samma sak med transaktionstypen, där
 * alternativet till "Sälj" är "Bortskänkes".
 */
export async function chooseRadio(page: Page, want: RegExp): Promise<RadioChoice> {
  let options = await readRadios(page);
  const target = options.find((o) => want.test(o.label));
  const group = target?.group ?? null;

  if (target?.checked) {
    return { ok: true, options, wrong: [], alreadySet: true };
  }

  if (target) {
    for (const attempt of ["komponent", "etikett"] as const) {
      try {
        if (attempt === "komponent") await page.locator(RADIO_SELECTOR).nth(target.index).click({ force: true, timeout: 4000 });
        else await page.getByText(target.label, { exact: true }).first().click({ timeout: 4000 });
      } catch {
        // Nästa väg.
      }
      await page.waitForTimeout(1200);
      options = await readRadios(page);
      if (options.some((o) => want.test(o.label) && o.checked)) break;
    }
  }

  const ok = options.some((o) => want.test(o.label) && o.checked);
  const wrong = options.filter((o) => o.checked && o.group === group && !want.test(o.label)).map((o) => o.label);
  return { ok, options, wrong, alreadySet: false };
}

/**
 * Beskrivningen i rätt textarea.
 *
 * Sidan har fler än en. Den med placeholder "bildtext" hör till bilderna — hamnar annonstexten där
 * blir beskrivningen tom och bilderna får en tusen tecken lång bildtext. Reservvägen väljer därför
 * den SISTA synliga textarean som inte är bildtextfältet, och den räknas upp med locators så att
 * `w-textarea` syns.
 */
export async function fillDescription(page: Page, text: string): Promise<"etikett" | "reserv"> {
  try {
    await fillByLabel(page, "Beskrivning", text, { timeout: 10_000 });
    return "etikett";
  } catch {
    // Reservvägen nedan.
  }

  const areas = page.locator("textarea");
  const count = await areas.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i--) {
    const area = areas.nth(i);
    if (!(await area.isVisible().catch(() => false))) continue;
    const placeholder = (await area.getAttribute("placeholder").catch(() => "")) ?? "";
    if (placeholder.toLowerCase().includes("bildtext")) continue;
    await setValue(area, text);
    return "reserv";
  }
  throw new Error("Hittade ingen textarea för beskrivningen.");
}

/**
 * Rubrikfältets nuvarande värde. Grunden för utkastvakten i publish.ts.
 *
 * Tomt när fältet inte finns — den som frågar måste själv veta om vi står på formuläret, för ett tomt
 * svar betyder både "tomt fält" och "inget fält".
 */
export async function currentTitleValue(page: Page): Promise<string> {
  const hit = page.getByLabel("Annonsrubrik", { exact: false }).first();
  if (!(await hit.isVisible({ timeout: 2000 }).catch(() => false))) return "";
  const field = await innerField(hit);
  return (await field.inputValue({ timeout: 2000 }).catch(() => "")).trim();
}

/** Stänger cookiebannern. Ligger den kvar täcker den knapparna, och varje klick landar på overlayen. */
export async function dismissCookieBanner(page: Page): Promise<void> {
  for (const sel of [
    'button:has-text("Godkänn alla")',
    'button:has-text("Acceptera alla")',
    'button:has-text("Godkänn")',
    'button:has-text("Acceptera")',
    '[id*="cookie" i] button',
    '[class*="cookie" i] button',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1200 }).catch(() => false)) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      // Nästa selektor.
    }
  }
}

/** Kampanjrutor och "påminn mig senare" som lägger sig över formuläret. */
export async function dismissModal(page: Page): Promise<void> {
  for (const sel of [
    'button:has-text("Påminn mig senare")',
    'button:has-text("Hoppa över")',
    'button[aria-label="Stäng"]',
    'button:has-text("Stäng")',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1200 }).catch(() => false)) {
        await el.click({ timeout: 2000 });
        await page.waitForTimeout(400);
        return;
      }
    } catch {
      // Nästa selektor.
    }
  }
}
