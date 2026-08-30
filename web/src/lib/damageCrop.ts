import type { EvidenceMark } from "../types";

/**
 * Var bilden ska ligga för att BARA skadan ska synas i en liten ruta.
 *
 * Uträkningen står här och inte i komponenten för att den är ren geometri, och för att den är lätt
 * att få subtilt fel: ett utsnitt som ser rimligt ut på ett liggande foto kan vara halvtomt på ett
 * stående, och ett fynd i bildens hörn kan hamna utanför sin egen ruta. Se damageCrop.test.ts.
 */

/**
 * Marginalen runt fyndet.
 *
 * Samma formel som serverns utsnitt (`cropEvidence` i imageUtils.ts), så en skada ser likadant
 * inramad ut var man än möter den i appen. Andelen ger luft åt stora fynd, det fasta tillägget åt
 * små — utan det senare hade en tre pixlar bred spricka förstorats till oigenkännlighet.
 */
const PAD_FRAC = 0.15;
const PAD_ABS = 0.03;
/**
 * Minsta andel av bilden ett utsnitt får spänna över.
 *
 * En streckmarkering kan vara lodrät eller vågrät, och då är dess ena sida NOLL bred. Utan golvet
 * blev förstoringen oändlig — bokstavligen, en division med noll — och rutan svart.
 */
const MIN_SPAN = 0.08;

/** Vidga ett intervall till minst `min`, kring sin egen mitt. */
function widen(a0: number, a1: number, min: number): [number, number] {
  if (a1 - a0 >= min) return [a0, a1];
  const mid = (a0 + a1) / 2;
  return [mid - min / 2, mid + min / 2];
}

/**
 * Skjut in intervallet i bilden i stället för att klippa det.
 *
 * Servern klipper mot kanten, för den plockar verkliga pixlar och kan inte hämta det som inte finns.
 * Här är det bara en fråga om var bilden ligger bakom rutan, och ett fynd i hörnet ska inte ritas
 * mer förstorat än ett mitt i bilden bara för att dess marginal stack utanför.
 */
function fit(a0: number, a1: number): [number, number] {
  const span = Math.min(a1 - a0, 1);
  const lo = Math.max(0, Math.min(a0, 1 - span));
  return [lo, lo + span];
}

/**
 * Gör utsnittet kvadratiskt i PIXLAR — inte i andelar.
 *
 * Rutan i listan är kvadratisk, och ett utsnitt med annan form måste antingen få tomma kanter eller
 * klippas. Klippningen tog just den del av skadan som låg mot bildens kant: ett fynd i hörnet fick
 * fyra tiondelar av sig självt bortskuret, för utsnittet kring det var bredare än högt och det var
 * bredden som offrades. Genom att i stället vidga den korta sidan innan bilden placeras fylls rutan
 * av ett utsnitt som redan har rätt form, och ingenting behöver klippas.
 *
 * Andelar duger inte till det: 0,138 av bredden är 177 pixlar på ett liggande foto och 0,138 av
 * höjden är 132. Det är bildens verkliga mått som avgör vad som är kvadratiskt.
 */
function squarify(
  rect: { x0: number; y0: number; x1: number; y1: number },
  image: { width: number; height: number },
): { x0: number; y0: number; x1: number; y1: number } {
  const wide = (rect.x1 - rect.x0) * image.width;
  const tall = (rect.y1 - rect.y0) * image.height;
  if (Math.abs(wide - tall) < 0.5) return rect;
  if (wide > tall) {
    const span = Math.min(wide / image.height, 1);
    const mid = (rect.y0 + rect.y1) / 2;
    const [y0, y1] = fit(mid - span / 2, mid + span / 2);
    return { ...rect, y0, y1 };
  }
  const span = Math.min(tall / image.width, 1);
  const mid = (rect.x0 + rect.x1) / 2;
  const [x0, x1] = fit(mid - span / 2, mid + span / 2);
  return { ...rect, x0, x1 };
}

/** Fyndets ruta med marginal, i bildens egna 0–1-koordinater. */
export function cropRect(mark: EvidenceMark): { x0: number; y0: number; x1: number; y1: number } {
  const x0 = mark.kind === "box" ? mark.x : Math.min(mark.x, mark.x2 ?? mark.x);
  const y0 = mark.kind === "box" ? mark.y : Math.min(mark.y, mark.y2 ?? mark.y);
  const x1 = mark.kind === "box" ? mark.x + (mark.w ?? 0.1) : Math.max(mark.x, mark.x2 ?? mark.x);
  const y1 = mark.kind === "box" ? mark.y + (mark.h ?? 0.1) : Math.max(mark.y, mark.y2 ?? mark.y);
  const padX = (x1 - x0) * PAD_FRAC + PAD_ABS;
  const padY = (y1 - y0) * PAD_FRAC + PAD_ABS;
  const [wx0, wx1] = widen(x0 - padX, x1 + padX, MIN_SPAN);
  const [wy0, wy1] = widen(y0 - padY, y1 + padY, MIN_SPAN);
  const [fx0, fx1] = fit(wx0, wx1);
  const [fy0, fy1] = fit(wy0, wy1);
  return { x0: fx0, y0: fy0, x1: fx1, y1: fy1 };
}

/** Bildens mått och läge, i procent av den kvadratiska rutan den ska fylla. */
export interface CropPlacement {
  widthPct: number;
  heightPct: number;
  leftPct: number;
  topPct: number;
}

/**
 * Bilden förstoras tills utsnittet TÄCKER rutan, och skjuts sedan så att utsnittet hamnar mitt i den.
 *
 * Allt uttrycks i procent av rutan, så samma tal håller oavsett hur stor den ritas. Höjden räknas ur
 * bredden och BILDENS egen proportion, aldrig ur rutans — annars sträcks fotot, och en repa blir en
 * annan repa.
 */
export function cropPlacement(mark: EvidenceMark, image: { width: number; height: number }): CropPlacement {
  const { x0, y0, x1, y1 } = squarify(cropRect(mark), image);
  const spanX = x1 - x0;
  const spanY = y1 - y0;
  const ratio = image.width / image.height;
  const widthPct = Math.max(1 / spanX, ratio / spanY) * 100;
  const heightPct = widthPct / ratio;
  return {
    widthPct,
    heightPct,
    leftPct: (100 - spanX * widthPct) / 2 - x0 * widthPct,
    topPct: (100 - spanY * heightPct) / 2 - y0 * heightPct,
  };
}
