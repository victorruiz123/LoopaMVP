import { useEffect, useMemo, useRef } from "react";
import { buildFaces, project, rotate, type Box, type Palette, type Vec3, type View } from "../lib/render3d";
import { buildModel } from "../lib/furnitureModel";
import ShadedFaces from "./ShadedFaces";

/**
 * Varvet, visat som det ser ut när man går det.
 *
 * Guiden var först en cirkel ovanifrån, och en karta är fel bild för det här: säljaren står ju inte
 * ovanför soffan, hen står bredvid den. Scenen ritas därför i samma perspektiv som säljaren själv har
 * — soffan på snedden, en aning underifrån ögonhöjd — med telefonen på en verklig bana runt den.
 *
 * Att den är riktig 3D är inte dekoration: telefonen försvinner BAKOM soffan på det halva varv den är
 * på andra sidan, och det är precis det som är instruktionen. En markör som glider över soffan hade
 * lika gärna kunnat betyda "svep förbi".
 *
 * Soffan är samma modell som truth-cardets 3D-vy, byggd av samma byggare ur furnitureModel och
 * skuggad av samma render3d — appen ritar möbler på ett sätt, inte två.
 */

const W = 300;
const H = 208;
/** Plats åt telefonmarkören, som sticker ut utanför banan. */
const MARGIN = 26;

/** Soffan står på snedden mot betraktaren — den vinkel som visar både framsida och kortsida. */
const YAW = -0.62;
/** Strax ovanför sitthöjd, som när man står ett par steg bort. */
const PITCH = 0.3;

const SOFA = { w: 200, d: 92, h: 82 };
/** Banans radie i centimeter, mätt från soffans mitt: ett par steg utanför armstöden. */
const ORBIT_R = 190;
/** Telefonen hålls i brösthöjd, inte över huvudet. */
const PHONE_Y = 112;
const LAP_MS = 8200;

const PALETTE: Palette = {
  body: "#c9bfb1",
  cushion: "#d9d0c3",
  leg: "#6b4f39",
  surface: "#cdc3b6",
  panel: "#bdb2a3",
};

/**
 * Soffan är truth-cardets soffa, byggd av samma byggare som möbeln på kortet.
 *
 * Den var förut utritad för hand här, med egna tal för sitshöjd och armstöd, och två soffor i samma
 * app driver isär: rättade man dynorna på den ena satt den andra kvar som den var. Här är den en
 * generisk tresitsare, inte säljarens — guiden visar RÖRELSEN, och att gissa fram säljarens möbel
 * innan vi ens sett den vore att påstå något.
 */
function sofaBoxes(): Box[] {
  return buildModel("sofa", { width: SOFA.w, depth: SOFA.d, height: SOFA.h, assumed: [] }, [], {}).boxes;
}

/** Punkt på gångbanan. t = 0 är rakt framför soffan, och t växer medsols sett uppifrån. */
function orbitPoint(t: number, y: number, r = ORBIT_R): Vec3 {
  return { x: -Math.sin(t) * r, y, z: Math.cos(t) * r };
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

/** Allt som inte rör sig: soffan, golvet, banan och måtten rörelsen räknas ur. */
export function buildScene() {
  const boxes = sofaBoxes();
  // Avståndet styr hur brant perspektivet blir. Kortare än truth-cardets, för här SKA djupet
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
  // Djupet hos soffans mitt: telefonen ligger framför eller bakom den, och det avgör lagret.
  const splitZ = rotate({ x: 0, y: SOFA.h / 2, z: 0 }, YAW, PITCH).z;
  const centre = project({ x: 0, y: SOFA.h / 2, z: 0 }, view);
  return { view, faces, ringPath, footprint, arrows, splitZ, centre, distance };
}

export default function WalkaroundGuide({ subject }: { subject?: string }) {
  const farRef = useRef<SVGGElement>(null);
  const nearRef = useRef<SVGGElement>(null);
  const scene = useMemo(buildScene, []);

  useEffect(() => {
    const layers = [farRef.current, nearRef.current].map((root) => ({
      root,
      stem: root?.querySelector<SVGPathElement>(".guide3d-stem") ?? null,
      foot: root?.querySelector<SVGEllipseElement>(".guide3d-foot") ?? null,
      chip: root?.querySelector<SVGGElement>(".guide3d-chip") ?? null,
      cone: root?.querySelector<SVGPathElement>(".guide3d-cone") ?? null,
    }));
    const { view, splitZ, centre, distance } = scene;
    const baseScale = distance / (distance - splitZ);

    function draw(t: number) {
      const p = orbitPoint(t, PHONE_Y);
      const rz = rotate(p, YAW, PITCH).z;
      const behind = rz < splitZ;
      const [px, py] = project(p, view);
      const [fx, fy] = project(orbitPoint(t, 0), view);
      // Samma perspektiv som allt annat i scenen: nära telefon är större än fjärran.
      const depth = Math.max(0.7, Math.min(1.32, distance / (distance - rz) / baseScale));
      const cone = (Math.atan2(centre[1] - py, centre[0] - px) * 180) / Math.PI;

      for (const layer of layers) {
        if (!layer.root) continue;
        const active = (layer.root === farRef.current) === behind;
        layer.root.style.display = active ? "" : "none";
        if (!active) continue;
        layer.root.style.opacity = behind ? "0.82" : "1";
        layer.stem?.setAttribute("d", `M${fx.toFixed(1)} ${fy.toFixed(1)}L${px.toFixed(1)} ${py.toFixed(1)}`);
        layer.foot?.setAttribute("cx", fx.toFixed(1));
        layer.foot?.setAttribute("cy", fy.toFixed(1));
        layer.chip?.setAttribute("transform", `translate(${px.toFixed(1)} ${py.toFixed(1)}) scale(${depth.toFixed(3)})`);
        layer.cone?.setAttribute("transform", `rotate(${cone.toFixed(1)})`);
      }
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Stillbilden ställs vid soffans framkant på väg åt vänster: banan syns, rörelsen påstås inte.
      draw(0.6);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      draw((((now - start) % LAP_MS) / LAP_MS) * Math.PI * 2);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scene]);

  return (
    <div className="capture-guide">
      <div className="capture-guide-inner">
        {subject && <span className="capture-guide-subject">{subject}</span>}
        <h2 className="capture-guide-title">Gå ett varv runt möbeln</h2>

        <svg className="guide3d" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          <defs>
            <filter id="guide3d-shadow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="7" />
            </filter>
            {/* Golvet: en aning ljus i mitten, så soffan och banan har en yta att stå på. Utan den
                hänger kontaktskuggan i luften och scenen läser som klistrade lager. */}
            <radialGradient id="guide3d-floor">
              <stop offset="0" stopColor="#fff" stopOpacity="0.15" />
              <stop offset="1" stopColor="#fff" stopOpacity="0.02" />
            </radialGradient>
            <radialGradient id="guide3d-cone" cx="0" cy="0.5" r="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0.34" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
          </defs>

          <path className="guide3d-floor" d={scene.ringPath} fill="url(#guide3d-floor)" />
          <polygon className="guide3d-contact" points={scene.footprint} filter="url(#guide3d-shadow)" />
          {/* Banan ritas före soffan, så soffan skymmer den del av golvet som ligger bakom. */}
          <path className="guide3d-ring" d={scene.ringPath} />
          {scene.arrows.map((d, i) => (
            <path key={i} className="guide3d-ring-arrow" style={{ animationDelay: `${i * 0.5}s` }} d={d} />
          ))}

          <g ref={farRef} className="guide3d-marker">
            <Marker />
          </g>
          <ShadedFaces faces={scene.faces} />
          <g ref={nearRef} className="guide3d-marker">
            <Marker />
          </g>
        </svg>

        <ol className="capture-guide-steps">
          <li>Håll telefonen i brösthöjd med hela möbeln i bild</li>
          <li>Gå långsamt ett helt varv — ungefär 40 sekunder</li>
          <li>Filmen stannar själv när du är tillbaka där du började</li>
        </ol>
        <p className="capture-guide-cta">Tryck på den röda knappen för att börja</p>
      </div>
    </div>
  );
}

/** Telefonen på banan: skaft ner till golvet, kameran vänd mot soffan. */
function Marker() {
  return (
    <>
      <path className="guide3d-stem" />
      <ellipse className="guide3d-foot" rx="7" ry="2.6" />
      <g className="guide3d-chip">
        <path className="guide3d-cone" d="M0 0L34 -13L34 13Z" fill="url(#guide3d-cone)" />
        <circle className="guide3d-chip-bg" r="14" />
        <rect className="guide3d-phone" x="-4.6" y="-7.6" width="9.2" height="15.2" rx="2.2" />
        <circle className="guide3d-lens" cy="-3.4" r="1.5" />
      </g>
    </>
  );
}
