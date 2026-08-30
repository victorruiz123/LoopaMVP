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
export function usePageTitle(title: string | null) {
  const { lang } = useLang();
  useEffect(() => {
    document.title = title ? `${t(title)} – ${SUFFIX}` : `${SUFFIX} – ${t("Sälj din möbel")}`;
  }, [title, lang]);
}
