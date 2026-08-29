/**
 * En liten 3D-renderare i SVG.
 *
 * Möbeln ritas som ett tiotal lådor, sorterade bakifrån och fram. Det är fortfarande INTE ett foto:
 * vi har möbelns mått och kategori, aldrig dess ritning, och en render som låtsas vara ett foto
 * skulle påstå mer än vi vet. Men skillnaden mellan "vet inte formen i detalj" och "ser ut som en
 * hög klossar" är stor, och den senare fick kortet att se billigt ut. Därför: rundade kanter,
 * toning över varje yta i stället för en platt fyllning, och mörkare ju närmare golvet ytan sitter.
 * Det påstår inget nytt om möbeln — det påstår bara att den är gjord av något.
 *
 * three.js valdes bort: det är ~150 kB gzippat för ett tiotal lådor, kräver WebGL (som fallerar tyst
 * i vissa webbvyer) och hade gjort skuggningen till bibliotekets stil i stället för Loopas. SVG ritas
 * av samma motor som resten av kortet, går att skärmdumpa och skriva ut, och skalar med sidan.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** En låda i modellrymden: centrum + storlek i centimeter, y uppåt från golvet. */
export interface Box {
  center: Vec3;
  size: Vec3;
  /** Vilken yta lådan är — styr grundfärg och hur blank den ser ut. */
  material: "body" | "cushion" | "leg" | "surface" | "panel";
  /** Kantradie i centimeter. En sittdyna med skarpa hörn läser som en kloss, inte som en dyna. */
  radius?: number;
  /** Lutning kring x-axeln i radianer. Positiv lutar ovankanten mot betraktaren. */
  tilt?: number;
}

export interface Face {
  /** Ytan som path, med hörnen rundade efter lådans radie. */
  path: string;
  /** Toningens ljusa respektive mörka ände. Riktningen är LIGHT_GRADIENT, samma för alla ytor. */
  light: string;
  dark: string;
  /** Djupet hos ytans mittpunkt, för målarsortering. */
  depth: number;
}

const CORNERS: [number, number, number][] = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

/** Ytorna som hörnindex, med sin normal i modellrymden. */
const FACES: { idx: [number, number, number, number]; normal: Vec3 }[] = [
  { idx: [4, 5, 6, 7], normal: { x: 0, y: 0, z: 1 } },   // fram
  { idx: [1, 0, 3, 2], normal: { x: 0, y: 0, z: -1 } },  // bak
  { idx: [5, 1, 2, 6], normal: { x: 1, y: 0, z: 0 } },   // höger
  { idx: [0, 4, 7, 3], normal: { x: -1, y: 0, z: 0 } },  // vänster
  { idx: [7, 6, 2, 3], normal: { x: 0, y: 1, z: 0 } },   // topp
  { idx: [0, 1, 5, 4], normal: { x: 0, y: -1, z: 0 } },  // botten
];

export function rotate(p: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return { x: x1, y: p.y * cp - z1 * sp, z: p.y * sp + z1 * cp };
}

/** Lådans egen lutning, kring x-axeln. Ryggstöd och sänggavlar står inte lodrätt i verkligheten. */
function tiltX(p: Vec3, tilt: number): Vec3 {
  if (!tilt) return p;
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
}

export interface View {
  yaw: number;
  pitch: number;
  /** Kamerans avstånd i centimeter. Styr hur kraftigt perspektivet är. */
  distance: number;
  scale: number;
  cx: number;
  cy: number;
}

/** Modellrymd -> bildpunkt. Perspektiv, inte isometri: en ren isometri ser ut som en ritning. */
export function project(p: Vec3, view: View): [number, number] {
  const r = rotate(p, view.yaw, view.pitch);
  const s = view.distance / (view.distance - r.z);
  return [view.cx + r.x * s * view.scale, view.cy - r.y * s * view.scale];
}

/** Ljuset står stilla medan möbeln vrids — det är möbeln som snurrar, inte lampan. */
const LIGHT: Vec3 = { x: -0.42, y: 0.82, z: 0.39 };

/**
 * Ljussättningen: grundljus, huvudljus och en himmel.
 *
 * Talen är hårt sammanpressade med flit. Med ett vanligt lambertljus hamnade en yta som vänder bort
 * från lampan på halva ljusstyrkan, och då läser den inte som samma möbel i skugga utan som en annan
 * möbel i en annan färg — ett valnötsbord fick nästan svarta ben och en ljusbrun skiva. Spannet här
 * är ungefär 0,7–1,05, vilket är vad man faktiskt mäter på ett produktfoto i ett mjukt ljus.
 *
 * Himlen (SKY) är den som gör jobbet uppåt: ytor som vetter mot taket får en gnutta extra oavsett var
 * lampan står, precis som i ett rum med fönster.
 */
const BASE = 0.72;
const KEY = 0.21;
const SKY = 0.11;

/**
 * Toningens riktning över en yta, i objectBoundingBox-koordinater.
 *
 * Ljuset är definierat i SKÄRMENS rymd (se LIGHT), så riktningen är densamma för varje yta och
 * ändras aldrig när möbeln vrids. Stopp 0 ligger mot ljuset, stopp 1 bort från det.
 */
export const LIGHT_GRADIENT = (() => {
  const len = Math.hypot(LIGHT.x, LIGHT.y) || 1;
  const dx = LIGHT.x / len;
  const dy = -LIGHT.y / len;
  return { x1: 0.5 + dx / 2, y1: 0.5 + dy / 2, x2: 0.5 - dx / 2, y2: 0.5 - dy / 2 };
})();

/**
 * Hur brett en yta får tonas mellan sin ljusa och mörka ände.
 *
 * Tyg sprider ljuset och tonar knappt; lack och metall gör tvärtom. Det är den enda skillnaden vi
 * ritar mellan materialen utöver färgen, och den räcker för att ett kromben inte ska se ut som filt.
 */
const SHEEN: Record<Box["material"], number> = {
  body: 0.07,
  cushion: 0.06,
  leg: 0.17,
  surface: 0.12,
  panel: 0.09,
};

function shade(normal: Vec3, view: View): number {
  const n = rotate(normal, view.yaw, view.pitch);
  const dot = n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z;
  return BASE + KEY * Math.max(0, dot) + SKY * (0.5 + 0.5 * n.y);
}

function tone(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, Math.round(v * factor))),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export interface Palette {
  body: string;
  cushion: string;
  leg: string;
  surface: string;
  panel: string;
}

function fmt(p: [number, number]): string {
  return `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
}

/** Punkten `r` bildpunkter in på sträckan från -> to, men aldrig längre än halva den. */
function along(from: [number, number], to: [number, number], r: number): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const t = Math.min(r, len / 2) / len;
  return [from[0] + dx * t, from[1] + dy * t];
}

/**
 * Ytan som path med rundade hörn.
 *
 * Rundningen görs i BILDLED och inte i geometrin: en riktig fasning hade krävt tio gånger så många
 * ytor per låda för något som på en telefonskärm är fyra bildpunkter brett. Kvadratiska kurvor med
 * hörnet som styrpunkt ger samma intryck till priset av en bokstav i en sträng.
 */
function roundedQuad(pts: [number, number][], r: number): string {
  if (r < 0.7) return `M${pts.map(fmt).join("L")}Z`;
  let d = "";
  for (let i = 0; i < 4; i++) {
    const prev = pts[(i + 3) % 4];
    const cur = pts[i];
    const next = pts[(i + 1) % 4];
    d += `${i === 0 ? "M" : "L"}${fmt(along(cur, prev, r))}Q${fmt(cur)} ${fmt(along(cur, next, r))}`;
  }
  return `${d}Z`;
}

/** Alla lådors ytor, baksidesgallrade och sorterade bakifrån och fram. */
export function buildFaces(boxes: Box[], view: View, palette: Palette): Face[] {
  // Möbelns överkant, som referens för kontaktskuggningen nedan.
  const top = boxes.reduce((m, b) => Math.max(m, b.center.y + b.size.y / 2), 1);
  const out: Face[] = [];
  for (const box of boxes) {
    const base = palette[box.material];
    const sheen = SHEEN[box.material];
    const tilt = box.tilt ?? 0;
    const corners = CORNERS.map((c) => {
      const local = tiltX({ x: (c[0] * box.size.x) / 2, y: (c[1] * box.size.y) / 2, z: (c[2] * box.size.z) / 2 }, tilt);
      return { x: box.center.x + local.x, y: box.center.y + local.y, z: box.center.z + local.z };
    });
    const rotated = corners.map((c) => rotate(c, view.yaw, view.pitch));
    for (const face of FACES) {
      const normal = tiltX(face.normal, tilt);
      const n = rotate(normal, view.yaw, view.pitch);
      // Baksidesgallring: ytor som vänder bort från kameran ritas aldrig. Utan den målar
      // insidan av lådan över utsidan så fort perspektivet blir brant.
      if (n.z <= 0.001) continue;
      const pts = face.idx.map((i) => {
        const r = rotated[i];
        const s = view.distance / (view.distance - r.z);
        return [view.cx + r.x * s * view.scale, view.cy - r.y * s * view.scale] as [number, number];
      });
      const depth = face.idx.reduce((sum, i) => sum + rotated[i].z, 0) / 4;
      // Ju närmare golvet, desto mindre ljus når ytan. Det är den billigaste sortens ambient
      // occlusion som finns, och den ensam gör att möbeln STÅR på golvet i stället för att ligga
      // klistrad framför det.
      const y = face.idx.reduce((sum, i) => sum + corners[i].y, 0) / 4;
      const ao = 0.92 + 0.08 * Math.min(1, Math.max(0, y / (top * 0.7)));
      const lit = shade(normal, view) * ao;
      out.push({
        path: roundedQuad(pts, ((box.radius ?? 0) * view.scale * view.distance) / (view.distance - depth)),
        light: tone(base, lit * (1 + sheen)),
        dark: tone(base, lit * (1 - sheen)),
        depth,
      });
    }
  }
  return out.sort((a, b) => a.depth - b.depth);
}

/**
 * Skala och centrering som rymmer punkterna i rutan OAVSETT vridning.
 *
 * Måttet tas över ett helt varv, inte på den aktuella vinkeln: en skala som följde den faktiska
 * utbredningen hade fått möbeln att växa och krympa medan man vred på den, vilket läser som att man
 * zoomar. Ett varv i stället för halva diagonalen ger ändå en tät passning — diagonalen reserverar
 * plats för ett hörn som bara sticker ut i en enda vinkel.
 */
export function fitPoints(
  points: Vec3[],
  pitch: number,
  distance: number,
  width: number,
  height: number,
  margin: number,
): { scale: number; cx: number; cy: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 24; i++) {
    const yaw = (i / 24) * Math.PI * 2;
    for (const p of points) {
      const r = rotate(p, yaw, pitch);
      const s = distance / (distance - r.z);
      const x = r.x * s;
      const y = r.y * s;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const scale = Math.min((width - margin * 2) / (maxX - minX), (height - margin * 2) / (maxY - minY));
  return {
    scale,
    cx: width / 2 - ((minX + maxX) / 2) * scale,
    cy: height / 2 + ((minY + maxY) / 2) * scale,
  };
}
