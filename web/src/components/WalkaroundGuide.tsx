import { useT } from "../lib/i18n";
import GuideScene from "./GuideScene";

/**
 * Varvet, visat som det ser ut när man går det.
 *
 * Guiden var först en cirkel ovanifrån, och en karta är fel bild för det här: säljaren står ju inte
 * ovanför soffan, hen står bredvid den. Scenen ritas därför i samma perspektiv som säljaren själv har
 * — soffan på snedden, en aning underifrån ögonhöjd — med telefonen på en verklig bana runt den.
 * Scenen och matematiken bakom den ligger i GuideScene, som fotoguiden ritar samma möbel ur.
 *
 * Härifrån och ut är det bara ord: vad varvet är, hur länge det tar och vad som händer när det är
 * klart. `onSwitch` är dörren till fotoguiden — samma varv, men stannat på fyra ställen — och den
 * står här, ovanpå kameran, för att det är HÄR säljaren står när hen inser att ett varv inte går att
 * gå: soffan står mot en vägg, eller händerna är fulla.
 */
export default function WalkaroundGuide({ subject, onSwitch }: { subject?: string; onSwitch?: () => void }) {
  const t = useT();
  return (
    <div className="capture-guide">
      <div className="capture-guide-inner">
        {subject && <span className="capture-guide-subject">{subject}</span>}
        <h2 className="capture-guide-title">{t("Gå ett varv runt möbeln")}</h2>

        <GuideScene lap />

        <ol className="capture-guide-steps">
          <li>{t("Håll telefonen i brösthöjd med hela möbeln i bild")}</li>
          <li>{t("Gå långsamt ett helt varv — ungefär 40 sekunder")}</li>
          <li>{t("Filmen stannar själv när du är tillbaka där du började")}</li>
        </ol>
        <p className="capture-guide-cta">{t("Tryck på den röda knappen för att börja")}</p>
        {onSwitch && (
          <button className="btn btn-text capture-guide-switch" onClick={onSwitch}>
            {t("Går inte att gå runt? Ta bilder i stället")}
          </button>
        )}
      </div>
    </div>
  );
}
