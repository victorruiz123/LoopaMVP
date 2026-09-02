import { brandLook, brandTypeStyle } from "../../lib/brandLook";
import type { BrandFacet } from "../types";
import { Link } from "./Bits";

/**
 * Märkesbrickorna — butikens andra ingång.
 *
 * Varje bricka bär MÄRKETS egen färg och bokstavsform, inte Loopas: IKEA är blå med gult och tung
 * versal, HAY är svart på papper med vid spärr, Svenskt Tenn är grön antikva. Tabellen finns redan i
 * web/src/lib/brandLook.ts, byggd för märkesväljaren i säljflödet, och den gäller här av samma skäl
 * som där — man känner igen IKEA på rutan innan man läst ordet.
 *
 * INGA LOGOTYPER. brandLook återger publikt kända färgpar och typografisk karaktär, aldrig någons
 * grafiska profil; det kräver klarerad upphovsrätt och egna assets. Ett märke utan känd husfärg får
 * en varm neutral ur Loopas palett hellre än en gissad — en gissad husfärg ser lika säker ut som en
 * riktig, och det är det som gör den fel.
 *
 * Bara märken med varor i lager visas. En bricka som leder till en tom sida är ett löfte som bryts i
 * samma klick — se /api/butik/marken, som räknar båda källorna.
 */
export default function BrandTiles({ brands }: { brands: BrandFacet[] }) {
  if (brands.length === 0) return null;
  return (
    <nav className="butik-brands" aria-label="Märken">
      {brands.map((b) => {
        const look = brandLook(b.brand);
        const type = brandTypeStyle(look.type);
        return (
          <Link
            key={b.brand}
            to={{ name: "brand", slug: b.slug ?? b.brand.toLowerCase().replace(/\s+/g, "-") }}
            className="butik-brand-tile"
          >
            <span
              className="butik-brand-plate"
              style={{
                background: look.bg,
                color: look.fg,
                boxShadow: look.ring ? "inset 0 0 0 1px hsl(34 18% 7% / 0.14)" : "none",
              }}
            >
              <span
                className="butik-brand-name"
                style={{
                  ...type,
                  // Den vida spärren skjuter texten åt höger; halva spärren tillbaka centrerar den.
                  textIndent: look.type === "wide" ? "0.16em" : undefined,
                }}
              >
                {b.brand}
              </span>
              <span className="butik-brand-sub" style={{ color: look.fg, opacity: 0.72 }}>
                secondhand
              </span>
            </span>
            <span className="butik-brand-count">
              {b.count} {b.count === 1 ? "möbel" : "möbler"}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
