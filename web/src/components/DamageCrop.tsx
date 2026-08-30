import { imageUrl } from "../api";
import { cropPlacement } from "../lib/damageCrop";
import type { CapturedImage, DamageEvidence } from "../types";

/**
 * Skadan själv, i miniatyr.
 *
 * Inte hela fotot med en ruta i — det är vad `MarkedThumb` visar, och det svarar på VAR på möbeln
 * fyndet sitter. Den här svarar på hur det SER UT, vilket är frågan säljaren ställer först och som
 * på telefonen tidigare krävde ett tryck och en helskärmsvy.
 *
 * Utsnittet görs i webbläsaren, inte på servern: rutan finns redan i fyndet, originalet är högst
 * 1280 px brett, och samma foto bär oftast flera fynd — en enda hämtning räcker då till hela listan.
 * Serverns egna utsnitt (`evidence.cropPath`) hade varit en fil per fynd, och de finns dessutom bara
 * för de fynd som gick till granskning.
 */
export default function DamageCrop({
  jobId,
  evidence,
  image,
  count = 1,
}: {
  jobId: string;
  evidence: DamageEvidence;
  image?: CapturedImage;
  /** Hur många bildrutor fyndet har. Fler än en säger sig själv i hörnet. */
  count?: number;
}) {
  const src = imageUrl(jobId, evidence.imageId);
  const badge = count > 1 && <span className="damage-crop-count">{count}</span>;

  /**
   * Utan bildens mått går utsnittet inte att räkna ut — förstoringen måste veta hur bred rutan är i
   * PIXLAR, inte bara i andelar. Då visas hela bilden i stället. Det är ett sämre svar på frågan, men
   * det är ett ärligt svar, och det är fortfarande en bild.
   */
  if (!image?.width || !image?.height) {
    return (
      <span className="damage-crop">
        <img className="damage-crop-whole" src={src} alt="" />
        {badge}
      </span>
    );
  }

  const { widthPct, heightPct, leftPct, topPct } = cropPlacement(evidence.mark, image);

  return (
    <span className="damage-crop">
      <img
        className="damage-crop-img"
        src={src}
        alt=""
        style={{ width: `${widthPct}%`, height: `${heightPct}%`, left: `${leftPct}%`, top: `${topPct}%` }}
      />
      {badge}
    </span>
  );
}
