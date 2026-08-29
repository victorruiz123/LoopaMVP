import { useEffect, useId, useMemo, useRef, useState } from "react";
import { buildFaces, fitPoints, project, rotate, type Vec3, type View } from "../lib/render3d";
import type { FurnitureModel } from "../lib/furnitureModel";
import ShadedFaces from "./ShadedFaces";

/**
 * Möbeln renderad i 3D, med måtten utsatta och varje skada som en numrerad punkt på den del den
 * sitter på.
 *
 * Poängen är att skadorna får en PLATS. En lista med "nötning på vänster armstöd" kräver att läsaren
 * bygger möbeln i huvudet för att förstå var det är; en punkt på ett armstöd kräver ingenting alls.
 * Numren går igen i skickrapporten under, så listan och bilden pekar på samma sak.
 *
 * Scenen är byggd som varvguidens på inspelningsskärmen — samma perspektiv en bit ovanför sitthöjd,
 * samma golv under möbeln, samma långsamma rörelse. Det är avsiktligt: säljaren har redan sett sin
 * möbel stå i den bilden när hen filmade den, och kortet ska visa samma möbel i samma rum, inte en
 * ritning i en annan värld.
 */

const VIEW_W = 760;
const VIEW_H = 470;
/** Plats åt måttexten, som sticker ut utanför måttlinjerna. */
const MARGIN = 46;

const START_YAW = -0.56;
const START_PITCH = 0.26;
/** Hur långt nålen står ut från ytan, i centimeter. */
const PIN_LIFT = 9;

/** Rörelsen: en insvängning och sedan en långsam vaggning, som i varvguiden. */
const INTRO_MS = 900;
const INTRO_FROM = 0.46;
const SWAY = 0.17;
const SWAY_MS = 13000;

export interface RenderPin {
  id: string;
  /** Numret som står i punkten och i skickrapporten. */
  number: number;
  point: Vec3;
  normal: Vec3;
  label: string;
  severity: string;
}

export default function FurnitureRender({
  model,
  pins = [],
  selectedId = null,
  onSelect = () => {},
}: {
  model: FurnitureModel;
  /** Skadorna som numrerade punkter. Utelämnas på måttsteget, där det inte finns några än. */
  pins?: RenderPin[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const stage = useRef<HTMLDivElement>(null);
  const [yaw, setYaw] = useState(START_YAW);
  const [pitch, setPitch] = useState(START_PITCH);
  const [dragged, setDragged] = useState(false);
  /** Rörelsen slutar för gott när säljaren tagit i figuren — då är det hens vridning som gäller. */
  const [live, setLive] = useState(true);
  /** Kortet är långt och figuren sitter överst. Rullas den ur bild finns ingen att röra sig för. */
  const [onScreen, setOnScreen] = useState(true);
  const drag = useRef<{ x: number; y: number } | null>(null);
  /** Rörelsens egen tid. Startade den om vid varje paus spelades insvängningen upp på nytt. */
  const elapsed = useRef(0);

  useEffect(() => {
    const el = stage.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Möbeln svänger in och vaggar sedan vidare, långsamt och med litet utslag. Det är samma sorts
  // rörelse som telefonen gör i varvguiden, och den säger vad bilden är: något man kan gå runt,
  // inte ett foto. Ett helt varv vore fel — då står möbeln med ryggen mot läsaren halva tiden.
  useEffect(() => {
    if (!live || !onScreen) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      elapsed.current += now - last;
      last = now;
      const t = elapsed.current;
      const eased = 1 - Math.pow(1 - Math.min(1, t / INTRO_MS), 3);
      const sway = Math.sin((t / SWAY_MS) * Math.PI * 2) * SWAY;
      setYaw(START_YAW - INTRO_FROM * (1 - eased) + sway * eased);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live, onScreen]);

  const { w, d, h } = { w: model.dims.width, d: model.dims.depth, h: model.dims.height };
  /** Hur långt utanför möbeln måttlinjerna läggs. */
  const off = Math.max(12, Math.max(w, d, h) * 0.1);
  // Avståndet skalas med möbeln, annars får en 200 cm soffa ett vidvinkelperspektiv och en 40 cm
  // pall ett teleobjektiv. Något kortare än förr: djupet ska synas, det är det som gör bilden till
  // ett rum och inte en ritning.
  const distance = Math.max(w, d, h) * 3.8;

  const dims = useMemo(() => dimensionLines(model, off, yaw), [model, off, yaw]);

  /**
   * Passningen beror INTE på vridningen — den mäts över ett helt varv (se fitPoints). Räknades den
   * om för varje bildruta under vaggningen kostade det ett par tusen rotationer per ruta, till ingen
   * nytta alls.
   */
  const fit = useMemo(() => {
    // Måttlinjernas ändpunkter räknas in: de ligger utanför möbeln och är det som annars hamnar
    // utanför rutan.
    const points: Vec3[] = [];
    for (const b of model.boxes) {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            points.push({
              x: b.center.x + (sx * b.size.x) / 2,
              y: b.center.y + (sy * b.size.y) / 2,
              z: b.center.z + (sz * b.size.z) / 2,
            });
          }
        }
      }
    }
    for (const line of dimensionLines(model, off, 0)) points.push(line.from, line.to);
    for (const line of dimensionLines(model, off, Math.PI)) points.push(line.from, line.to);
    return fitPoints(points, pitch, distance, VIEW_W, VIEW_H, MARGIN);
  }, [model, off, pitch, distance]);

  const view: View = useMemo(() => ({ yaw, pitch, distance, ...fit }), [yaw, pitch, distance, fit]);
  const faces = useMemo(() => buildFaces(model.boxes, view, model.palette), [model, view]);
  const center = project({ x: 0, y: h / 2, z: 0 }, view);
  const ground = useMemo(() => groundShadow(w, d, view), [w, d, view]);

  function onPointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
    setLive(false);
  }
  function onPointerMove(e: React.PointerEvent) {
    const from = drag.current;
    if (!from) return;
    if (!dragged && Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y) > 3) setDragged(true);
    setYaw((y) => y + (e.clientX - from.x) * 0.009);
    // Lutningen är klämd: underifrån ser möbeln ut att sväva, och rakt uppifrån blir den en plan
    // rektangel där ingen skada går att placera.
    setPitch((p) => Math.max(-0.02, Math.min(0.62, p + (e.clientY - from.y) * 0.003)));
    drag.current = { x: e.clientX, y: e.clientY };
  }
  function onPointerUp() {
    drag.current = null;
  }

  return (
    <div className="render-stage" ref={stage}>
      <svg
        className="render-canvas"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          setYaw(START_YAW);
          setPitch(START_PITCH);
        }}
        role="img"
        aria-label={`3D-vy av möbeln, ${Math.round(w)} × ${Math.round(d)} × ${Math.round(h)} cm`}
      >
        <defs>
          <filter id={`${uid}-blur`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="11" />
          </filter>
          {/* Ljuspölen ger möbeln ett golv i stället för en tom ruta. Utan den ligger
              kontaktskuggan i luften och scenen läser som klistrade lager. */}
          <radialGradient id={`${uid}-floor`}>
            <stop offset="0" stopColor="hsl(30 20% 10%)" stopOpacity="0.13" />
            <stop offset="1" stopColor="hsl(30 20% 10%)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <ellipse cx={ground.cx} cy={ground.cy} rx={ground.rx} ry={ground.ry} fill={`url(#${uid}-floor)`} />
        {/* Kontaktskuggan är möbelns EGET avtryck, inte en ellips: en 200 cm soffa och en 40 cm pall
            lämnar olika märken på golvet, och det är det märket som säger var möbeln står. */}
        <polygon points={ground.footprint} className="render-contact" filter={`url(#${uid}-blur)`} />

        <ShadedFaces faces={faces} />

        <g className="render-dims">
          {dims.map((l, i) => (
            <DimensionLine key={i} line={l} view={view} center={center} />
          ))}
        </g>

        {pins.map((pin) => {
          const base = project(pin.point, view);
          const lifted = project(
            {
              x: pin.point.x + pin.normal.x * PIN_LIFT,
              y: pin.point.y + pin.normal.y * PIN_LIFT,
              z: pin.point.z + pin.normal.z * PIN_LIFT,
            },
            view,
          );
          // Nålar på möbelns baksida tonas ned i stället för att döljas: att en skada försvinner när
          // man vrider skulle läsa som att den inte finns.
          const behind = rotate(pin.normal, view.yaw, view.pitch).z < -0.15;
          const selected = selectedId === pin.id;
          return (
            <g
              key={pin.id}
              className={`render-pin ${behind ? "render-pin-behind" : ""} ${selected ? "render-pin-selected" : ""}`}
              onClick={() => onSelect(selected ? null : pin.id)}
            >
              <line x1={base[0]} y1={base[1]} x2={lifted[0]} y2={lifted[1]} className="render-pin-stem" />
              <circle cx={base[0]} cy={base[1]} r={2.8} className="render-pin-foot" />
              <circle cx={lifted[0]} cy={lifted[1]} r={selected ? 19 : 16} className="render-pin-dot" />
              <text x={lifted[0]} y={lifted[1]} className="render-pin-number">
                {pin.number}
              </text>
            </g>
          );
        })}
      </svg>

      {!dragged && <span className="render-hint">Dra för att vrida</span>}
    </div>
  );
}

interface DimLine {
  from: Vec3;
  to: Vec3;
  label: string;
  assumed: boolean;
}

/**
 * Måttlinjerna längs bredd, djup och höjd — de tre talen en annons för en ny möbel alltid har.
 *
 * Vilken kant de läggs på följer vridningen: linjen ska alltid ligga utanför siluetten, aldrig
 * tvärs över möbeln. Bredden hamnar på den långsida som vetter mot kameran, djupet på den kortsida
 * som gör det, och höjden på det motsatta hörnet så de tre inte möts i samma punkt.
 */
function dimensionLines(model: FurnitureModel, off: number, yaw: number): DimLine[] {
  const { width: w, depth: d, height: h, assumed } = model.dims;
  const zSign = Math.cos(yaw) >= 0 ? 1 : -1;
  const xSign = Math.sin(yaw) <= 0 ? 1 : -1;
  return [
    {
      from: { x: -w / 2, y: 0, z: zSign * (d / 2 + off) },
      to: { x: w / 2, y: 0, z: zSign * (d / 2 + off) },
      label: `${Math.round(w)} cm`,
      assumed: assumed.includes("width"),
    },
    {
      from: { x: xSign * (w / 2 + off), y: 0, z: d / 2 },
      to: { x: xSign * (w / 2 + off), y: 0, z: -d / 2 },
      label: `${Math.round(d)} cm`,
      assumed: assumed.includes("depth"),
    },
    {
      from: { x: -xSign * (w / 2 + off), y: 0, z: zSign * (d / 2) },
      to: { x: -xSign * (w / 2 + off), y: h, z: zSign * (d / 2) },
      label: `${Math.round(h)} cm`,
      assumed: assumed.includes("height"),
    },
  ];
}

function DimensionLine({ line, view, center }: { line: DimLine; view: View; center: [number, number] }) {
  const a = project(line.from, view);
  const b = project(line.to, view);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  // Ändmarkeringarna vinkelrätt mot linjen, så måttet läser som ett mått och inte som en pil.
  const px = -dy / len;
  const py = dx / len;
  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // Texten läggs på den sida av linjen som vetter BORT från möbeln, annars hamnar den ovanpå den.
  const away = (mid[0] - center[0]) * px + (mid[1] - center[1]) * py >= 0 ? 1 : -1;
  return (
    <g className={line.assumed ? "render-dim render-dim-assumed" : "render-dim"}>
      <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
      <line x1={a[0] - px * 5} y1={a[1] - py * 5} x2={a[0] + px * 5} y2={a[1] + py * 5} />
      <line x1={b[0] - px * 5} y1={b[1] - py * 5} x2={b[0] + px * 5} y2={b[1] + py * 5} />
      <text x={mid[0] + px * away * 15} y={mid[1] + py * away * 15}>
        {line.assumed ? `≈ ${line.label}` : line.label}
      </text>
    </g>
  );
}

/** Möbelns avtryck på golvet, plus den mjuka ljuspölen runt det. */
function groundShadow(w: number, d: number, view: View) {
  const c = project({ x: 0, y: 0, z: 0 }, view);
  const right = project({ x: w / 2, y: 0, z: 0 }, view);
  const front = project({ x: 0, y: 0, z: d / 2 }, view);
  const footprint = ([
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as [number, number][])
    .map(([sx, sz]) => project({ x: (sx * w) / 2, y: 0, z: (sz * d) / 2 }, view))
    .map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`)
    .join(" ");
  return {
    footprint,
    cx: c[0],
    cy: c[1],
    rx: Math.abs(right[0] - c[0]) + Math.abs(front[0] - c[0]) * 0.6 + 30,
    ry: Math.abs(front[1] - c[1]) + 20,
  };
}
