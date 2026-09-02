/**
 * Köpsidans adresser.
 *
 * `/kop/analysera` ÄGS INTE HÄR. Den vägen tillhör Trygg affär sedan tidigare (affar/router.ts), och
 * App.tsx prövar den routern först. Att flytta in den hit hade betytt att köpsidan måste känna till
 * affärsrummets tillstånd — och att flytta ut den hade brutit varje länk som redan delats.
 */

import { useEffect, useState } from "react";

export const KOP_ROOT = "/kop";

export type KopRoute =
  | { name: "landing" }
  | { name: "mina" }
  /** Efterlysningsväggen. Egen adress och inte /kop/efterlyses: den är riktad till SÄLJARE. */
  | { name: "vagg"; kategori: string | null };

/** Sant för de adresser köpsidan äger. `/kop/analysera` undantas — se filens topp. */
export function isKopPath(pathname: string): boolean {
  if (pathname.startsWith("/kop/analysera")) return false;
  if (pathname === "/efterlyses" || pathname.startsWith("/efterlyses/")) return true;
  return pathname === KOP_ROOT || pathname === `${KOP_ROOT}/` || pathname.startsWith(`${KOP_ROOT}/mina-efterlysningar`);
}

export function parseKopPath(pathname: string): KopRoute {
  if (pathname === "/efterlyses" || pathname === "/efterlyses/") return { name: "vagg", kategori: null };
  if (pathname.startsWith("/efterlyses/")) {
    const slug = pathname.slice("/efterlyses/".length).replace(/\/+$/, "");
    return { name: "vagg", kategori: slug ? decodeURIComponent(slug) : null };
  }
  if (pathname.startsWith(`${KOP_ROOT}/mina-efterlysningar`)) return { name: "mina" };
  return { name: "landing" };
}

export function kopHref(route: KopRoute): string {
  if (route.name === "mina") return `${KOP_ROOT}/mina-efterlysningar`;
  if (route.name === "vagg") return route.kategori ? `/efterlyses/${route.kategori}` : "/efterlyses";
  return KOP_ROOT;
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
