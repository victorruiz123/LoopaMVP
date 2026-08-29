import { useEffect } from "react";

/**
 * Fliken ska säga var man är.
 *
 * Appen har ingen router — skärmen är ett fält i en useState — så titeln kan inte följa av adressen.
 * Den sätts därför av skärmen själv. Utan det här stod "Loopa – Skickbedömning" kvar hela vägen från
 * inloggningen till truth-cardet, vilket gör flikraden oläslig så fort man har appen öppen bredvid
 * Tradera-annonsen den handlar om.
 */
const SUFFIX = "Loopa";

export function usePageTitle(title: string | null) {
  useEffect(() => {
    document.title = title ? `${title} – ${SUFFIX}` : `${SUFFIX} – Skickbedömning`;
  }, [title]);
}
