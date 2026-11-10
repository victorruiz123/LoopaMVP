/**
 * SerpApi-bryggen. Samma gränssnitt som appskalets brygga (appBridge.ts, `window.loopaApp`), men frågorna till Googles AI-läge och bildsök går via Loopas server och SerpApi i stället för
 * via Electrons dolda webbvyer. Hela flödet efter bryggan — korten, väljaren, måttfrågan efter valet, specsteget, skickbedömningen och priset — är därför det som körs i appskalet.
 *
 * NÄR DEN ÄR PÅ. Vid varje uppladdning frågar webben servern (`GET /api/serpapi/status`, se `syncSerpApiBridge`): är nyckeln satt, finns en publik adress för bilden och är dygnstaket inte nått
 * lägger webben in bryggen, annars tar den bort den och uppladdningen går den vanliga vägen (servern identifierar själv). Ett saknat konfigurationsvärde eller ett nått tak ger alltså
 * aldrig ett felmeddelande för säljaren. Finns ett riktigt appskal (Electron) rörs inget.
 *
 * Frågorna ställs av SERVERN (server/src/serpapi/), inte här: nyckeln till SerpApi ska aldrig ut till webbläsaren. Bryggen skickar bara vad skalet skulle fått (bilderna, märket, typen, modellen).
 *
 * GRANSKNINGSPANELEN ("AI-lägets samtal", frågorna som skickats och svaren, motsvarigheten till skalets "Visa Googles vy") är till för utvecklaren och ritas bara om den slagits på:
 * öppna sidan med ?serpapi=1 en gång (minns i webbläsaren), stäng av med ?serpapi=0. Säljare ser den aldrig.
 */

import { authFetch } from "../api";
import type { LoopaAppBridge } from "./appBridge";

interface Turn {
  label: string;
  question: string;
  answer: string;
  searchId: string | null;
  googleUrl: string | null;
  ms: number;
  continued: boolean;
  withImage: boolean;
  error: string | null;
}
interface Transcript {
  sid: string;
  imageUrl: string | null;
  aiCalls: number;
  imageCalls: number;
  turns: Turn[];
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await authFetch(path, {
    method: init?.method ?? "POST",
    ...(init?.body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body as T;
}

// --- Panelen med samtalet ----------------------------------------------------------------------------------------------------------------------------------------------------------

let root: HTMLElement | null = null;
let open = false;
let lastError: string | null = null;
let transcript: Transcript | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const PANEL_KEY = "loopa.serpapiPanel";

/** Är granskningspanelen påslagen? ?serpapi=1 slår på och minns, ?serpapi=0 stänger av. Aldrig något som kan fälla flödet: webbläsarens lagring kan saknas eller kasta. */
export function panelWanted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("serpapi");
    if (q === "1") window.localStorage.setItem(PANEL_KEY, "1");
    else if (q === "0") window.localStorage.removeItem(PANEL_KEY);
    return window.localStorage.getItem(PANEL_KEY) === "1";
  } catch {
    return false;
  }
}

function draw() {
  if (typeof document === "undefined") return;
  if (!panelWanted()) {
    root?.remove();
    root = null;
    return;
  }
  if (!root) {
    root = document.createElement("div");
    root.setAttribute("data-serpapi-panel", "");
    root.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:99998;font:13px/1.4 system-ui,sans-serif;max-width:min(560px,calc(100vw - 24px));";
    document.body.appendChild(root);
    root.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-toggle]")) {
        open = !open;
        draw();
      }
    });
  }
  const n = transcript?.turns.length ?? 0;
  const knapp = `<button data-toggle style="all:unset;cursor:pointer;display:block;background:${lastError ? "#b3261e" : "#1f2937"};color:#fff;padding:8px 12px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.25)">${
    lastError ? "SerpApi-fel — visa" : `AI-lägets samtal (SerpApi)${n ? ` · ${n} ${n === 1 ? "fråga" : "frågor"}` : ""}`
  }</button>`;
  let panel = "";
  if (open) {
    const turns = (transcript?.turns ?? [])
      .map(
        (t) => `<details style="margin:6px 0;border-top:1px solid #e5e7eb;padding-top:6px"><summary style="cursor:pointer"><b>${esc(t.label)}</b> · ${Math.round(t.ms / 1000)} s${t.withImage ? " · med bild" : t.continued ? " · fortsätter samtalet" : ""}${t.error ? ` · <span style="color:#b3261e">${esc(t.error)}</span>` : ""}</summary>
<div style="margin-top:4px;color:#6b7280">Fråga</div><pre style="white-space:pre-wrap;margin:2px 0 6px;font:12px/1.4 ui-monospace,monospace">${esc(t.question)}</pre>
<div style="color:#6b7280">Svar</div><pre style="white-space:pre-wrap;margin:2px 0;font:12px/1.4 ui-monospace,monospace">${esc(t.answer || "(inget svar)")}</pre>
${t.searchId ? `<div style="color:#6b7280;font-size:11px">SerpApi-sökning ${esc(t.searchId)}${t.googleUrl ? ` · <a href="${esc(t.googleUrl)}" target="_blank" rel="noreferrer">Googles adress</a>` : ""}</div>` : ""}</details>`,
      )
      .join("");
    panel = `<div style="background:#fff;color:#111;border:1px solid #d1d5db;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.25);padding:12px;margin-bottom:8px;max-height:70vh;overflow:auto">
<div style="font-weight:600;margin-bottom:4px">Googles AI-läge via SerpApi (granskning)</div>
<div style="color:#6b7280;font-size:12px">Det här är frågorna som skickats och svaren som kom tillbaka. ${transcript ? `${transcript.aiCalls} frågor till AI-läget och ${transcript.imageCalls} bildsökningar hittills.` : "Inget samtal har startat."}</div>
${lastError ? `<div style="margin:8px 0;padding:8px;background:#fdecea;color:#b3261e;border-radius:8px">${esc(lastError)}</div>` : ""}${turns}</div>`;
  }
  root.innerHTML = panel + knapp;
}

async function refresh(sid: string | null) {
  // Panelen av: inget extra anrop per fråga.
  if (!sid || !panelWanted()) return draw();
  try {
    transcript = await call<Transcript>(`/api/serpapi/session/${sid}`, { method: "GET" });
  } catch {
    /* panelen är bara en granskning; den får aldrig fälla flödet */
  }
  draw();
}

function remove() {
  root?.remove();
  root = null;
  open = false;
  lastError = null;
  transcript = null;
}

// --- Bryggen ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Vår egen brygga, så att vi vet vilken som är vår: ett riktigt appskal (Electron) ska aldrig tas bort eller bytas ut. */
let installed: LoopaAppBridge | null = null;

/**
 * Anropas innan varje uppladdning (StartingJob). Frågar servern om SerpApi-flödet ska användas just nu och lägger in eller tar bort bryggen därefter. Sker det innan jobbet skapas, för att
 * `inApp()` (api.ts, createJob) avgör om jobbet märks som externt. Fel, tidsgräns eller en server som säger nej betyder "använd den vanliga vägen": en uppladdning ska aldrig fastna här.
 */
export async function syncSerpApiBridge(): Promise<void> {
  if (typeof window === "undefined") return;
  // Ett riktigt appskal äger window.loopaApp.
  if (window.loopaApp && window.loopaApp !== installed) return;
  let enabled = false;
  // AbortController och inte AbortSignal.timeout: den senare saknas i äldre iPhones (Safari före 16), och där hade statusfrågan alltid fallit.
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await authFetch("/api/serpapi/status", { method: "GET", signal: ctrl.signal });
    if (res.ok) enabled = ((await res.json().catch(() => null)) as { enabled?: unknown } | null)?.enabled === true;
  } catch {
    /* ingen status = den vanliga vägen */
  } finally {
    window.clearTimeout(timer);
  }
  if (enabled) {
    if (!window.loopaApp) installSerpApiBridge();
  } else if (installed && window.loopaApp === installed) {
    installed = null;
    window.loopaApp = undefined;
    remove();
  }
}

function installSerpApiBridge(): void {
  if (typeof window === "undefined" || window.loopaApp) return;
  let sid: string | null = null;

  /** Kör ett anrop, visar felet i panelen om det faller och uppdaterar samtalet efteråt. */
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      const r = await fn();
      return r;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      void refresh(sid);
    }
  };
  const needSid = (): string => {
    if (!sid) throw new Error("bilderna är inte iläggda (prepare saknas)");
    return sid;
  };

  const bridge: LoopaAppBridge = {
    // Hela flödet: skickbedömning, pris och annons som vanligt. (Appskalets testläge `onlyIdentifySpecs`, som bara prövar identifieringen och måtten, är AV.) Bildkedjan A → C → B är på.
    flags: { onlyIdentifySpecs: false, allImages: false, referenceChain: true },
    prepare: ({ images }) =>
      run(async () => {
        // Ett nytt varv: förra samtalets bild och token glöms.
        if (sid) void call("/api/serpapi/end", { body: { sid } }).catch(() => undefined);
        lastError = null;
        transcript = null;
        const r = await call<{ sid: string }>("/api/serpapi/prepare", { body: { images } });
        sid = r.sid;
        return { ok: true as const };
      }),
    identify: ({ brand, furnitureType }) => run(() => call<{ answer: string; links: string[] }>("/api/serpapi/identify", { body: { sid: needSid(), brand, furnitureType } })),
    askSpecs: ({ brand, model, furnitureType }) => run(() => call<{ answer: string; links: string[] }>("/api/serpapi/specs", { body: { sid: needSid(), brand, model, furnitureType } })),
    findImages: ({ brand, queries }) => run(() => call("/api/serpapi/images", { body: { sid: needSid(), brand, queries } })),
    endFlow: () => {
      const old = sid;
      sid = null;
      if (old) void call("/api/serpapi/end", { body: { sid: old } }).catch(() => undefined);
      // Samtalet glöms; med granskningspanelen påslagen blir knappen kvar och visar att SerpApi-flödet körs.
      remove();
      draw();
    },
  };
  installed = bridge;
  window.loopaApp = bridge;
  draw();
}
