/**
 * BILDTESTET (TILLFÄLLIGT, 2026-11-25): kan Googles AI-läge bifoga exempelbilder per modell via SerpApi?
 *
 * På BARA med LOOPA_AIMODE_BILDTEST=1. Då:
 *   - identifieringsfrågan är appens vanliga (oförändrad) följd av BILDTEST_TILLAGG;
 *   - inga uppföljningsfrågor, bildsökningar eller måttfrågor går iväg, så en uppladdning kostar EN SerpApi-sökning;
 *   - granskningspanelen (?serpapi=1) visar bilderna som följde med svaret och vilket fält de kom ur.
 * Utan flaggan ändras ingenting. Ta bort filen och dess anrop i aimode.ts, session.ts och web/src/lib/serpApiBridge.ts när testet är klart.
 */

export const bildtestPa = (): boolean => process.env.LOOPA_AIMODE_BILDTEST === "1";

export const BILDTEST_TILLAGG =
  "Visa dessutom en exempelbild från internet för varje förslag, direkt under modellens namn. Bilden ska visa hela möbeln av just den modellen, " +
  "helst en produktbild mot vit bakgrund från tillverkarens eller en återförsäljares produktsida, i den variant som mest liknar möbeln på bilden " +
  "jag skickade (klädsel, färg och underrede). Visa inte bilden jag skickade, och använd en bild ur en begagnatannons bara om ingen annan finns. " +
  "Skriv adressen till sidan som exempelbilden kommer från. Hittar du ingen bild som säkert visar rätt modell, skriv det hellre än att visa en annan möbel.";

export interface SvarsBild {
  url: string;
  /** Fältet i SerpApis svar som bilden låg i ("references.thumbnail", "inline_images", …). */
  falt: string;
  /** Rubriken (modellen) bilden går att knyta till, när svaret säger det. */
  modell: string | null;
  titel: string | null;
  /** Sidan bilden kommer från, när svaret anger den. */
  kalla: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const BILDNYCKEL = /(thumbnail|image|photo|^original$|^img$|^src$)/i;
const EJ_BILD = /(icon|favicon|logo)/i;
const arBildadress = (v: unknown): v is string => typeof v === "string" && (/^https?:\/\//i.test(v) || /^data:image\//i.test(v)) && v.length < 300_000;

/** Alla bilder i ett AI-lägessvar, var de än ligger. Ren funktion. */
export function bilderISvaret(resp: Obj): SvarsBild[] {
  const ut: SvarsBild[] = [];
  const sedda = new Set<string>();
  const lagg = (b: SvarsBild) => {
    const k = `${b.falt}|${b.modell}|${b.url}`;
    if (!sedda.has(k) && ut.length < 80) {
      sedda.add(k);
      ut.push(b);
    }
  };
  const kallnrTillModell = new Map<number, Set<string>>();

  const ga = (v: unknown, vag: string, modell: string | null, titel: string | null, kalla: string | null): void => {
    if (Array.isArray(v)) {
      let rubrik = modell;
      for (const x of v) {
        if (isObj(x) && x.type === "heading") rubrik = str(x.snippet) ?? rubrik;
        ga(x, `${vag}[]`, rubrik, titel, kalla);
      }
      return;
    }
    if (arBildadress(v)) {
      const nyckel = vag.replace(/\[\]/g, "");
      const sista = nyckel.split(".").pop() ?? "";
      if (BILDNYCKEL.test(sista) && !EJ_BILD.test(nyckel)) lagg({ url: v, falt: nyckel, modell, titel, kalla });
      return;
    }
    if (!isObj(v)) return;
    // En listpunkt med underpunkter ("1. Hjort Knudsen Genova" → säkerhet, status …) är modellens rubrik.
    const egenRubrik = Array.isArray(v.list) && str(v.snippet) ? str(v.snippet) : modell;
    for (const n of arr(v.reference_indexes)) {
      if (typeof n === "number" && egenRubrik) (kallnrTillModell.get(n) ?? kallnrTillModell.set(n, new Set()).get(n)!).add(egenRubrik);
    }
    const t = str(v.title) ?? str(v.alt) ?? titel;
    const l = str(v.link) ?? str(v.product_link) ?? str(v.source_link) ?? kalla;
    for (const [k, x] of Object.entries(v)) ga(x, vag ? `${vag}.${k}` : k, egenRubrik, t, l);
  };

  ga(resp.text_blocks, "text_blocks", null, null, null);

  for (const [i, r] of arr(resp.references).entries()) {
    if (isObj(r) && arBildadress(r.thumbnail)) {
      const nr = typeof r.index === "number" ? r.index : i;
      lagg({ url: r.thumbnail, falt: "references.thumbnail", modell: [...(kallnrTillModell.get(nr) ?? [])].join(" / ") || null, titel: str(r.title), kalla: str(r.link) });
    }
  }
  // Allt övrigt (inline_images, shopping_results och fält vi inte känner till).
  for (const [k, v] of Object.entries(resp)) {
    if (["text_blocks", "references", "search_metadata", "search_parameters", "reconstructed_markdown", "subsequent_request_token"].includes(k)) continue;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      for (const x of v) if (arBildadress(x) && BILDNYCKEL.test(k)) lagg({ url: x, falt: k, modell: null, titel: null, kalla: null });
      continue;
    }
    ga(v, k, null, null, null);
  }
  const md = str(resp.reconstructed_markdown) ?? "";
  for (const m of md.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/g)) {
    lagg({ url: m[2], falt: "markdown", modell: null, titel: m[1] || null, kalla: null });
  }
  return ut;
}
