import { useSyncExternalStore } from "react";

/**
 * Dator- eller mobilvy.
 *
 * Appen är byggd som ett telefonflöde — en 480 px kolumn — och på en 27-tumsskärm låg den som en
 * smal remsa mitt i ett tomt fält. Läget avgörs därför automatiskt och kan skrivas över för hand.
 *
 * Automatiken frågar efter TVÅ saker: bredd OCH pekdon. Bara bredd hade gett datorvy åt en telefon i
 * liggande läge, och bara pekdon hade gett den åt ett smalt fönster på en laptop. `pointer: fine`
 * beskriver det primära pekdonet, så en surfplatta med mus räknas som dator — vilket den då också är.
 */
export type ViewMode = "mobile" | "desktop";

const DESKTOP_QUERY = "(min-width: 900px) and (pointer: fine)";
/** Under den här bredden finns inget val att göra, och reglaget göms. */
export const SWITCHABLE_QUERY = "(min-width: 860px)";
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

/** null = låt automatiken bestämma igen. */
export function setViewModeOverride(mode: ViewMode | null) {
  override = mode;
  try {
    if (mode) localStorage.setItem(STORAGE_KEY, mode);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* se readOverride */
  }
  notify();
}

export function isViewModeForced(): boolean {
  return override !== null;
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

/** Om reglaget är värt att visa alls — ett telefonfönster har inget att välja mellan. */
export function useCanSwitchView(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(SWITCHABLE_QUERY).matches);
}
