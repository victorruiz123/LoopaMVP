/**
 * Säljarens skanning: förifyllningen in, det verifierade kortet ut.
 *
 * ÅTERANVÄNDER SÄLJVERKTYGETS PIPELINE RAKT AV. Samma filmning, samma besiktning, samma betyg — det
 * är hela poängen. En egen "affärsbesiktning" hade blivit ett andra sätt att bedöma en möbel, och
 * två sätt betyder att de en dag säger olika saker om samma soffa.
 *
 * DET ENDA SOM SKILJER är att jobbet bär affärens id (ConditionJob.dealId), vilket håller det
 * utanför Butik och utanför det publika kortet. Se tests/affar-privacy.test.ts.
 */

import { getJob } from "../jobStore.js";
import { move, store } from "./store.js";
import type { Deal } from "./types.js";

/**
 * Förifyllningen säljaren får.
 *
 * VAD SOM FÖLJER MED: identifieringen. Märke, modell, möbeltyp, det begärda priset och ett utkast
 * till beskrivning. Det sparar säljaren från att skriva in vad de redan skrivit i sin egen annons.
 *
 * VAD SOM INTE FÖLJER MED, och det är den viktiga halvan: vår gissning om SKICKET. Inga
 * iakttagelser, inget uppskattat betyg, inga varningsflaggor, inget marknadsspann. Säljaren ska
 * filma sin möbel utan att först ha läst vad vi trodde om den — och köparens prisunderlag är
 * köparens, inte något säljaren ska förhandla emot.
 *
 * Efter skanningen har båda parter samma verifierade kort. Då är den asymmetrin över.
 */
export interface ScanPrefill {
  brand: string | null;
  model: string | null;
  categoryNoun: string | null;
  askingPriceSek: number | null;
  /** Säljarens egen annonstext, maskad. Ett utkast att redigera, inte något vi hittat på. */
  descriptionDraft: string | null;
}

export function prefillFor(deal: Deal): ScanPrefill {
  return {
    brand: deal.assessment?.brand ?? null,
    model: deal.assessment?.model ?? null,
    categoryNoun: deal.assessment?.categoryNoun ?? null,
    askingPriceSek: deal.submission?.askingPriceSek ?? null,
    descriptionDraft: deal.submission?.description ?? null,
  };
}

/**
 * Säljaren går med i affären.
 *
 * ATT ÖPPNA LÄNKEN RÄCKER INTE — det är därför den här funktionen kräver ett konto och `invited`
 * inte flyttas av en sidladdning. Konverteringen inbjudan → säljaren med är produktens viktigaste
 * mått, och den mäter ingenting om den räknar den som bara tittade.
 *
 * Köparen kan inte gå med som säljare i sin egen affär. Det låter som en självklarhet ända tills
 * någon testar det, och då är affären i ett läge ingen tänkt på.
 */
export async function joinAsSeller(
  token: string,
  sellerId: string,
  sellerEmail: string | null,
): Promise<{ deal: Deal; prefill: ScanPrefill } | { error: string; status: number }> {
  const deal = await store().byToken(token);
  if (!deal) return { error: "Inbjudan finns inte, eller har gått ut.", status: 404 };
  if (deal.buyerId === sellerId) return { error: "Du kan inte sälja till dig själv.", status: 409 };

  // Redan med? Då är det här en omladdning, inte ett nytt medlemskap.
  if (deal.sellerId === sellerId) return { deal, prefill: prefillFor(deal) };
  if (deal.sellerId) return { error: "Någon annan har redan tagit den här affären.", status: 409 };

  const updated = await move(
    deal.id,
    ["invited", "created"],
    "seller_joined",
    { kind: "seller", userId: sellerId },
    "Säljaren skapade konto och gick med i affären.",
    { sellerId, sellerEmail },
  );
  if (!updated) return { error: "Affären går inte att gå med i längre.", status: 409 };
  return { deal: updated, prefill: prefillFor(updated) };
}

/**
 * Knyter en påbörjad skanning till affären.
 *
 * Anropas när jobbet SKAPAS, inte när det blir klart: skulle säljaren stänga appen mitt i vill vi
 * ändå veta vilket jobb som var affärens. Tillståndet flyttas däremot först när besiktningen är
 * färdig — se `syncScanState`, som är den som får säga att möbeln är granskad.
 */
export async function attachScan(dealId: string, jobId: string, sellerId: string): Promise<void> {
  const deal = await store().get(dealId);
  if (!deal || deal.sellerId !== sellerId) return;
  await store().put({ ...deal, scanJobId: jobId });
}

/**
 * Flyttar affären till `scanned` när besiktningen faktiskt är klar.
 *
 * Pollas av affärsrummet i stället för att pipelinen anropar hit. Riktningen är vald: pipelinen vet
 * ingenting om affärer och ska fortsätta göra det — den kör lika bra för en vanlig säljare, och en
 * krok därifrån hade gjort besiktningen beroende av en modul den inte behöver.
 *
 * Returnerar affären som den ser ut efter kontrollen, oförändrad när skanningen inte är klar.
 */
export async function syncScanState(deal: Deal): Promise<Deal> {
  if (deal.state !== "seller_joined" || !deal.scanJobId) return deal;
  const job = await getJob(deal.scanJobId);
  if (!job?.result?.grade) return deal;
  const updated = await move(
    deal.id,
    ["seller_joined"],
    "scanned",
    { kind: "system", job: "syncScanState" },
    "Besiktningen är klar. Möbeln är granskad.",
  );
  return updated ?? deal;
}

/**
 * Det verifierade kortet, som BÅDA parter ser det.
 *
 * Här upphör asymmetrin: efter skanningen har köparen och säljaren exakt samma underlag, och det är
 * det som prisförhandlingen i steg 4 förs på. Säljaren får redigera pris, beskrivning och
 * hämtningstider; betyg, fynd och mått står som pipelinen satte dem. Det senare är inte en
 * inskränkning utan produkten: ett kort där säljaren kan tona ned en skada är inget kort.
 */
export interface VerifiedCard {
  jobId: string;
  loopaId: string;
  brand: string | null;
  model: string | null;
  grade: string | null;
  gradeLabel: string | null;
  gradeRationale: string | null;
  /** Kvarstående fynd, som de står på kortet. Går inte att redigera. */
  defects: Array<{ id: string; part: string; description: string; severity: string }>;
  measurements: Array<{ label: string; value: string }>;
  /** Prismotorns förslag för det VERIFIERADE skicket. Underlaget för steg 4. */
  suggestedPriceSek: number | null;
  imageCount: number;
  reviewed: boolean;
  inspectedAt: string | null;
}

export async function verifiedCardFor(deal: Deal): Promise<VerifiedCard | null> {
  if (!deal.scanJobId) return null;
  const job = await getJob(deal.scanJobId);
  const result = job?.result;
  if (!result?.grade) return null;

  const listing = result.listing?.result ?? job?.listing?.result ?? null;
  const { damageStands } = await import("../pipeline/grade.js");
  const { loopaIdFor } = await import("../loopaId.js");

  return {
    jobId: job!.id,
    loopaId: loopaIdFor(job!.id),
    brand: listing?.identity?.brand ?? result.identity?.brand ?? null,
    model: listing?.identity?.exactProduct ?? result.identity?.model ?? null,
    grade: result.grade.grade,
    gradeLabel: result.grade.label,
    gradeRationale: result.grade.rationale,
    defects: result.damages
      .filter((d) => damageStands(d))
      .map((d) => ({ id: d.id, part: d.part, description: d.description, severity: d.severity })),
    measurements: (listing?.attributes ?? [])
      .filter((a) => /bredd|djup|h[öo]jd|l[äa]ngd|sitth/i.test(`${a.key} ${a.label}`))
      .map((a) => ({ label: a.label, value: a.value })),
    suggestedPriceSek: result.price?.status === "ok" ? result.price.default : null,
    imageCount: result.images.length,
    reviewed: result.reviewed,
    inspectedAt: result.createdAt,
  };
}
