import { useSyncExternalStore } from "react";

/**
 * Dator- eller mobilvy.
 *
 * Appen är byggd som ett telefonflöde — en 480 px kolumn — och på en 27-tumsskärm låg den som en
 * smal remsa mitt i ett tomt fält. Läget avgörs därför automatiskt ur fönstret.
 *
 * Ingen knapp i gränssnittet ändrar det: valet har ett rätt svar som webbläsaren redan känner till,
 * och ett reglage för det hade varit en fråga utan innehåll. Nyckeln nedan läses ändå vid start, så
 * `localStorage.setItem("loopa.view-mode", "desktop")` från konsolen tvingar fram ett läge när man
 * vill se det andra på samma skärm.
 *
 * Automatiken frågar efter TVÅ saker: bredd OCH pekdon. Bara bredd hade gett datorvy åt en telefon i
 * liggande läge, och bara pekdon hade gett den åt ett smalt fönster på en laptop. `pointer: fine`
 * beskriver det primära pekdonet, så en surfplatta med mus räknas som dator — vilket den då också är.
 */
export type ViewMode = "mobile" | "desktop";

const DESKTOP_QUERY = "(min-width: 900px) and (pointer: fine)";
/** Bredden där layouten kan byta läge alls — det är den ändringen komponenterna ska väckas av. */
const SWITCHABLE_QUERY = "(min-width: 860px)";
const STORAGE_KEY = "loopa.view-mode";

function detect(): ViewMode {
  return window.matchMedia(DESKTOP_QUERY).matches ? "desktop" : "mobile";
}

function readOverride(): ViewMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "mobile" || v === "desktop" ? v : null;
  } catch {
    // Privat läge kan kasta på localStorage. Ett minne som inte går att läsa är inget fel — det
    // betyder bara att automatiken får bestämma.
    return null;
  }
}

let override: ViewMode | null = null;
const listeners = new Set<() => void>();

function notify() {
  apply();
  listeners.forEach((l) => l());
}

function apply() {
  document.documentElement.dataset.view = getViewMode();
}

export function getViewMode(): ViewMode {
  return override ?? detect();
}

/** null = låt automatiken bestämma igen. Nås från konsolen, inte från gränssnittet. */
function setViewModeOverride(mode: ViewMode | null) {
  override = mode;
  try {
    if (mode) localStorage.setItem(STORAGE_KEY, mode);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* se readOverride */
  }
  notify();
}

/** Sätts på <html> innan React ritar första bildrutan, så layouten aldrig hoppar mellan lägena. */
export function initViewMode() {
  override = readOverride();
  apply();
  window.matchMedia(DESKTOP_QUERY).addEventListener("change", notify);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const mq = window.matchMedia(SWITCHABLE_QUERY);
  mq.addEventListener("change", listener);
  return () => {
    listeners.delete(listener);
    mq.removeEventListener("change", listener);
  };
}

export function useViewMode(): ViewMode {
  return useSyncExternalStore(subscribe, getViewMode);
}

// Handtaget för att prova det andra läget på samma skärm. Inget i appen anropar det.
(window as unknown as { loopaSetViewMode?: typeof setViewModeOverride }).loopaSetViewMode =
  setViewModeOverride;
