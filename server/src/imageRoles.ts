/**
 * Vilka bilder som duger för att KÄNNA IGEN en möbel, till skillnad från att bedöma dess skick.
 *
 * Identifieringen och produktforskningen tar några få bilder ur jobbets lista (listing.ts
 * `identifieringsBilder`, research/pipeline.ts `pickResearchFrames`) och sprider dem över listan, på
 * antagandet att listan är ett varv: första och sista bilden är då två olika håll.
 *
 * Med fotoguiden stämmer det inte längre. Listan är omslag, framifrån, vänster, baksida, höger,
 * ovanifrån, närbild, extra bilder — och en spridning över den hamnar lätt på en närbild av en repa
 * eller en bild rakt ner i sitsen. Båda är bra för BESIKTNINGEN och värdelösa för att avgöra vilken
 * modell det är: det som skiljer en modell från en annan är formen, och den syns på bilder av hela
 * möbeln.
 *
 * Reglerna går på etiketterna fotoguiden sätter (web/src/lib/photoStations.ts). Etiketten är
 * säljarens vägledning och inte ett faktum — men här är en felmärkt bild ingen olycka: urvalet byter
 * bara vilka tre bilder som skickas, och en bild utan etikett (alla jobb före fotoguiden) räknas alltid med.
 */

import type { CapturedImage } from "./types.js";

/** Närbilder och extra bilder: detaljer på ytan, utan möbelns form. */
const DETAIL_LABELS = ["närbild", "extra bild"];

/** Bilder rakt ner i sits eller skiva: bra för nedsuttet tyg, men visar inte möbelns siluett. */
const NOT_FOR_IDENTIFICATION_LABELS = [...DETAIL_LABELS, "ovanifrån"];

function startsWithAny(label: string | null, prefixes: string[]): boolean {
  const l = (label ?? "").trim().toLowerCase();
  return l !== "" && prefixes.some((p) => l.startsWith(p));
}

/** En närbild eller extra bild — alltså något säljaren tog för att visa en detalj. */
export function isDetailShot(img: Pick<CapturedImage, "viewLabel">): boolean {
  return startsWithAny(img.viewLabel, DETAIL_LABELS);
}

/**
 * Bilderna som visar HELA möbeln, att välja bland för identifiering. Omslaget räknas alltid med.
 *
 * Blir ingenting kvar — alla bilder är detaljer — returneras hela listan: ett urval av närbilder
 * är bättre än inget urval, och identifieringen ska inte svara "inga bilder" på ett jobb som har några.
 */
export function forIdentification<T extends Pick<CapturedImage, "viewLabel" | "role">>(images: T[]): T[] {
  const kept = images.filter((i) => i.role === "cover" || !startsWithAny(i.viewLabel, NOT_FOR_IDENTIFICATION_LABELS));
  return kept.length > 0 ? kept : images;
}
