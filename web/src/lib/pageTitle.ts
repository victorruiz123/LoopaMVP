import { useEffect } from "react";
import { t, useLang } from "./i18n";

/**
 * Fliken ska säga var man är.
 *
 * Appen har ingen router — skärmen är ett fält i en useState — så titeln kan inte följa av adressen.
 * Den sätts därför av skärmen själv. Utan det här stod samma titel kvar hela vägen från inloggningen
 * till annonsen, vilket gör flikraden oläslig så fort man har appen öppen bredvid annonsen den
 * handlar om.
 */
const SUFFIX = "Loopa";

/**
 * Titeln översätts HÄR och inte hos den som sätter den.
 *
 * Skärmarna skickar in sin svenska rubrik — "Annons", "Din profil" — och slipper veta att appen
 * talar tre språk. Språket står i beroendelistan: byter man språk med fliken öppen ska namnet i
 * flikraden byta med resten av skärmen.
 */
/**
 * `null` sätter appens standardtitel. `undefined` rör inte titeln alls.
 *
 * Skillnaden finns för skärmar som ritas INUTI en annan sida — inloggningen i kassans ark, till
 * exempel. Den är en egen skärm överallt annars och sätter därför sin titel, men i arket hade den
 * bytt namn på produktsidan bakom sig och lämnat kvar "Logga in" i flikraden när arket stängdes.
 */
export function usePageTitle(title: string | null | undefined) {
  const { lang } = useLang();
  useEffect(() => {
    if (title === undefined) return;
    document.title = title ? `${t(title)} – ${SUFFIX}` : `${SUFFIX} – ${t("Sälj din möbel")}`;
  }, [title, lang]);
}
