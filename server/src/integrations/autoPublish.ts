/**
 * "Publicera annonsen" = lägg upp den på alla kanaler som kan ta emot den.
 *
 * SAMMA ANNONS PÅ BÅDA STÄLLENA: samma rubrik, samma bilder, samma skickrapport, samma pris (möbeln
 * plus 600 kr hemleverans) och samma leveranslöfte. Loopa är säljare i båda fallen. En köpare som
 * ser samma möbel på två marknadsplatser till två priser litar inte på någotdera.
 *
 * VÄGEN DIT är däremot inte densamma, och det är hela skälet att den här filen finns:
 *
 *   Tradera  — ett API som svarar på 10–60 sekunder, och en annons som går att ta ner med ett anrop.
 *   Blocket  — ingen skriv-API alls. En robot klickar i Blockets eget formulär, det tar minuter, det
 *              kan behöva BankID, och annonsen går inte att ta ner automatiskt efteråt.
 *
 * ORDNINGEN ÄR TRADERA FÖRST. Den är snabb och svarar vad som hände; Blocket kan hänga i tre minuter
 * på en människa med en telefon. Vore det tvärtom skulle en BankID-väntan fördröja den kanal som
 * annars varit klar för länge sedan.
 *
 * EN KANAL SOM INTE ÄR KONFIGURERAD HOPPAS ÖVER — den fäller inte de andra. Det är inte en artighet
 * utan dagens verklighet: Tradera-nycklarna saknas på den här servern, och en publicering som vägrade
 * hela vägen för det hade betytt att ingenting alls gick att lägga upp.
 */

import type { ConditionJob } from "../types.js";
import { markTraderaPublishing, planTraderaPublish, runTraderaPublish } from "./tradera/publish.js";
import { missingTraderaEnv, TRADERA_PUBLISHING_ENABLED, traderaPublishingEnabled } from "./tradera/tradera.js";
import { markBlocketPublishing, planBlocketPublish, runBlocketPublish } from "./blocket/publish.js";
import { blocketConfigured, blocketLivePublishing, missingBlocketEnv } from "./blocket/blocket.js";

export type Channel = "tradera" | "blocket";

export interface ChannelPlan {
  channel: Channel;
  /** Integrationen är påkopplad på servern (nycklar respektive session + postnummer). */
  configured: boolean;
  missingEnv: string[];
  /** Annonsen går att publicera på kanalen just nu. */
  ready: boolean;
  /** Varför inte, när `ready` är falskt. Kanalens egen formulering, ordagrant. */
  reason: string | null;
  /** Redan uppe, eller ett försök som pågår — kanalen hoppas då över. */
  alreadyRunning: boolean;
  /**
   * Bara Blocket: körningen stannar före sista knappen. Ingen annons blir publik.
   *
   * Står här och inte bara i Blocket-planen, för det är det viktigaste en människa behöver veta innan
   * de trycker: "publicera" betyder olika saker på de två kanalerna tills BLOCKET_PUBLICERA=1 är satt.
   */
  dryRun: boolean;
}

export interface AutoPublishPlan {
  channels: ChannelPlan[];
  /** Kanalerna som faktiskt kommer att köras. Tom lista = ingenting att göra. */
  willPublish: Channel[];
}

/** Vad ett tryck på "publicera" skulle göra, kanal för kanal. */
export async function planAutoPublish(job: ConditionJob): Promise<AutoPublishPlan> {
  const traderaReadiness = await planTraderaPublish(job);
  const blocketReadiness = await planBlocketPublish(job);

  const channels: ChannelPlan[] = [
    {
      channel: "tradera",
      // Avstängd = inte konfigurerad, med tom saknar-lista. Panelen skriver då "avstängd".
      configured: traderaPublishingEnabled(),
      missingEnv: TRADERA_PUBLISHING_ENABLED ? missingTraderaEnv() : [],
      ready: traderaReadiness.ok,
      reason: traderaReadiness.ok ? null : traderaReadiness.reason,
      alreadyRunning: job.tradera?.status === "publishing" || job.tradera?.status === "published",
      dryRun: false,
    },
    {
      channel: "blocket",
      configured: blocketConfigured(),
      missingEnv: missingBlocketEnv(),
      ready: blocketReadiness.ok,
      reason: blocketReadiness.ok ? null : blocketReadiness.reason,
      // En torrkörning som redan gjorts är inget hinder: den lade inte upp något, och nästa körning
      // ska kunna göra det på riktigt. Bara "publicerar" och "publicerad" stänger kanalen.
      alreadyRunning: job.blocket?.status === "publishing" || job.blocket?.status === "published",
      dryRun: !blocketLivePublishing(),
    },
  ];

  return {
    channels,
    willPublish: channels.filter((c) => c.configured && c.ready && !c.alreadyRunning).map((c) => c.channel),
  };
}

/**
 * Kanalernas läge i klartext, en rad per kanal — det admin behöver för att laga något.
 *
 * Aldrig en sammanslagen mening: "det gick inte" hjälper ingen när Tradera är avstängt OCH Blocket
 * saknar session, eller när den ena bara ligger uppe redan. Samma rader används i två svar —
 * godkännandets "ingen kanal kan ta emot annonsen" och beställningens "ingen kanal är konfigurerad" —
 * och två formuleringar av samma lista hade glidit isär.
 */
export function beskrivKanaler(channels: ChannelPlan[]): string {
  const namn: Record<Channel, string> = { tradera: "Tradera", blocket: "Blocket" };
  return channels
    .map((c) => {
      if (c.alreadyRunning) return `${namn[c.channel]}: ligger redan uppe eller håller på att läggas ut.`;
      if (!c.configured) {
        // Tom saknar-lista = avstängd i koden, inte oinstallerad. Panelen skriver samma sak.
        return c.missingEnv.length
          ? `${namn[c.channel]}: inte konfigurerat på servern (saknar ${c.missingEnv.join(", ")}).`
          : `${namn[c.channel]}: avstängt på servern.`;
      }
      return `${namn[c.channel]}: ${c.reason ?? "går inte att publicera."}`;
    })
    .join(" ");
}

export type BestallningsGrind = { ok: true; plan: AutoPublishPlan } | { ok: false; reason: string; plan: AutoPublishPlan };

/**
 * Kan en beställning tas emot alls?
 *
 * Säljarens "Sälj med Loopa" grindades förut på Traderas spärr, och när den slogs av (13 september)
 * svarade rutten 503 för ALLA kanaler, fast Blocket stod redo — knappen försvann, ingen beställning
 * skrevs, och godkännandet hade ingenting att godkänna. Beställningen är inte en publicering på en
 * viss kanal; den kräver bara att NÅGON kanal är konfigurerad. Vilka som sedan kör avgörs vid
 * godkännandet, med samma plan.
 *
 * Kanalens egen beredskap (postnummer, bilder) grindar INTE här. Den går att laga i panelen efteråt,
 * och en beställning som avvisas för något admin kan rätta är en förlorad säljare.
 */
export async function bestallningsGrind(job: ConditionJob): Promise<BestallningsGrind> {
  const plan = await planAutoPublish(job);
  if (plan.channels.some((c) => c.configured)) return { ok: true, plan };
  return { ok: false, reason: `Ingen kanal är konfigurerad på servern. ${beskrivKanaler(plan.channels)}`, plan };
}

/**
 * Kör publiceringen på varje kanal som kan ta emot annonsen.
 *
 * Fire-and-forget, som Tradera-vägen alltid varit: anropas med `void` från rutten och skriver sitt
 * resultat i jobbet. Kanalerna körs EFTER VARANDRA och inte parallellt — en Playwright-instans och ett
 * API-anrop samtidigt gör bara felsökningen svårare, och Blocket-körningen behöver ändå hela
 * uppmärksamheten när BankID kommer upp.
 *
 * Ett fel i den ena kanalen stoppar inte den andra. Halv framgång är ett riktigt utfall här — annonsen
 * kan mycket väl ligga uppe på Tradera medan Blocket-roboten gick i väggen — och den syns som just
 * det: två statusar på jobbet, inte ett gemensamt "misslyckades".
 */
export async function runAutoPublish(jobId: string, channels: Channel[]): Promise<void> {
  for (const channel of channels) {
    try {
      if (channel === "tradera") await runTraderaPublish(jobId);
      else await runBlocketPublish(jobId);
    } catch (err) {
      // Båda körningarna fångar sina egna fel och skriver dem i jobbet. Kommer något ändå hit är det
      // oväntat, och det får inte hindra nästa kanal.
      console.warn(`[autopublish] ${channel} för job ${jobId} kastade oväntat — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Markerar de kanaler som ska köras som "publicerar", så knappen kan låsas direkt.
 *
 * `adminId` följer med till Tradera-sidan därför att godkännandestämpeln bor där (approvedAt/
 * approvedBy), och det är den butiken läser för att veta att möbeln FÅR ligga i rutnätet. Kör inte
 * Tradera i det här trycket sätts stämpeln ändå — se `markApproved`, som godkännandet kallar först.
 */
export async function markChannelsPublishing(
  job: ConditionJob,
  channels: Channel[],
  adminId: string | null = null,
): Promise<void> {
  for (const channel of channels) {
    if (channel === "tradera") await markTraderaPublishing(job, adminId);
    else await markBlocketPublishing(job);
  }
}
