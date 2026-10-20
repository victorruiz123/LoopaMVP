/**
 * Veckans omläggning: annonsen TAS NER och LÄGGS UPP PÅ NYTT med stegens pris, i stället för att
 * priset ändras på den annons som redan ligger ute.
 *
 * Beslutet om NÄR det görs, och bokföringen av hur det gick, ligger i priceLadder.ts (`synkaKanaler`).
 * Här ligger bara det som rör omvärlden, så att det kan bytas mot attrapper i testerna:
 *
 *   Tradera  — `taNerTraderaAnnons` (DELETE via API:t), sedan `runTraderaPublish`: samma väg som en
 *              vanlig publicering, och annonspriset läses ur stegen (adContent.ts `resolveAdPrice`).
 *   Blocket  — `taNerBlocketAnnons` (blocket/borttagning.ts: Mina annonser → kortets meny → Ta bort),
 *              sedan `runBlocketPublish`, samma uppladdning som första gången men med stegens pris.
 *
 * BRYTAREN: PRIS_OMLAGGNING, en lista med kanaler. Osatt = "tradera,blocket", "0" = av överallt (då
 * ändras priset på plats som förut). Blocket läggs dessutom bara om när `blocketOmlaggningKlar()` säger
 * ja (BLOCKET_TA_BORT_ROBOT=1 och BLOCKET_PUBLICERA=1); annars ändras Blocket-priset på plats av
 * prisroboten.
 *
 * Kanalens egen publicering skriver över `job.tradera` / `job.blocket` helt. Hemleveransen annonsen gick
 * ut med förs därför över för hand, så att annonspriset inte byter fraktbelopp vid omläggningen.
 */

import { getJob } from "../jobStore.js";
import { loopaIdFor } from "../loopaId.js";
import type { ConditionJob } from "../types.js";
import type { PrisKanal } from "../priceLadder.js";

export type PubliceringsUtfall = { status: "uppe" } | { status: "fel"; fel: string } | { status: "senare"; skal: string };

export function omlaggningPa(kanal: PrisKanal): boolean {
  const v = process.env.PRIS_OMLAGGNING?.trim();
  const lista = !v ? ["tradera", "blocket"] : v === "0" ? [] : v.split(",").map((s) => s.trim().toLowerCase());
  return lista.includes(kanal);
}

/** Kan kanalen läggas om på den här servern just nu? Nej = priset ändras på plats i stället. */
export async function kanOmlaggas(kanal: PrisKanal): Promise<boolean> {
  if (!omlaggningPa(kanal)) return false;
  if (kanal === "tradera") return (await import("./tradera/tradera.js")).traderaConfigured();
  return (await import("./blocket/borttagning.js")).blocketOmlaggningKlar();
}

/**
 * Tar ner annonsen och markerar kanalen som "publicerar". Kastar när den inte togs ner — då ligger den
 * gamla annonsen kvar, och ingen ny läggs upp.
 */
/**
 * Förberedda Blocket-annonser: paketsidan där sista knappen väntar, per jobb. I minnet med flit — efter
 * en omstart är adressen inte längre säker att lita på, och publiceringen gör då hela vägen om.
 */
const forberedda = new Map<string, string>();

export type NedtagningsUtfall = void | { status: "senare"; skal: string } | { status: "manuell"; skal: string };

export async function taNerForOmlaggning(job: ConditionJob, kanal: PrisKanal): Promise<NedtagningsUtfall> {
  if (kanal === "tradera") {
    const { taNerTraderaAnnons } = await import("./tradera/nedtagning.js");
    const { markTraderaPublishing } = await import("./tradera/publish.js");
    const frakt = job.tradera?.shippingSek ?? null;
    await taNerTraderaAnnons(job, loopaIdFor(job.id), "veckans omläggning");
    await markTraderaPublishing(job);
    job.tradera!.shippingSek = frakt;
    return;
  }
  const { taNerBlocketAnnons } = await import("./blocket/borttagning.js");
  const { forberedBlocketPublicering, markBlocketPublishing } = await import("./blocket/publish.js");
  const { arUpptagen } = await import("./blocket/vakt.js");
  if (arUpptagen()) return { status: "senare", skal: "En annan Blocket-körning pågår." };

  /**
   * FÖRBERED FÖRST. Den nya annonsen fylls i hela vägen till sista knappen medan den gamla ligger uppe.
   * Skarpt 2026-10-20 krävde Blocket BankID först vid Fortsätt — efter att den gamla tagits ner. Här
   * upptäcks det innan något tas ner: annonsen står kvar på det gamla priset, admin får ett brev.
   */
  let paketUrl: string;
  try {
    paketUrl = (await forberedBlocketPublicering(job.id)).paketUrl;
  } catch (err) {
    const fel = err instanceof Error ? err.message : String(err);
    if (/bankid|legitimer/i.test(fel)) {
      return {
        status: "manuell",
        skal:
          "Blocket kräver BankID för att lägga upp den nya annonsen. Den gamla ligger kvar på det gamla priset. " +
          "Logga in på Blocket med BankID (npm run blocket:logga-in) — nästa varv lägger om den.",
      };
    }
    throw new Error(`Den nya annonsen gick inte att förbereda, så den gamla togs inte ner: ${fel}`);
  }

  const frakt = job.blocket?.shippingSek ?? null;
  const utfall = await taNerBlocketAnnons(job);
  if (utfall.status === "senare") return utfall;
  forberedda.set(job.id, paketUrl);
  await markBlocketPublishing(job);
  job.blocket!.shippingSek = frakt;
}

/** Publicerar annonsen igen, efter en nedtagning. Kastar aldrig: ett fel är ett utfall. */
export async function publiceraEfterOmlaggning(job: ConditionJob, kanal: PrisKanal): Promise<PubliceringsUtfall> {
  try {
    if (kanal === "tradera") {
      const { markTraderaPublishing, runTraderaPublish } = await import("./tradera/publish.js");
      if (job.tradera?.status !== "publishing") {
        const frakt = job.tradera?.shippingSek ?? null;
        await markTraderaPublishing(job);
        job.tradera!.shippingSek = frakt;
      }
      await runTraderaPublish(job.id);
      const t = (await getJob(job.id))?.tradera;
      return t?.status === "published" ? { status: "uppe" } : { status: "fel", fel: t?.error ?? "okänt fel" };
    }

    const { arUpptagen } = await import("./blocket/vakt.js");
    if (arUpptagen()) return { status: "senare", skal: "En annan Blocket-körning pågår." };
    const { blocketLivePublishing } = await import("./blocket/blocket.js");
    // Aldrig en torrkörning efter en nedtagning: den hade sett ut som ett lyckat försök utan att
    // någon annons kom upp.
    if (!blocketLivePublishing()) return { status: "fel", fel: "Blocket-publiceringen torrkör (BLOCKET_PUBLICERA är inte 1)." };
    const { markBlocketPublishing, runBlocketPublish, slutforBlocketPublicering } = await import("./blocket/publish.js");
    if (job.blocket?.status !== "publishing") {
      const frakt = job.blocket?.shippingSek ?? null;
      await markBlocketPublishing(job);
      job.blocket!.shippingSek = frakt;
    }
    // Den förberedda annonsen: bara sista knappen kvar. Går det inte (eller efter en omstart) görs hela
    // publiceringen om vid nästa försök.
    const paketUrl = forberedda.get(job.id);
    forberedda.delete(job.id);
    if (paketUrl) await slutforBlocketPublicering(job.id, paketUrl);
    else await runBlocketPublish(job.id);
    const b = (await getJob(job.id))?.blocket;
    return b?.status === "published" ? { status: "uppe" } : { status: "fel", fel: b?.error ?? `slutade som "${b?.status ?? "okänt"}"` };
  } catch (err) {
    return { status: "fel", fel: err instanceof Error ? err.message : String(err) };
  }
}

/** Brevet till admin: annonsen är NERE och kom inte upp igen. Ett per nedtagning. */
export async function mejlaOmNere(job: ConditionJob, kanal: PrisKanal, fel: string, tidigareUrl: string | null): Promise<void> {
  const { sendLetter } = await import("../efterlysning/notify.js");
  const { adminEmails } = await import("../admin.js");
  const { adTitle } = await import("../adContent.js");
  const namn = kanal === "tradera" ? "Tradera" : "Blocket";
  const id = loopaIdFor(job.id);
  const titel = adTitle(job) || id;
  const body = [
    `${namn}-annonsen för "${titel}" (${id}) togs ner för veckans omläggning, men kunde inte läggas upp igen:`,
    fel,
    "",
    tidigareUrl ? `Den gamla annonsen: ${tidigareUrl}` : "",
    "",
    "Möbeln ligger INTE ute på " + namn + " just nu. Servern försöker igen om 20 minuter och sedan var sjätte timme.",
    `Vill du inte vänta: publicera den igen från adminpanelen.`,
  ].join("\n");
  for (const to of adminEmails()) {
    await sendLetter({ to, subject: `${namn}: ${titel} är nere — omläggningen gick inte igenom`, body, kind: "pris" });
  }
}
