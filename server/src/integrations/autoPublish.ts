/**
 * "Publicera annonsen" = lägg upp den på alla kanaler som kan ta emot den.
 *
 * En knapp, två kanaler, och det är AVSIKTLIGT ojämnt: kanalerna är inte varandras kopior.
 *
 *   Tradera  — Loopa är säljare. Priset är möbeln PLUS 600 kr hemleverans, och annonstexten lovar
 *              den leveransen. Läggs upp genom ett API som svarar på 10–60 sekunder.
 *   Blocket  — säljaren är säljare. Priset är BARA möbeln, och texten lovar ingen leverans. Läggs upp
 *              av en robot som klickar i Blockets formulär, tar minuter, och kan behöva BankID.
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
import { missingTraderaEnv, traderaConfigured } from "./tradera/tradera.js";
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
      configured: traderaConfigured(),
      missingEnv: missingTraderaEnv(),
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
