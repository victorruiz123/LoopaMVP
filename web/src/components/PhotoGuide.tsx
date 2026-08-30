import { useT } from "../lib/i18n";
import GuideScene from "./GuideScene";
import { CheckIcon } from "./icons";
import type { PhotoStation } from "../lib/photoStations";

/**
 * Fotoguiden: samma varv som filmguiden, men stannat på sex ställen.
 *
 * Skillnaden mot filmguidens overlay är att den här ska synas MEDAN säljaren fotograferar, inte
 * innan. Därför ett smalt kort högst upp i stället för en heltäckande ruta: bilden av var man ska stå
 * och kamerabilden man ramar in i behövs samtidigt, och en guide som måste tryckas bort hade blivit
 * ett extra tryck per vinkel — sex stycken på ett flöde som finns för att vara enklare än att filma.
 *
 * Stegraden är både kvitto och karta. Miniatyren visar vad som redan är taget, och att den går att
 * trycka på är hela svaret på "den där blev suddig": vinklarna är namngivna platser, så att gå
 * tillbaka till en av dem är en självklar rörelse och inte en ångerknapp.
 */
export default function PhotoGuide({
  stations,
  activeId,
  taken,
  onJump,
}: {
  stations: PhotoStation[];
  activeId: string;
  /** dataUrl per stations-id: vad säljaren redan har tagit. */
  taken: Record<string, string>;
  onJump: (id: string) => void;
}) {
  const t = useT();
  const index = stations.findIndex((s) => s.id === activeId);
  const station = stations[index];
  if (!station) return null;

  return (
    <div className="photo-guide">
      <div className="photo-guide-card">
        <GuideScene className="guide3d photo-guide-scene" at={station.at} />
        <div className="photo-guide-text">
          <span className="photo-guide-step">
            {t("Bild {nr} av {antal}", { nr: index + 1, antal: stations.length })}
            {station.required ? "" : ` · ${t("frivillig")}`}
          </span>
          <h2 className="photo-guide-title">{t(station.title)}</h2>
          <p className="photo-guide-instruction">{t(station.instruction)}</p>
        </div>
      </div>

      <ol className="photo-guide-strip">
        {stations.map((s, i) => {
          const thumb = taken[s.id];
          const state = s.id === activeId ? "active" : thumb ? "done" : "todo";
          return (
            <li key={s.id}>
              <button
                className={`photo-guide-stop photo-guide-stop-${state}`}
                onClick={() => onJump(s.id)}
                aria-current={s.id === activeId ? "step" : undefined}
              >
                <span className="photo-guide-stop-frame">
                  {thumb ? <img src={thumb} alt="" /> : <span className="photo-guide-stop-index">{i + 1}</span>}
                  {thumb && (
                    <span className="photo-guide-stop-check">
                      <CheckIcon size={11} />
                    </span>
                  )}
                </span>
                <span className="photo-guide-stop-label">{t(s.label)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
