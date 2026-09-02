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
  | { name: "mina" };

/** Sant för de adresser köpsidan äger. `/kop/analysera` undantas — se filens topp. */
export function isKopPath(pathname: string): boolean {
  if (pathname.startsWith("/kop/analysera")) return false;
  return pathname === KOP_ROOT || pathname === `${KOP_ROOT}/` || pathname.startsWith(`${KOP_ROOT}/mina-efterlysningar`);
}

export function parseKopPath(pathname: string): KopRoute {
  if (pathname.startsWith(`${KOP_ROOT}/mina-efterlysningar`)) return { name: "mina" };
  return { name: "landing" };
}

export function kopHref(route: KopRoute): string {
  return route.name === "mina" ? `${KOP_ROOT}/mina-efterlysningar` : KOP_ROOT;
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
