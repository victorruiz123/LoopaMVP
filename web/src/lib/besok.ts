/**
 * Besöksmätningen i webbläsaren: varifrån besökaren kom, och vilka sidor hen gick mellan.
 *
 * VARFÖR DEN INTE ÄR FLÖDET. web/src/lib/flode.ts mäter säljflödets steg; den ser inte butiken, köp-
 * sidan eller det publika kortet, och den vet inte varifrån någon kom. Här mäts besöket som helhet.
 * Sessionen är däremot DENSAMMA — flödets `sess` — så att servern kan säga hur många av besöken från
 * en viss källa som blev ett intygat kort. Se server/src/data/besok.ts för andra halvan.
 *
 * KÄLLAN FÅNGAS FÖRE ALLT ANNAT. `fangaKalla` anropas i main.tsx innan inbjudnings- och
 * affiliatekoden städas bort ur adressfältet; efter det finns inget kvar att läsa.
 *
 * INGET NYTT LAGRAS I WEBBLÄSAREN. Sessionen är flödets, i sessionStorage. Allt annat skickas och
 * glöms. Värdnamnet besökaren kom från skickas, aldrig hela adressen — en sökadress kan bära sökorden.
 */

import { sessionId } from "./flode";

let konto: string | null = null;
let senaste: string | null = null;

function skicka(event: string, props: Record<string, unknown>): void {
  try {
    const kropp = JSON.stringify({ sess: sessionId(), uid: konto, event, props });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/data/besok", new Blob([kropp], { type: "application/json" }));
    } else {
      void fetch("/api/data/besok", {
        method: "POST",
        body: kropp,
        headers: { "Content-Type": "application/json" },
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // En mätning får aldrig fälla det den mäter.
  }
}

/**
 * Besökets källa. Anropas en gång, före render och före inbjudningsfångsten.
 *
 * En referrer från vår egen värd är ingen källa — det är en ny flik från en länk inne i appen — och
 * skickas därför inte. Servern läser bara den första landningen per session, så en omladdning
 * förstör ingenting.
 */
export function fangaKalla(): void {
  try {
    const url = new URL(window.location.href);
    let host: string | null = null;
    if (document.referrer) {
      const r = new URL(document.referrer);
      if (r.host !== url.host) host = r.hostname;
    }
    const p = url.searchParams;
    // Kampanjlänken: /k/KOD till säljsidan, ?k=KOD dit servern omdirigerat. Koden slås upp på
    // servern (server/src/data/kampanjer.ts); här skickas den bara med, och /k/KOD byts mot roten
    // innan appen hinner rita en sida som inte finns.
    const kampanjVag = /^\/k\/([a-z0-9]{5})\/?$/.exec(url.pathname);
    const kampanjkod = kampanjVag?.[1] ?? (p.get("k") && /^[a-z0-9]{5}$/.test(p.get("k")!) ? p.get("k")! : undefined);
    // Adressen städas så fort koden är fångad: en besökare som kopierar adressfältet och delar det
    // vidare ska inte räkna sina vänner till vår kampanj.
    if (kampanjVag) {
      window.history.replaceState(window.history.state, "", "/");
    } else if (p.has("k")) {
      const ren = new URL(url);
      ren.searchParams.delete("k");
      window.history.replaceState(window.history.state, "", ren.pathname + ren.search + ren.hash);
    }
    const props: Record<string, unknown> = {
      kampanjkod,
      sida: kampanjVag ? "/" : url.pathname,
      host: host ?? undefined,
      utm_source: p.get("utm_source") ?? undefined,
      utm_medium: p.get("utm_medium") ?? undefined,
      utm_campaign: p.get("utm_campaign") ?? undefined,
      inbjudan: /^\/i\/[^/]+/.test(url.pathname) || p.has("ref"),
      affiliate: /^\/p\/[^/]+/.test(url.pathname) || p.has("aff"),
      enhet: matchMedia("(pointer: fine) and (min-width: 900px)").matches ? "dator" : "mobil",
    };
    skicka("landning", props);
  } catch {
    // Ingen adress att läsa. Besöket mäts ändå sida för sida.
  }
}

/**
 * En sida visades.
 *
 * `vy` är App.tsx skärmnamn och följer bara med på roten, där säljflödet, profilen och startsidan
 * delar adress. Samma sida två gånger i rad skickas inte — en omrendering är inget sidbyte.
 */
export function sidaVisad(pathname: string, vy: string | null): void {
  const nyckel = `${pathname}|${vy ?? ""}`;
  if (nyckel === senaste) return;
  const fran = senaste?.split("|")[0] ?? undefined;
  // Den förra sidans scroll skickas FÖRE den nya sidan: servern knyter den till visningen innan.
  skickaScroll();
  senaste = nyckel;
  skicka("sida", { sida: pathname, vy: vy ?? undefined, fran });
  startaBeteende();
  sedda.clear();
  djup = 0;
  // En sektion som står kvar i bild över sidbytet ska räknas igen på den nya sidan. Observatören
  // rapporterar bara ändringar, så den börjar om — en ny `observe` rapporterar läget direkt.
  observator?.disconnect();
  observerade = new WeakSet();
  // Sidbytet ritar om i samma tick; sektionerna som redan står i bild räknas först efter det.
  setTimeout(skannaSektioner, 0);
}

/**
 * En butikshändelse, speglad från `track()` med sessionen på. Servern tar bara emot namnen
 * analysmätningen redan känner till. Se server/src/data/besok.ts.
 */
export function handling(namn: string, objekt: unknown): void {
  skicka("handling", { ...sidProps(), namn, objekt: typeof objekt === "string" ? objekt : undefined });
}

// ---------------------------------------------------------------------------
// Beteendet på sidan: hur långt ned, vad som syntes, vad som trycktes
// ---------------------------------------------------------------------------
//
// SEKTIONERNA ÄR NAMNGIVNA I KODEN med `data-matt="…"`, och bara de mäts. Ett tryck på en koordinat
// säger ingenting; "tryckte i märkesrutnätet" gör det. Namnen måste stå i SEKTIONER i
// server/src/data/besok.ts för att räknas.
//
// EN RAD PER SIDVISNING OCH SEKTION, inte en per scrollhändelse: "sågs" skickas första gången
// sektionen kommer i bild, scrolldjupet en gång när sidan lämnas, avrundat till en fjärdedel.

let startad = false;
let djup = 0;
let observator: IntersectionObserver | null = null;
let skanningVantar = false;
const sedda = new Set<string>();
let observerade = new WeakSet<Element>();

function sidProps(): Record<string, unknown> {
  const [sida, vy] = (senaste ?? "|").split("|");
  return { sida, vy: vy || undefined };
}

function skickaScroll(): void {
  if (!senaste || djup <= 0) return;
  const fjardedel = djup >= 0.97 ? 100 : djup >= 0.75 ? 75 : djup >= 0.5 ? 50 : djup >= 0.25 ? 25 : 0;
  djup = 0;
  if (fjardedel) skicka("scroll", { ...sidProps(), djup: fjardedel });
}

function matDjup(): void {
  const hojd = document.documentElement.scrollHeight;
  if (hojd <= 0) return;
  djup = Math.max(djup, Math.min(1, (window.scrollY + window.innerHeight) / hojd));
}

function skannaSektioner(): void {
  if (!observator) return;
  matDjup();
  document.querySelectorAll("[data-matt]").forEach((el) => {
    if (observerade.has(el)) return;
    observerade.add(el);
    observator!.observe(el);
  });
}

/** Lyssnarna sätts en gång, vid första sidvisningen. Allt är passivt och tyst. */
function startaBeteende(): void {
  if (startad || typeof window === "undefined") return;
  startad = true;
  try {
    window.addEventListener("scroll", matDjup, { passive: true });
    // Fliken som stängs eller göms är sista chansen att skicka den sista sidans scroll.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") skickaScroll();
    });
    window.addEventListener("pagehide", skickaScroll);
    document.addEventListener(
      "click",
      (e) => {
        const el = (e.target as Element | null)?.closest?.("[data-matt]");
        const namn = el?.getAttribute("data-matt");
        if (namn) skicka("klick", { ...sidProps(), namn });
      },
      { capture: true, passive: true },
    );
    if ("IntersectionObserver" in window) {
      observator = new IntersectionObserver(
        (poster) => {
          for (const p of poster) {
            // En sektion "syns" när en fjärdedel av den står i bild — eller halva skärmen, för den
            // som är högre än skärmen och aldrig kan stå till en fjärdedel i bild.
            const synlig = p.intersectionRatio >= 0.25 || p.intersectionRect.height >= window.innerHeight * 0.5;
            const namn = p.target.getAttribute("data-matt");
            if (!synlig || !namn || sedda.has(namn)) continue;
            sedda.add(namn);
            skicka("sektion", { ...sidProps(), namn });
          }
        },
        { threshold: [0, 0.25, 0.5] },
      );
      // Sidorna ritas efter hand — produkterna laddas, skickrapporten kommer sist. Nya sektioner
      // fångas när de dyker upp.
      // Högst en skanning per bildruta: kameran och animationerna ändrar sidan tätt.
      new MutationObserver(() => {
        if (skanningVantar) return;
        skanningVantar = true;
        requestAnimationFrame(() => {
          skanningVantar = false;
          skannaSektioner();
        });
      }).observe(document.body, { childList: true, subtree: true });
    }
  } catch {
    // En mätning får aldrig fälla det den mäter.
  }
}

/** Kontot, så fort inloggningen finns. Servern knyter sidorna före inloggningen till det på sessionen. */
export function knytKonto(uid: string | null): void {
  if (!uid || konto === uid) return;
  konto = uid;
  skicka("konto", {});
}
