/**
 * Monogram i stället för logotyp. Riktiga märkeslogotyper kräver egna uppladdade assets med klarerad
 * upphovsrätt; ett logotyp-API i stället (Clearbit och liknande) är både avvecklat och en extern
 * beroendekedja mitt i ett formulär som måste fungera offline i en möbelaffär.
 */

/** Delar av namnet som kan bära en initial — "&Tradition" ska ge TR, inte &T. */
function initials(name: string): string {
  const words = name
    .split(/[\s/&-]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0];
  // Ett versalt kortnamn ÄR sitt monogram: "EM Home" blir EM, inte EH, och "IKEA" blir IK.
  if (first.length >= 2 && first === first.toUpperCase()) return first.slice(0, 2).toUpperCase();
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return first.slice(0, 2).toUpperCase();
}

/** Fem toner ur appens egen varma palett. Stabil per märke, så samma märke ser likadant ut varje gång. */
const TINTS = [
  { bg: "#F7E0CB", fg: "#8A430D" },
  { bg: "#E2E5D6", fg: "#3F4733" },
  { bg: "#F0DBE1", fg: "#7C3448" },
  { bg: "#D9E2EA", fg: "#33506A" },
  { bg: "#ECE3CD", fg: "#6B5726" },
];

function tintFor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return TINTS[hash % TINTS.length];
}

export default function BrandAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const tint = tintFor(name);
  return (
    <span
      className="brand-avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: tint.bg,
        color: tint.fg,
        fontSize: Math.round(size * 0.36),
      }}
    >
      {initials(name)}
    </span>
  );
}
