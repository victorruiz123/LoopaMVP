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
 * klart. Överlägget erbjuder ingen annan väg: varvet är det enda underlaget den här vyn samlar in,
 * och väggfallet — som var skälet att stå med en dörr härifrån — besvaras av noten nedan i stället.
 * Fotoguiden nås från datorns valskärm.
 */
export default function WalkaroundGuide({ subject }: { subject?: string }) {
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
        {/*
          VÄGGFALLET, sagt före filmningen och inte efteråt.

          En soffa står oftast mot en vägg, och då finns det inget helt varv att gå. Stoppknappen har
          alltid kunnat avsluta filmen när som helst, men ingenting sa det: guiden lovar ett helt varv
          och att filmen stannar av sig själv, så den som kommer halvvägs tror att hen gjort fel och
          går tillbaka till början.

          Det som INTE filmas blir inte tyst borta: besiktningen skriver själv vilken sida den aldrig
          fick se, och den raden står i annonsen. Det är därför uppmaningen kan vara så här lugn.
        */}
        <p className="capture-guide-note">
          {t("Står möbeln mot en vägg? Filma de sidor du kommer åt och tryck på stoppknappen när du är klar — vi bedömer det du filmat och skriver i annonsen vad som inte syns.")}
        </p>
      </div>
    </div>
  );
}
