/**
 * Efterlysningarnas adresser.
 *
 * ROTEN `/kop` ÄGS INTE LÄNGRE HÄR. Landningssidan som låg där är borttagen, och adressen 301:as av
 * servern till butiken. Kvar är de två vägar som bär någons faktiska efterlysningar — den egna listan
 * och väggen — och de behåller sina adresser eftersom de står i delade länkar och i notiser vi redan
 * skickat.
 *
 * `/kop/analysera` ÄGS INTE HELLER HÄR. Den vägen tillhör Trygg affär (affar/router.ts), och App.tsx
 * prövar den routern först. Att flytta in den hit hade betytt att den här modulen måste känna till
 * affärsrummets tillstånd — och att flytta ut den hade brutit varje länk som redan delats.
 */

import { useEffect, useState } from "react";

export const KOP_ROOT = "/kop";

export type KopRoute =
  | { name: "mina" }
  /** Efterlysningsväggen. Egen adress och inte /kop/efterlyses: den är riktad till SÄLJARE. */
  | { name: "vagg"; kategori: string | null };

/**
 * Sant för de adresser modulen äger. `/kop/analysera` undantas — se filens topp.
 *
 * ROTEN INGÅR INTE. `/kop` var landningssidan; nu finns ingen vy att rita där, och adressen ska nå
 * serverns 301 till butiken i stället för att fångas här och bli en tom ram.
 */
export function isKopPath(pathname: string): boolean {
  if (pathname.startsWith("/kop/analysera")) return false;
  if (pathname === "/efterlyses" || pathname.startsWith("/efterlyses/")) return true;
  return pathname.startsWith(`${KOP_ROOT}/mina-efterlysningar`);
}

export function parseKopPath(pathname: string): KopRoute {
  if (pathname.startsWith(`${KOP_ROOT}/mina-efterlysningar`)) return { name: "mina" };
  if (pathname.startsWith("/efterlyses/")) {
    const slug = pathname.slice("/efterlyses/".length).replace(/\/+$/, "");
    return { name: "vagg", kategori: slug ? decodeURIComponent(slug) : null };
  }
  // Allt annat som når hit är väggen: `isKopPath` släpper bara in de två.
  return { name: "vagg", kategori: null };
}

export function kopHref(route: KopRoute): string {
  if (route.name === "mina") return `${KOP_ROOT}/mina-efterlysningar`;
  return route.kategori ? `/efterlyses/${route.kategori}` : "/efterlyses";
}

export function kopNavigate(route: KopRoute): void {
  window.history.pushState({}, "", kopHref(route));
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function useKopRoute(): KopRoute {
  const [route, setRoute] = useState(() => parseKopPath(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseKopPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}
