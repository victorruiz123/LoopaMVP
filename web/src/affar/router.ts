/**
 * Trygg affärs adresser.
 *
 * Tre vägar, och de har olika krav på vem som får se dem:
 *
 *   /kop/analysera   publik  — köparens intag. Kräver konto först när en affär ska skapas.
 *   /a/:token        publik  — säljarens inbjudan. Token ÄR åtkomsten; inget konto för att titta.
 *   /affar/:id       privat  — affärsrummet. Bara de två parterna.
 *
 * Egen router av samma skäl som butikens: de här adresserna delas i en chatt, bokmärks och backas
 * till. Säljflödet har medvetet ingen (se App.tsx).
 */

import { useEffect, useState } from "react";

export type AffarRoute =
  | { name: "intake" }
  | { name: "invite"; token: string }
  | { name: "deal"; id: string };

export function isAffarPath(pathname: string): boolean {
  return (
    pathname === "/kop/analysera" ||
    pathname.startsWith("/kop/analysera") ||
    pathname.startsWith("/a/") ||
    pathname === "/affar" ||
    pathname.startsWith("/affar/")
  );
}

export function parseAffarPath(pathname: string): AffarRoute {
  if (pathname.startsWith("/a/")) {
    const token = pathname.slice(3).replace(/\/+$/, "");
    if (token) return { name: "invite", token: decodeURIComponent(token) };
  }
  if (pathname.startsWith("/affar/")) {
    const id = pathname.slice(7).replace(/\/+$/, "");
    if (id) return { name: "deal", id: decodeURIComponent(id) };
  }
  return { name: "intake" };
}

export function affarHref(route: AffarRoute): string {
  switch (route.name) {
    case "intake": return "/kop/analysera";
    case "invite": return `/a/${encodeURIComponent(route.token)}`;
    case "deal": return `/affar/${encodeURIComponent(route.id)}`;
  }
}

export function navigate(to: AffarRoute | string): void {
  const href = typeof to === "string" ? to : affarHref(to);
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function useAffarRoute(): AffarRoute {
  const [route, setRoute] = useState(() => parseAffarPath(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseAffarPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

/**
 * Adressen som delats hit från en annan app.
 *
 * Manifestets `share_target` (web/public/manifest.webmanifest) skickar delningen som en GET med
 * `url`, `text` och `title`. Blocket-appen lägger ibland adressen i `text` i stället för i `url`, så
 * båda läses — och `text` kan innehålla både en rubrik och en länk, varför adressen plockas ut med
 * ett mönster i stället för att antas vara hela fältet.
 */
export function sharedUrlFromQuery(search: string = window.location.search): string | null {
  const q = new URLSearchParams(search);
  const direct = q.get("url")?.trim();
  if (direct) return direct;
  const text = `${q.get("text") ?? ""} ${q.get("title") ?? ""}`;
  const match = /https?:\/\/\S+/.exec(text);
  return match ? match[0] : null;
}
