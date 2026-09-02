/**
 * Butikens adresser.
 *
 * Resten av appen har ingen router med flit: säljflödet är en följd av skärmar där adressen inte
 * betyder något, och där en tillbakaknapp mitt i en filmning gör mer skada än nytta (se App.tsx).
 * Butiken är motsatsen. Varje sida ÄR en adress: den delas, bokmärks, står i ett sökresultat och
 * måste tåla att man backar. Därför finns den här — och därför bara för /butik.
 *
 * Fortfarande utan beroende. Det som behövs är att läsa en sökväg, byta den utan omladdning och
 * lyssna på bakåtknappen; det är tre webbläsar-API:er, inte ett bibliotek.
 */

import { useEffect, useState } from "react";

export const BUTIK_ROOT = "/butik";

export type ButikRoute =
  | { name: "category"; slug: string }
  | { name: "brand"; slug: string }
  | { name: "product"; id: string }
  | { name: "search"; q: string }
  | { name: "order"; id: string }
  /** Profilen. SAMMA skärm som säljverktygets — se screens/ProfileScreen.tsx. */
  | { name: "profile" };

/** Sant för varje adress butiken äger. Avgör om App.tsx ska visa butiken i stället för säljflödet. */
export function isButikPath(pathname: string): boolean {
  return pathname === BUTIK_ROOT || pathname.startsWith(`${BUTIK_ROOT}/`);
}

/**
 * Adressen som en vy.
 *
 * Okända vägar under /butik faller till landningssidan i stället för att bli en tom skärm: en död
 * länk till en borttagen kategori ska landa i butiken, inte i ingenting.
 */
export function parseButikPath(pathname: string, search: string): ButikRoute {
  const rest = pathname.slice(BUTIK_ROOT.length).replace(/^\/+|\/+$/g, "");
  const params = new URLSearchParams(search);
  if (rest === "") {
    const q = params.get("q");
    // Roten är inte längre en egen sida: köpsidan bor på /kop. En sökning behåller däremot butiken —
    // den som söker vill bläddra i lagret, inte beskriva något vi ska leta upp.
    // Roten 301:as till /kop av servern. Skulle den ändå nås — en gammal bokmärkt adress i en
    // klient som redan kört — visas hela lagret i stället för en sida som inte längre finns.
    return { name: "search", q: q ?? "" };
  }
  const [head, tail] = rest.split("/");
  if (head === "kategori" && tail) return { name: "category", slug: decodeURIComponent(tail) };
  if (head === "marke" && tail) return { name: "brand", slug: decodeURIComponent(tail) };
  if (head === "objekt" && tail) return { name: "product", id: decodeURIComponent(tail) };
  if (head === "order" && tail) return { name: "order", id: decodeURIComponent(tail) };
  if (head === "sok") return { name: "search", q: params.get("q") ?? "" };
  if (head === "profil") return { name: "profile" };
  // Okänd väg under /butik: hela lagret. En död länk till en borttagen kategori ska landa i
  // butiken, inte i ingenting.
  return { name: "search", q: "" };
}

export function butikHref(route: ButikRoute): string {
  switch (route.name) {
    case "category": return `${BUTIK_ROOT}/kategori/${encodeURIComponent(route.slug)}`;
    case "brand": return `${BUTIK_ROOT}/marke/${encodeURIComponent(route.slug)}`;
    case "product": return `${BUTIK_ROOT}/objekt/${encodeURIComponent(route.id)}`;
    case "order": return `${BUTIK_ROOT}/order/${encodeURIComponent(route.id)}`;
    case "search": return `${BUTIK_ROOT}/sok?q=${encodeURIComponent(route.q)}`;
    case "profile": return `${BUTIK_ROOT}/profil`;
  }
}

/** Bytet av sida. Pushar adressen och talar om för lyssnarna att den ändrats. */
export function navigate(to: ButikRoute | string, opts: { replace?: boolean } = {}): void {
  const href = typeof to === "string" ? to : butikHref(to);
  if (opts.replace) window.history.replaceState({}, "", href);
  else window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
  // Ny sida börjar överst. Utan det ligger en produktsida kvar på förra rutnätets rullposition.
  window.scrollTo(0, 0);
}

/** Frågesträngen ändrad utan att sidan byts — filter och sortering. Ersätter i stället för att pusha. */
export function replaceQuery(params: URLSearchParams): void {
  const qs = params.toString();
  const href = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Vyn för adressen, uppdaterad när den ändras.
 *
 * Lyssnar på popstate, som både bakåtknappen och `navigate` ovan utlöser. Ett enda ställe att läsa
 * adressen från gör att en länk, en knapp och webbläsarens historik hamnar i samma vy.
 */
export function useButikRoute(): { route: ButikRoute; search: URLSearchParams } {
  const read = () => ({
    route: parseButikPath(window.location.pathname, window.location.search),
    search: new URLSearchParams(window.location.search),
  });
  const [state, setState] = useState(read);
  useEffect(() => {
    const onPop = () => setState(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return state;
}
