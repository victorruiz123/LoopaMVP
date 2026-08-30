import { useEffect, useMemo, useRef } from "react";
import { buildScene, placeMarker, PHONE_Y, ORBIT_R, W, H, type MarkerPlacement, type Vantage } from "../lib/guideScene";
import ShadedFaces from "./ShadedFaces";

/**
 * Möbeln, banan runt den och telefonen någonstans på banan.
 *
 * Två guider ritar samma scen och menar olika saker med den. Filmguiden (`lap`) låter telefonen gå
 * varv efter varv: rörelsen ÄR instruktionen. Fotoguiden (`at`) ställer den på ett bestämt ställe och
 * låter den GLIDA dit när stället byts — sträckan telefonen far är exakt den sträcka säljaren ska gå,
 * och den är därför värd att visa i stället för att klippa.
 *
 * Markören skrivs med attribut i stället för via state: banan uppdateras varje bildruta, och en
 * omritning av hela scenen 60 gånger i sekunden hade varit att räkna om soffan för telefonens skull.
 */

const LAP_MS = 8200;
/** Ett stationsbyte: långsamt nog att gå att följa med blicken, kort nog att inte vara en väntan. */
const MOVE_MS = 560;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Kortaste vägen runt. Framåt genom stationerna blir framåt runt möbeln; ett omtag backar. */
function shortestTurn(from: number, to: number): number {
  const raw = (to - from) % (Math.PI * 2);
  if (raw > Math.PI) return raw - Math.PI * 2;
  if (raw < -Math.PI) return raw + Math.PI * 2;
  return raw;
}

function resolve(at: Vantage): Required<Vantage> {
  return { t: at.t, r: at.r ?? ORBIT_R, y: at.y ?? PHONE_Y, groundY: at.groundY ?? 0 };
}

const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

export default function GuideScene({
  lap,
  at,
  className = "guide3d",
}: {
  /** Telefonen går ett varv, om och om igen. */
  lap?: boolean;
  /** Telefonen står här. Byts värdet glider den till det nya stället. */
  at?: Vantage;
  className?: string;
}) {
  const farRef = useRef<SVGGElement>(null);
  const nearRef = useRef<SVGGElement>(null);
  const scene = useMemo(buildScene, []);
  /** Var telefonen står just nu, så ett byte kan börja där och inte vid förra stationens mål. */
  const standingAt = useRef<Required<Vantage> | null>(null);

  useEffect(() => {
    const layers = [farRef.current, nearRef.current].map((root) => ({
      root,
      stem: root?.querySelector<SVGPathElement>(".guide3d-stem") ?? null,
      foot: root?.querySelector<SVGEllipseElement>(".guide3d-foot") ?? null,
      chip: root?.querySelector<SVGGElement>(".guide3d-chip") ?? null,
      cone: root?.querySelector<SVGPathElement>(".guide3d-cone") ?? null,
    }));

    function paint(placement: MarkerPlacement) {
      for (const layer of layers) {
        if (!layer.root) continue;
        const active = (layer.root === farRef.current) === placement.behind;
        layer.root.style.display = active ? "" : "none";
        if (!active) continue;
        layer.root.style.opacity = placement.behind ? "0.82" : "1";
        const [px, py] = placement.phone;
        const [fx, fy] = placement.foot;
        layer.stem?.setAttribute("d", `M${fx.toFixed(1)} ${fy.toFixed(1)}L${px.toFixed(1)} ${py.toFixed(1)}`);
        layer.foot?.setAttribute("cx", fx.toFixed(1));
        layer.foot?.setAttribute("cy", fy.toFixed(1));
        layer.chip?.setAttribute(
          "transform",
          `translate(${px.toFixed(1)} ${py.toFixed(1)}) scale(${placement.scale.toFixed(3)})`,
        );
        layer.cone?.setAttribute("transform", `rotate(${placement.coneDeg.toFixed(1)})`);
      }
    }

    /** Ritar OCH kommer ihåg var telefonen hamnade, så nästa förflyttning startar där den står. */
    const draw = (v: Vantage) => {
      standingAt.current = resolve(v);
      paint(placeMarker(scene, v));
    };

    if (lap) {
      if (prefersReducedMotion()) {
        // Stillbilden ställs vid soffans framkant på väg åt vänster: banan syns, rörelsen påstås inte.
        draw({ t: 0.6 });
        return;
      }
      let raf = 0;
      const start = performance.now();
      const tick = (now: number) => {
        draw({ t: (((now - start) % LAP_MS) / LAP_MS) * Math.PI * 2 });
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    if (!at) return;
    const target = resolve(at);
    // Läses FÖRE första draw, som skriver över den. Avbryts en förflyttning halvvägs — säljaren
    // bläddrar snabbt — börjar nästa där telefonen faktiskt står och inte där den var på väg.
    const from = standingAt.current;
    if (!from || prefersReducedMotion()) {
      draw(target);
      return;
    }
    const turn = shortestTurn(from.t, target.t);
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / MOVE_MS);
      const e = easeInOut(p);
      draw({
        t: from.t + turn * e,
        r: from.r + (target.r - from.r) * e,
        y: from.y + (target.y - from.y) * e,
        // Skaftets fäste följer med: annars hoppar det mellan golv och sits i samma ögonblick som
        // förflyttningen börjar, och skuggan far över möbeln före telefonen.
        groundY: from.groundY + (target.groundY - from.groundY) * e,
      });
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [scene, lap, at]);

  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
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
      {/* Pilarna hör till varvet. I fotoguiden är det telefonens egen förflyttning som visar hållet,
          och två saker som pekar åt samma håll konkurrerar bara om blicken. */}
      {lap &&
        scene.arrows.map((d, i) => (
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
