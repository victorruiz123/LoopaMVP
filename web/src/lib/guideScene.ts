/**
 * Scenen båda kameraguiderna ritar: möbeln, golvet, banan runt den, och telefonen på banan.
 *
 * Den låg först inbakad i WalkaroundGuide, som var den enda guiden som fanns. När fotoguiden kom till
 * behövde den samma möbel i samma perspektiv med samma bana — skillnaden mellan de två är inte scenen
 * utan var telefonen står: filmguiden går runt hela varvet, fotoguiden stannar på fyra ställen. Två
 * kopior av den här matematiken hade drivit isär vid första justeringen av kameravinkeln.
 *
 * Att den är riktig 3D är inte dekoration: telefonen försvinner BAKOM soffan på det halva varv den är
 * på andra sidan, och det är precis det som är instruktionen. En markör som glider över soffan hade
 * lika gärna kunnat betyda "svep förbi".
 *
 * Soffan är samma modell som annonsens 3D-vy, byggd av samma byggare ur furnitureModel och
 * skuggad av samma render3d — appen ritar möbler på ett sätt, inte två.
 */

import { buildFaces, project, rotate, type Box, type Face, type Palette, type Vec3, type View } from "./render3d";
import { buildModel } from "./furnitureModel";

export const W = 300;
export const H = 208;
/** Plats åt telefonmarkören, som sticker ut utanför banan. */
const MARGIN = 26;

/** Soffan står på snedden mot betraktaren — den vinkel som visar både framsida och kortsida. */
const YAW = -0.62;
/** Strax ovanför sitthöjd, som när man står ett par steg bort. */
const PITCH = 0.3;

const SOFA = { w: 200, d: 92, h: 82 };
/** Banans radie i centimeter, mätt från soffans mitt: ett par steg utanför armstöden. */
export const ORBIT_R = 190;
/** Telefonen hålls i brösthöjd, inte över huvudet. */
export const PHONE_Y = 112;

const PALETTE: Palette = {
  body: "#c9bfb1",
  cushion: "#d9d0c3",
  leg: "#6b4f39",
  surface: "#cdc3b6",
  panel: "#bdb2a3",
};

/**
 * Var telefonen står.
 *
 * `t` är vinkeln runt möbeln: 0 är rakt framför, och t växer medsols sett uppifrån — vilket är samma
 * sak som att säljaren, som står vänd mot framsidan, går åt sitt vänster. Radie och höjd finns för de
 * vinklar som inte är en punkt på varvet: närbilden tas inifrån banan, ovansidan ovanför den.
 */
export interface Vantage {
  t: number;
  /** Avstånd från möbelns mitt i cm. Standard: banans radie. */
  r?: number;
  /** Höjd över golvet i cm. Standard: brösthöjd. */
  y?: number;
  /**
   * Höjden skaftet går ner TILL. Standard: golvet.
   *
   * Finns för vyn ovanifrån, som hålls över sitsen och inte över golvet. Ett skaft hela vägen ner
   * hade dragit en streckad linje rakt igenom soffan, vilket läser som en telefon som spetsat den i
   * stället för en som hålls ovanför den.
   */
  groundY?: number;
}

/** Punkt på gångbanan. t = 0 är rakt framför soffan, och t växer medsols sett uppifrån. */
export function orbitPoint(t: number, y: number, r = ORBIT_R): Vec3 {
  return { x: -Math.sin(t) * r, y, z: Math.cos(t) * r };
}

function sofaBoxes(): Box[] {
  return buildModel("sofa", { width: SOFA.w, depth: SOFA.d, height: SOFA.h, assumed: [] }, [], {}).boxes;
}

function boxCorners(b: Box): Vec3[] {
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    out.push({
      x: b.center.x + (sx * b.size.x) / 2,
      y: b.center.y + (sy * b.size.y) / 2,
      z: b.center.z + (sz * b.size.z) / 2,
    });
  }
  return out;
}

/**
 * Skala och centrering för en FAST vy.
 *
 * render3d:s egen fitPoints mäter över ett helt varv, för möbler man kan vrida på. Här står vyn stilla
 * och banan ska rymmas med — mäts den över alla vinklar reserveras plats som ingen använder, och
 * soffan krymper till en pryl i mitten.
 */
function fitView(points: Vec3[], distance: number): View {
  const probe: View = { yaw: YAW, pitch: PITCH, distance, scale: 1, cx: 0, cy: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const [x, y] = project(p, probe);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const scale = Math.min((W - MARGIN * 2) / (maxX - minX), (H - MARGIN * 2) / (maxY - minY));
  return {
    yaw: YAW,
    pitch: PITCH,
    distance,
    scale,
    cx: W / 2 - ((minX + maxX) / 2) * scale,
    cy: H / 2 - ((minY + maxY) / 2) * scale,
  };
}

export interface Scene {
  view: View;
  faces: Face[];
  ringPath: string;
  footprint: string;
  arrows: string[];
  /** Djupet hos soffans mitt: telefonen ligger framför eller bakom det, och det avgör lagret. */
  splitZ: number;
  centre: [number, number];
  distance: number;
}

/** Allt som inte rör sig: soffan, golvet, banan och måtten rörelsen räknas ur. */
export function buildScene(): Scene {
  const boxes = sofaBoxes();
  // Avståndet styr hur brant perspektivet blir. Kortare än annonsens, för här SKA djupet
  // överdrivas en aning: det är skillnaden mellan när och fjärran som är instruktionen.
  const distance = SOFA.w * 3.4;
  const ring: Vec3[] = [];
  for (let i = 0; i < 64; i++) ring.push(orbitPoint((i / 64) * Math.PI * 2, 0));
  const fitPointsList = [
    ...boxes.flatMap(boxCorners),
    ...ring,
    ...ring.map((p) => ({ ...p, y: PHONE_Y })),
  ];
  const view = fitView(fitPointsList, distance);

  const faces = buildFaces(boxes, view, PALETTE);
  const ringPath = ring.map((p, i) => `${i ? "L" : "M"}${project(p, view).map((n) => n.toFixed(1)).join(" ")}`).join("") + "Z";
  // Soffans avtryck på golvet, suddat till en kontaktskugga. Utan den svävar den.
  const footprint = ([[-1, 1], [1, 1], [1, -1], [-1, -1]] as [number, number][])
    .map(([sx, sz]) => project({ x: (sx * SOFA.w) / 2, y: 0, z: (sz * SOFA.d) / 2 }, view))
    .map((p) => p.map((n) => n.toFixed(1)).join(","))
    .join(" ");
  /**
   * Pilarna LIGGER på golvet, de ligger inte ovanpå bilden.
   *
   * Först var de en glyf som vreds efter banans lutning på skärmen, och en glyf som inte förkortas
   * med underlaget läser som en bokstav som ramlat dit. De här är tre punkter i rummet — utåt,
   * framåt, inåt — projicerade som allt annat, så de smalnar av mot bortre kanten precis som banan
   * de ligger på.
   */
  const arrows = [0.75, 2.75, 4.75].map((t) => {
    const at = (p: [number, number]) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    const tip = at(project(orbitPoint(t + 0.24, 0), view));
    const outer = at(project(orbitPoint(t - 0.04, 0, ORBIT_R + 15), view));
    const inner = at(project(orbitPoint(t - 0.04, 0, ORBIT_R - 15), view));
    return `M${outer}L${tip}L${inner}`;
  });
  const splitZ = rotate({ x: 0, y: SOFA.h / 2, z: 0 }, YAW, PITCH).z;
  const centre = project({ x: 0, y: SOFA.h / 2, z: 0 }, view);
  return { view, faces, ringPath, footprint, arrows, splitZ, centre, distance };
}

/** Telefonmarkören, färdigräknad för ett läge på banan. */
export interface MarkerPlacement {
  /** Sant när telefonen är på andra sidan möbeln och alltså ska ritas FÖRE den. */
  behind: boolean;
  /** Telefonen själv, i skärmkoordinater. */
  phone: [number, number];
  /** Fotpunkten rakt under den, där skaftet möter golvet. */
  foot: [number, number];
  /** Samma perspektiv som allt annat i scenen: nära telefon är större än fjärran. */
  scale: number;
  /** Kamerakäglans riktning i grader — alltid mot möbeln. */
  coneDeg: number;
}

export function placeMarker(scene: Scene, at: Vantage): MarkerPlacement {
  const { view, splitZ, centre, distance } = scene;
  const baseScale = distance / (distance - splitZ);
  const p = orbitPoint(at.t, at.y ?? PHONE_Y, at.r);
  const rz = rotate(p, YAW, PITCH).z;
  const phone = project(p, view);
  return {
    behind: rz < splitZ,
    phone,
    foot: project(orbitPoint(at.t, at.groundY ?? 0, at.r), view),
    scale: Math.max(0.7, Math.min(1.32, distance / (distance - rz) / baseScale)),
    coneDeg: (Math.atan2(centre[1] - phone[1], centre[0] - phone[0]) * 180) / Math.PI,
  };
}

/** En punkt på golvet, projicerad — för prickarna som visar vilka vinklar som redan är tagna. */
export function floorPoint(scene: Scene, t: number, r?: number): [number, number] {
  return project(orbitPoint(t, 0, r), scene.view);
}
