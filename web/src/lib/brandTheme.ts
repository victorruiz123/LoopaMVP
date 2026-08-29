/**
 * Ett visuellt tema per märke.
 *
 * Inte logotyper — de kräver klarerad upphovsrätt och egna assets. I stället en färgton och en
 * typografisk hållning som gör listan skannbar: du känner igen IKEA-raden på avstånd utan att läsa
 * den, och heritage-märkena skiljer sig från lågprismärkena på formen snarare än på texten.
 *
 * Typsnitten är VARIANTER av systemstacken, inte inlästa webbfonter. En lista på 204 märken får inte
 * dra in 204 fonter — och systemstacken är redan det appen skriver i, så inget hoppar när den byts.
 */
export type BrandFont = "grotesk" | "serif" | "wide" | "compact";

export interface BrandTheme {
  bg: string;
  ink: string;
  accent: string;
  font: BrandFont;
}

/**
 * Handplockat för de märken en säljare oftast möter. Tonerna är valda för att skilja märkena åt i en
 * lista, inte för att härma någons grafiska profil.
 */
const CURATED: Record<string, BrandTheme> = {
  ikea: { bg: "#F2F5FB", ink: "#123A6B", accent: "#1F5FA8", font: "wide" },
  mio: { bg: "#FBF1F1", ink: "#8A2B2B", accent: "#B23A3A", font: "grotesk" },
  jysk: { bg: "#F1F5FA", ink: "#1B4B7A", accent: "#2C6CA8", font: "grotesk" },
  "em home": { bg: "#F7F3EE", ink: "#5A4632", accent: "#8A6B45", font: "grotesk" },
  skeidar: { bg: "#F3F4F6", ink: "#33383F", accent: "#565D66", font: "grotesk" },
  chilli: { bg: "#FDF0EC", ink: "#9A3418", accent: "#C2461F", font: "grotesk" },
  furniturebox: { bg: "#F2F4F3", ink: "#2E4340", accent: "#436662", font: "compact" },
  trademax: { bg: "#F4F2FA", ink: "#3B3172", accent: "#54479C", font: "compact" },
  "svenskt tenn": { bg: "#F2F6F1", ink: "#2C4A32", accent: "#3F6B47", font: "serif" },
  "string furniture": { bg: "#F6F6F4", ink: "#3A3A36", accent: "#5C5C55", font: "compact" },
  string: { bg: "#F6F6F4", ink: "#3A3A36", accent: "#5C5C55", font: "compact" },
  källemo: { bg: "#F4F2EE", ink: "#463B2C", accent: "#6B5A43", font: "serif" },
  dux: { bg: "#F1F3F5", ink: "#26333D", accent: "#3E525F", font: "wide" },
  "norell möbel": { bg: "#F5F4F1", ink: "#403C33", accent: "#635D4F", font: "compact" },
  hay: { bg: "#FBF6EC", ink: "#6B4A12", accent: "#9A6C1C", font: "wide" },
  bolia: { bg: "#F4F5F2", ink: "#3B4235", accent: "#57614D", font: "compact" },
  artek: { bg: "#F8F4EC", ink: "#5C4626", accent: "#87673A", font: "serif" },
  "fritz hansen": { bg: "#F3F3F4", ink: "#2F3033", accent: "#4A4C50", font: "serif" },
  muuto: { bg: "#F4F6F7", ink: "#33474F", accent: "#4C6873", font: "compact" },
  "&tradition": { bg: "#F5F2F0", ink: "#443733", accent: "#67534D", font: "serif" },
  "ferm living": { bg: "#F8F5F1", ink: "#54463A", accent: "#7C6752", font: "compact" },
  stressless: { bg: "#F1F3F6", ink: "#2B3A4D", accent: "#42576F", font: "grotesk" },
  vitra: { bg: "#FAF2F2", ink: "#7A2A2A", accent: "#A33B3B", font: "wide" },
  "herman miller": { bg: "#F5F3EF", ink: "#4A4136", accent: "#6E6151", font: "serif" },
  "west elm": { bg: "#F6F4F0", ink: "#4B4238", accent: "#6F6252", font: "compact" },
  swedese: { bg: "#F4F5F1", ink: "#3D4634", accent: "#5A664D", font: "serif" },
  sits: { bg: "#F5F4F2", ink: "#3F3B35", accent: "#615B51", font: "compact" },
  ekornes: { bg: "#F2F4F4", ink: "#2E4040", accent: "#456060", font: "grotesk" },
  hästens: { bg: "#F3F5F9", ink: "#22375E", accent: "#365488", font: "serif" },
  "carl malmsten": { bg: "#F6F3EC", ink: "#4E4029", accent: "#75603E", font: "serif" },
  "bruno mathsson": { bg: "#F5F4EF", ink: "#454031", accent: "#6A6249", font: "serif" },
};

/** Toner för allt utanför den handplockade listan. Stabila per märke, så samma namn ser likadant ut. */
const FALLBACK: BrandTheme[] = [
  { bg: "#F5F3EF", ink: "#4A4136", accent: "#6E6151", font: "compact" },
  { bg: "#F1F4F3", ink: "#33463F", accent: "#4C665C", font: "grotesk" },
  { bg: "#F4F2F6", ink: "#413853", accent: "#5D5177", font: "compact" },
  { bg: "#F6F3F1", ink: "#4E3B33", accent: "#73584C", font: "serif" },
  { bg: "#F1F3F7", ink: "#333F55", accent: "#4C5C7A", font: "grotesk" },
  { bg: "#F5F5F1", ink: "#42452F", accent: "#616647", font: "compact" },
];

function key(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

export function brandTheme(name: string): BrandTheme {
  const direct = CURATED[key(name)] ?? CURATED[name.toLowerCase().trim()];
  if (direct) return direct;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return FALLBACK[hash % FALLBACK.length];
}
