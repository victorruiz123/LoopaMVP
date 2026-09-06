/**
 * Ett visuellt tema per märke, HÄRLETT UR brandLook.
 *
 * Filen bar tidigare en EGEN handplockad tabell, parallell med den i brandLook.ts. Två tabeller över
 * samma sak håller inte ihop: Vitra var svart i butiken och rött i säljflödet, HAY svart på papper i
 * det ena och gyllenbrunt i det andra, Artek geometriskt svart mot brun antikva. Samma möbel, samma
 * märke, två svar beroende på vilken skärm man råkade stå på — och då är det inte igenkänning längre.
 *
 * Nu finns märkets identitet på ETT ställe (lib/brandLook.ts) och den här filen översätter den till
 * det säljstartsidans brickor behöver: en ljus botten, en läsbar text och en accent. Lägger någon
 * till ett märke där syns det här, och tvärtom går inte längre att göra fel.
 *
 * INGA LOGOTYPER, samma regel som förut: publikt kända färgpar och typografisk karaktär, aldrig
 * någons grafiska profil.
 *
 * Typsnitten är VARIANTER av systemstacken, inte inlästa webbfonter. En lista på 204 märken får inte
 * dra in 204 fonter — och systemstacken är redan det appen skriver i, så inget hoppar när den byts.
 */

import { brandInk, brandLook, type BrandType } from "./brandLook";

export type BrandFont = "grotesk" | "serif" | "wide" | "compact";

export interface BrandTheme {
  bg: string;
  ink: string;
  accent: string;
  font: BrandFont;
}

/**
 * Märkets tonfall som en av brickans fyra storleksklasser.
 *
 * Klassen sätter STORLEKEN på namnet; familjen, vikten och spärren kommer från `brandTypeStyle` i
 * brandLook — samma regler som brickorna i butiken och på köpsidan använder.
 */
const FONT_AV_TYP: Record<BrandType, BrandFont> = {
  heavy: "grotesk",
  wide: "wide",
  geometric: "compact",
  serif: "serif",
  plain: "compact",
};

/**
 * Märkets egen färg utspädd mot papper.
 *
 * Brickan är stor och står bland trettio andra; full styrka på den ytan hade gjort listan till en
 * färgkarta. Tonen är därför märkets färg, inte en granne till den — bara ljusare.
 */
function tona(hex: string, styrka: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#f5f3ef";
  const n = parseInt(m[1], 16);
  const mot = (kanal: number) => Math.round(255 - (255 - kanal) * styrka);
  const r = mot((n >> 16) & 255);
  const g = mot((n >> 8) & 255);
  const b = mot(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export function brandTheme(name: string): BrandTheme {
  /**
   * `brandInk` och inte `look.bg`: brickan är ljus, och paret i brandLook är gjort för en färgad
   * platta. IKEAs par är gult på blått — på en ljus bricka är blått färgen som bär, inte gult.
   */
  const ink = brandInk(name);
  return {
    bg: tona(ink, 0.1),
    ink,
    accent: ink,
    font: FONT_AV_TYP[brandLook(name).type],
  };
}
