import { imageUrl } from "../api";
import type { CapturedImage, DamageEvidence } from "../types";

export default function MarkedThumb({
  jobId,
  evidence,
  image,
  size = "sm",
  onClick,
}: {
  jobId: string;
  evidence: DamageEvidence;
  image?: CapturedImage;
  size?: "sm" | "lg";
  onClick?: () => void;
}) {
  const mark = evidence.mark;
  // Inner box is sized to the image's true aspect ratio so percentage marks stay aligned — a plain
  // object-fit:cover thumbnail would crop the image and throw off every mark.
  const aspectRatio = image ? `${image.width} / ${image.height}` : undefined;

  return (
    <button className={`marked-thumb marked-thumb-${size}`} onClick={onClick}>
      <div className="marked-thumb-inner" style={{ aspectRatio }}>
        <img src={imageUrl(jobId, evidence.imageId)} alt="" />
        {mark.kind === "box" ? (
          <div
            className="marked-thumb-box"
            style={{
              left: `${mark.x * 100}%`,
              top: `${mark.y * 100}%`,
              width: `${(mark.w ?? 0.1) * 100}%`,
              height: `${(mark.h ?? 0.1) * 100}%`,
            }}
          />
        ) : (
          <svg className="marked-thumb-line" viewBox="0 0 100 100" preserveAspectRatio="none">
            <line
              x1={mark.x * 100}
              y1={mark.y * 100}
              x2={(mark.x2 ?? mark.x) * 100}
              y2={(mark.y2 ?? mark.y) * 100}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
      {size === "sm" && image?.viewLabel && <span className="marked-thumb-angle">{image.viewLabel}</span>}
    </button>
  );
}
