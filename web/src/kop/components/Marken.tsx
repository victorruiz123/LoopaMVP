import { useEffect, useMemo, useRef, useState } from "react";
import { fetchBrands } from "../../butik/api";
import { butikHref } from "../../butik/router";
import { track } from "../../butik/components/Bits";
import { brandLook, brandTypeStyle } from "../../lib/brandLook";
import { useAuth } from "../../auth/AuthProvider";
import { fragaOmInloggning } from "./LoggaInGrind";
import type { BrandFacet } from "../../butik/types";

/**
 * Bläddra på märke, med en sökrad över.
 *
 * MÄRKET ÄR HUR FOLK FAKTISKT LETAR begagnade möbler. "Finns det någon Lamino?" är frågan; "visa mig
 * era nyinkomna" är det inte. Den förra raden med åtta produktkort svarade på fel fråga — den visade
 * vad vi råkade ha, inte vad någon sökte.
 *
 * BÅDA KÄLLORNA BAKOM VARJE BRICKA. Ett klick ger märkets hela utbud: våra granskade möbler och
 * Traderas annonser i samma rutnät, som märkessidan redan gör. Men ANTALEN ÄR DELADE på brickan —
 * "12 granskade · 30 via Tradera" och inte "42" — eftersom de två sakerna är olika mycket värda. En
 * granskad möbel går att köpa i dag med hemleverans; en Tradera-annons är någon annans. Ett
 * sammanslaget tal hade lånat vår granskning till annonser vi inte granskat.
 *
 * SÖKRADEN FILTRERAR BRICKORNA medan man skriver, och tar en till rutnätet när ordet inte är ett
 * märke. Den som skriver "Lamino" menar en modell, inte ett märke, och ska inte mötas av tomhet.
 */
export default function Marken() {
  const { user } = useAuth();
  const [marken, setMarken] = useState<BrandFacet[] | null>(null);
  const [fraga, setFraga] = useState("");
  const faltet = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchBrands().then((r) => setMarken(r.brands)).catch(() => setMarken([]));
  }, []);

  const traffar = useMemo(() => {
    const q = fraga.trim().toLowerCase();
    if (!q) return marken ?? [];
    return (marken ?? []).filter((b) => b.brand.toLowerCase().includes(q));
  }, [marken, fraga]);

  const ga = (href: string, anledning: string) => {
    const hopp = () => { window.location.href = href; };
    if (fragaOmInloggning(!!user, anledning, hopp)) hopp();
  };

  // Inga märken i lagret: sektionen har ingenting att erbjuda och ska inte ta plats.
  if (marken !== null && marken.length === 0) return null;

  return (
    <section className="marken">
      <div className="marken-huvud">
        <h2>Leta bland märken</h2>
        <p>Klicka på ett märke så ser du allt vi har och allt som finns via Tradera — i samma lista.</p>
      </div>

      <form
        className="marken-sok"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const q = fraga.trim();
          if (!q) return;
          // Ett märke går till märkessidan; allt annat till rutnätet — "Lamino" är en modell.
          const exakt = (marken ?? []).find((b) => b.brand.toLowerCase() === q.toLowerCase());
          if (exakt) {
            track("marke_sok", { traff: "marke", marke: exakt.brand });
            ga(butikHref({ name: "brand", slug: exakt.slug ?? slugAv(exakt.brand) }), "marke");
          } else {
            track("marke_sok", { traff: "fritext" });
            ga(butikHref({ name: "search", q }), "bladdra");
          }
        }}
      >
        <input
          ref={faltet}
          type="search"
          value={fraga}
          onChange={(e) => setFraga(e.target.value)}
          placeholder="Sök märke — IKEA, String, Swedese…"
          aria-label="Sök bland märken"
        />
        <button type="submit" aria-label="Sök">Sök</button>
      </form>

      {marken === null ? (
        <div className="marken-skimmer" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => <span key={i} />)}
        </div>
      ) : traffar.length === 0 ? (
        <p className="marken-tomt">
          Inget märke heter så hos oss. Tryck på sök så letar vi i hela lagret i stället.
        </p>
      ) : (
        <ul className="marken-rutnat">
          {traffar.map((b) => {
            const look = brandLook(b.brand);
            const slug = b.slug ?? slugAv(b.brand);
            return (
              <li key={b.brand}>
                <a
                  className="marken-bricka"
                  href={butikHref({ name: "brand", slug })}
                  onClick={(e) => {
                    e.preventDefault();
                    track("marke_click", { marke: b.brand, loopa: b.loopa ?? 0, tradera: b.tradera ?? 0 });
                    ga(butikHref({ name: "brand", slug }), "marke");
                  }}
                >
                  <span
                    className="marken-platta"
                    style={{
                      background: look.bg,
                      color: look.fg,
                      boxShadow: look.ring ? "inset 0 0 0 1px hsl(34 18% 7% / 0.14)" : "none",
                    }}
                  >
                    <span style={brandTypeStyle(look.type)}>{b.brand}</span>
                  </span>
                  {/* Delade tal. Noll skrivs inte ut — en nolla är inte ett erbjudande. */}
                  <span className="marken-antal">
                    {b.loopa ? <b>{b.loopa} granskade</b> : null}
                    {b.loopa && b.tradera ? " · " : null}
                    {b.tradera ? <span>{b.tradera} via Tradera</span> : null}
                    {!b.loopa && !b.tradera ? `${b.count} st` : null}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Adressens form av namnet, när servern inte skickat med den. */
function slugAv(brand: string): string {
  return brand.toLowerCase().replace(/\s+/g, "-");
}
