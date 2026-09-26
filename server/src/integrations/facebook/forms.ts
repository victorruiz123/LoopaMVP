/**
 * Formulärhjälpare som Marketplace-formuläret och gruppernas "Sälj något"-dialog delar.
 *
 * Båda ytorna är samma Facebook-formulär i två skal: sidan /marketplace/create/item och dialogen
 * "Vara till salu" i en köp/sälj-grupp (VERIFIERAT 2026-09-26: samma fält, samma etiketter, samma
 * skickalternativ, samma "Mer information"). Därför tar varje hjälpare ett `scope` — sidan eller
 * dialogen — och letar bara där. Tangentbordet hör alltid till sidan.
 */

import type { Locator, Page } from "playwright";

export type Scope = Page | Locator;

/** Prisfältet i en annan valuta än kronor. Ett pris i dollar för en möbel i kronor är ett falskt pris. */
export const NON_SEK = /[$€£]|USD|EUR|GBP/;

export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Ett textfält via etikett, med selektor som reserv. Sant när något fylldes i. */
export async function fillField(scope: Scope, labels: RegExp[], selector: string, value: string): Promise<boolean> {
  const candidates = [...labels.map((l) => scope.getByLabel(l).first()), scope.locator(selector).first()];
  for (const field of candidates) {
    try {
      if ((await field.count()) === 0) continue;
      await field.click({ timeout: 3000 });
      await field.fill("");
      await field.fill(value, { timeout: 5000 });
      return true;
    } catch {
      // Nästa kandidat.
    }
  }
  return false;
}

/** Prisfältets visade värde — Facebook formaterar det med kontots valuta ("$1 000", "1 000 kr"). */
export async function priceShown(scope: Scope, selector: string): Promise<string | null> {
  for (const field of [scope.getByLabel(/^Pris$/i).first(), scope.getByLabel(/^Price$/i).first(), scope.locator(selector).first()]) {
    if ((await field.count()) > 0) return (await field.inputValue().catch(() => null))?.trim() ?? null;
  }
  return null;
}

/**
 * Skicket: en label med role=combobox som öppnar en lista med role=option (VERIFIERAT). Exakt text
 * först, delsträng som reserv. Läser tillbaka vad rutan visar — antar inte att klicket tog.
 */
export async function pickCondition(page: Page, scope: Scope, openerSelector: string, optionSelector: string, candidates: string[]): Promise<string | null> {
  const opener = scope.locator(openerSelector).first();
  if ((await opener.count()) === 0) return null;
  for (const label of candidates) {
    try {
      await opener.click({ timeout: 4000 });
      await page.waitForTimeout(800);
      const exact = page.locator(optionSelector).filter({ hasText: new RegExp(`^\\s*${escapeRe(label)}\\s*$`, "i") }).first();
      const loose = page.locator(optionSelector).filter({ hasText: label }).first();
      const target = (await exact.count()) > 0 ? exact : loose;
      if ((await target.count()) === 0 || !(await target.isVisible().catch(() => false))) {
        await page.keyboard.press("Escape").catch(() => undefined);
        continue;
      }
      await target.click({ timeout: 3000 });
      await page.waitForTimeout(600);
      const shown = (await opener.innerText().catch(() => "")).replace(/\s+/g, " ");
      if (shown.toLowerCase().includes(label.toLowerCase())) return label;
    } catch {
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }
  return null;
}

/** Platsen: skriv orten, välj första förslaget som nämner den, läs tillbaka fältet. */
export async function fillLocation(page: Page, scope: Scope, fieldSelector: string, optionSelector: string, location: string): Promise<string | null> {
  const field = scope.locator(fieldSelector).first();
  if ((await field.count()) === 0) return null;
  try {
    const before = (await field.inputValue().catch(() => "")) ?? "";
    if (before.trim().toLowerCase() === location.toLowerCase()) return before;
    await field.click({ timeout: 3000 });
    await field.fill("");
    await page.keyboard.type(location, { delay: 50 });
    await page.waitForTimeout(2000);
    const suggestion = page.locator(optionSelector).filter({ hasText: new RegExp(escapeRe(location), "i") }).first();
    if (await suggestion.isVisible({ timeout: 3000 }).catch(() => false)) await suggestion.click().catch(() => undefined);
    await page.waitForTimeout(1000);
    return (await field.inputValue().catch(() => null)) || location;
  } catch {
    return null;
  }
}

/** Det Facebook själv markerar som fel eller saknat. */
export async function visibleFieldErrors(scope: Scope, selector: string): Promise<string[]> {
  return scope
    .locator(selector)
    .evaluateAll((els) =>
      els
        .map((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter((t) => t && t.length < 160),
    )
    .catch(() => []);
}

/**
 * Läget på en brytare eller kryssruta: sant, falskt, eller null när elementet inte bär något läge
 * alls. Letar på elementet självt och i dess barn — Facebooks rader är knappar med brytaren inuti.
 */
export async function readToggle(row: Locator): Promise<boolean | null> {
  return row
    .evaluate((el) => {
      const nodes = [el, ...Array.from(el.querySelectorAll("*"))] as HTMLElement[];
      for (const n of nodes) {
        const checked = n.getAttribute("aria-checked") ?? n.getAttribute("aria-pressed");
        if (checked === "true") return true;
        if (checked === "false") return false;
        if (n instanceof HTMLInputElement && (n.type === "checkbox" || n.type === "radio")) return n.checked;
      }
      return null;
    })
    .catch(() => null);
}
