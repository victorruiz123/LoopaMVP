import { brandInitials, brandLook, brandTypeStyle } from "../lib/brandLook";

/**
 * Märkesbricka: monogram i märkets egen färg och bokstavsform. Se `brandLook.ts` för varför det är
 * ett monogram och inte en logotyp, och varför bara vissa märken har en husfärg.
 *
 * Rundad kvadrat, inte cirkel: ett varumärke sätter sitt namn i en ruta (appikonen, butiksskylten,
 * etiketten). Cirkeln läser som en profilbild — som en PERSON — vilket är fel sak att likna.
 */
export default function BrandAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const look = brandLook(name);
  const type = brandTypeStyle(look.type);
  return (
    <span
      className="brand-avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.27),
        background: look.bg,
        color: look.fg,
        // Den vida spärren skjuter texten åt höger; halva spärren tillbaka centrerar den igen.
        textIndent: look.type === "wide" ? "0.16em" : undefined,
        fontSize: Math.round(size * (look.type === "wide" ? 0.3 : 0.36)),
        boxShadow: look.ring ? "inset 0 0 0 1px hsl(34 18% 7% / 0.12)" : "none",
        ...type,
      }}
    >
      {brandInitials(name)}
    </span>
  );
}
