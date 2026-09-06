import type { ReactNode } from "react";
import { butikHref, navigate } from "../router";

/**
 * De små delarna butiken upprepar: förtroenderaden, säljuppmaningen, tomma lägen och notiser.
 *
 * Samlade i en fil för att var och en är fem rader och bor på fyra skärmar. Fyra filer med fem rader
 * hade betytt fyra ställen att glömma när formuleringen ändras — och formuleringarna här ÄR
 * produkten: "Loopa-granskad" och "ej granskad" är löften, inte etiketter.
 */

export function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg className="butik-search-icon" width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <circle cx="7.2" cy="7.2" r="5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M11 11l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Loopa-granskad / Hemleverans. Bara för våra egna varor — se ProductCard.
 *
 * Öppet köp stod här som ett tredje löfte och är borttaget: det utlovades i gränssnittet innan det
 * fanns en returhantering bakom, och ett löfte utan uppbackning är sämre än ett löfte färre.
 */
export function TrustRow() {
  return (
    <div className="butik-trust">
      <span className="butik-trust-item"><CheckIcon /> Loopa-granskad</span>
      <span className="butik-trust-item"><CheckIcon /> Hemleverans i Stockholm</span>
    </div>
  );
}

/**
 * Vägen tillbaka in i säljverktyget — köp↔sälj-slingan.
 *
 * Står på varje sida och i varje tomt läge med flit: den som letar efter en soffa har ofta en soffa
 * att bli av med, och det ögonblicket är här. Kategori och märke skickas med så att flödet öppnar
 * på rätt möbel i stället för på en tom ruta.
 */
export function SellCta({
  categorySlug,
  brand,
  heading = "Har du en liknande möbel?",
  body = "Filma ett varv med mobilen. Vi besiktigar, prissätter och lägger ut den — du behöver inte skriva en annons.",
}: {
  categorySlug?: string | null;
  brand?: string | null;
  heading?: string;
  body?: string;
}) {
  const params = new URLSearchParams();
  if (brand) params.set("marke", brand);
  if (categorySlug) params.set("kategori", categorySlug);
  const href = params.toString() ? `/?${params.toString()}` : "/";
  return (
    <section className="butik-sell">
      <div>
        <h3>{heading}</h3>
        <p>{body}</p>
      </div>
      <a className="butik-sell-btn" href={href} onClick={trackSellClick}>
        Sälj den med Loopa →
      </a>
    </section>
  );
}

function trackSellClick() {
  track("sell_cta_click", { from: window.location.pathname });
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="butik-notice" role="status">
      <span aria-hidden="true">⚠</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * Tomt läge.
 *
 * Aldrig bara "inga träffar". Ett tomt rutnät är butikens sämsta ögonblick och ska därför bära de
 * två vägar vidare som faktiskt finns: lägg en bevakning så vi hör av oss när något dyker upp, eller
 * sälj möbeln du redan har. Se bevakningarna i steg 6.
 */
export function EmptyState({
  title = "Inget här just nu",
  body,
  categorySlug,
  onBevakning,
}: {
  title?: string;
  body: string;
  categorySlug?: string | null;
  onBevakning?: () => void;
}) {
  return (
    <div className="butik-empty">
      <h3>{title}</h3>
      <p>{body}</p>
      <div className="butik-empty-actions">
        {onBevakning && (
          <button type="button" className="btn btn-outline btn-small" onClick={onBevakning}>
            Lägg en bevakning
          </button>
        )}
        <a className="btn btn-text" href={categorySlug ? `/?kategori=${encodeURIComponent(categorySlug)}` : "/"} onClick={trackSellClick}>
          Sälj en liknande möbel →
        </a>
      </div>
    </div>
  );
}

export function GridSkeleton({ n = 8 }: { n?: number }) {
  return (
    <div className="butik-grid" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="butik-skeleton butik-skeleton-card" />
      ))}
    </div>
  );
}

/** Intern länk som byter sida utan omladdning men fortfarande ÄR en <a> för sökmotorn och mitten-klick. */
export function Link({ to, children, className }: { to: Parameters<typeof butikHref>[0]; children: ReactNode; className?: string }) {
  const href = butikHref(to);
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        // Ctrl/cmd-klick och mittenklick ska öppna en ny flik som vilken länk som helst.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Analysen.
 *
 * TVÅ MOTTAGARE, en rad kod. `dataLayer` ligger kvar — det är den form varje tagghanterare läser, och
 * kopplas ett GA på i morgon fungerar de tjugofem anropsställena utan att röras. Dessutom går
 * händelsen till vår EGEN server, och det är det som gör den mätbar för oss: dataLayer når bara den
 * flik den skrevs i, och en händelse som ingen samlar upp är en händelse som inte finns. Panelen
 * (server/src/adminAnnonser.ts) läser den serverhalvan.
 *
 * `sendBeacon` och inte `fetch`: den överlever att sidan stängs i samma ögonblick, vilket är precis
 * vad ett utgående klick gör. Faller den — Safaris privata läge, en blockerare — händer ingenting.
 * Mätningen får aldrig märkas av den som mäts.
 *
 * Servern tar bara emot vitlistade namn och egenskaper (server/src/analys/store.ts). Ingen identitet
 * skickas, ingen kaka sätts, och därför krävs inget samtycke för det här anropet.
 */
export function track(event: string, props: Record<string, unknown> = {}): void {
  const payload = { event, ...props };
  const w = window as unknown as { dataLayer?: unknown[] };
  (w.dataLayer ??= []).push(payload);
  if (import.meta.env.DEV) console.debug("[analytics]", payload);
  try {
    const kropp = JSON.stringify({ event, props });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/analys", new Blob([kropp], { type: "application/json" }));
    } else {
      void fetch("/api/analys", { method: "POST", body: kropp, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(() => {});
    }
  } catch {
    // Se ovan.
  }
}
