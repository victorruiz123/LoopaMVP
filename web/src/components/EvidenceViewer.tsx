import { useState } from "react";
import { ArrowLeftIcon, MinusIcon, PlusIcon } from "./icons";
import { imageUrl } from "../api";
import type { CapturedImage, Damage } from "../types";
import { typeLabel } from "../lib/labels";
import { useT } from "../lib/i18n";

const ZOOM_LEVELS = [100, 150, 250, 400];

export default function EvidenceViewer({
  jobId,
  damage,
  images,
  startIndex,
  onClose,
}: {
  jobId: string;
  damage: Damage;
  images: CapturedImage[];
  startIndex: number;
  onClose: () => void;
}) {
  const t = useT();
  const [index, setIndex] = useState(startIndex);
  const [zoomIdx, setZoomIdx] = useState(0);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const evidence = damage.evidence[index];
  const zoom = ZOOM_LEVELS[zoomIdx];
  const imgMeta = images.find((i) => i.id === evidence.imageId);
  // The wrap is sized to the image's exact intrinsic aspect ratio so percentage-based overlay
  // coordinates land on the true pixel content, not on any object-fit letterbox/pillarbox gap.
  const aspectRatio = imgMeta ? `${imgMeta.width} / ${imgMeta.height}` : undefined;

  function zoomIn() {
    setZoomIdx((i) => Math.min(i + 1, ZOOM_LEVELS.length - 1));
  }
  function zoomOut() {
    setZoomIdx((i) => Math.max(i - 1, 0));
    if (zoomIdx <= 1) setDrag({ x: 0, y: 0 });
  }

  function onPointerDown(e: React.PointerEvent) {
    setDragging({ startX: e.clientX, startY: e.clientY, origX: drag.x, origY: drag.y });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging) return;
    setDrag({ x: dragging.origX + (e.clientX - dragging.startX), y: dragging.origY + (e.clientY - dragging.startY) });
  }
  function onPointerUp() {
    setDragging(null);
  }

  const mark = evidence.mark;
  const markStyle: React.CSSProperties =
    mark.kind === "box"
      ? {
          position: "absolute",
          left: `${mark.x * 100}%`,
          top: `${mark.y * 100}%`,
          width: `${(mark.w ?? 0.1) * 100}%`,
          height: `${(mark.h ?? 0.1) * 100}%`,
          // Samma röd som miniatyrens ruta (--danger). Här stod en Tailwind-röd, så EN skada
          // ritades i två olika röda beroende på om man tittade på den i listan eller i stort.
          border: "2px solid var(--danger)",
          borderRadius: 4,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.15)",
        }
      : {};

  return (
    <div className="evidence-viewer">
      <div className="evidence-viewer-top">
        <button className="btn btn-ghost" onClick={onClose}>
          <ArrowLeftIcon /> {t("Tillbaka")}
        </button>
        <div className="evidence-viewer-title">
          {typeLabel(damage.type) ?? damage.type}
          {imgMeta?.viewLabel ? ` · ${t(imgMeta.viewLabel)}` : ""}
        </div>
        <div className="zoom-controls">
          <button onClick={zoomOut} aria-label={t("Zooma ut")}>
            <MinusIcon size={15} />
          </button>
          <span>{zoom}%</span>
          <button onClick={zoomIn} aria-label={t("Zooma in")}>
            <PlusIcon size={15} />
          </button>
        </div>
      </div>

      <div
        className="evidence-viewer-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div
          className="evidence-viewer-image-wrap"
          style={{ transform: `translate(${drag.x}px, ${drag.y}px) scale(${zoom / 100})`, aspectRatio }}
        >
          <img src={imageUrl(jobId, evidence.imageId)} alt="" draggable={false} />
          {mark.kind === "line" ? (
            <svg className="evidence-line-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
              <line
                x1={mark.x * 100}
                y1={mark.y * 100}
                x2={(mark.x2 ?? mark.x) * 100}
                y2={(mark.y2 ?? mark.y) * 100}
                stroke="var(--danger)"
                strokeWidth={0.8}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ) : (
            <div style={markStyle} />
          )}
        </div>
      </div>

      {damage.evidence.length > 1 && (
        <div className="evidence-dots">
          {damage.evidence.map((_, i) => (
            <button
              key={i}
              type="button"
              className={`evidence-dot ${i === index ? "active" : ""}`}
              aria-label={t("Bild {nr} av {antal}", { nr: i + 1, antal: damage.evidence.length })}
              aria-current={i === index}
              onClick={() => {
                setIndex(i);
                setZoomIdx(0);
                setDrag({ x: 0, y: 0 });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
