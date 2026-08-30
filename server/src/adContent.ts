/**
 * Annonsen, oberoende av var den publiceras.
 *
 * Texten, priset och bildordningen bodde tidigare inne i Tradera-publiceringen, för att Tradera var
 * enda vägen ut. Nu finns två: knappen som lägger upp annonsen på Loopas Tradera-konto, och Blocket,
 * där säljaren för över den för hand. Båda ska säga SAMMA sak om möbeln — samma skador, samma mått,
 * samma skickord — och det håller bara om de bygger på en text och inte på två som liknar varandra
 * i dag.
 *
 * Därför byggs annonsen här som BLOCK, inte som färdig HTML: Tradera renderar HTML, Blockets
 * beskrivningsfält är ren text, och skillnaden mellan dem är ett renderingssteg och ingenting annat.
 * Vad som står, och i vilken ordning, avgörs på ett ställe.
 */

import path from "node:path";
import { damageStands } from "./pipeline/grade.js";
import { jobDir } from "./jobStore.js";
import { presentableImages } from "./pipeline/cover.js";
import { TYPE_LABELS } from "./damageLabels.js";
import { loopaIdFor } from "./loopaId.js";
import { SHIPPING_INCLUDED_SEK } from "./integrations/tradera/shipping.js";
import type { CapturedImage, ConditionJob, Damage, ListingAttribute, Severity } from "./types.js";

/**
 * En bit text i ett stycke. `strong` finns för att skicket och rubrikerna ska gå att se på Tradera,
 * som renderar HTML; i ren text försvinner markeringen och raden står kvar som den är.
 */
export interface AdRun {
  text: string;
  strong?: boolean;
}

export type AdBlock =
  | { kind: "paragraph"; runs: AdRun[] }
  | { kind: "list"; ordered: boolean; items: string[] };

/** Vad annonsen ska bära utöver möbeln själv. */
export interface AdOptions {
  /**
   * Om leveransstycket ska stå med.
   *
   * Sant bara för Tradera. Där är annonsen Loopas egen — den ligger på Loopas konto, och det är Loopa
   * som bokar budfirman efter köpet, så texten kan lova hemleverans. På Blocket är säljaren sin egen
   * avsändare och Loopa inte part i affären; ett löfte om hemleverans där vore något säljaren fick
   * hålla själv utan att ha lovat det. Hellre inget stycke än ett stycke de måste redigera bort.
   */
  delivery: boolean;
}

// Allvarsgraden står mitt i en mening i annonstexten och är gemen därför; skadetyperna inleder sin
// rad och kommer ur den delade tabellen, som annonsens chatt läser samma etiketter ur.
const SEVERITY_LABELS: Record<Severity, string> = {
  S1: "mindre", S2: "måttlig", S3: "stor", S4: "kritisk",
};

/**
 * Hur en köpare känner igen ett mått bland specifikationerna.
 *
 * Samma familj av ord som annonsgeneratorn använder när den avgör om måtten alls hittades (se
 * deriveMissingFields i generate.ts). Måtten bryts ut i ett eget stycke överst i specifikationerna,
 * för att det är den fråga som annars ställs i meddelandefunktionen: går den in genom dörren.
 */
const DIMENSION_HINT = /(m[åa]tt|bredd|djup|h[öo]jd|l[äa]ngd|diameter|dimension|sitth[öo]jd|storlek)/i;

/**
 * Var kortet finns att läsa. Utan adress i miljön står bara ID:t i annonsen.
 *
 * Läses VID ANROP och inte vid modulladdning: server.ts kallar loadEnvFile i sin modulkropp, och ESM
 * kör alla importerade moduler före den — en konstant här hade aldrig sett server/.env.
 */
export function publicCardUrl(loopaId: string): string | null {
  const base = process.env.LOOPA_PUBLIC_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}/c/${loopaId}` : null;
}

/**
 * Annonstexten som block.
 *
 * Annonsen säger tre saker rakt ut, i den ordningen: att den är skriven av Loopa, vad AI:n hittade,
 * och vilket skick den satte. Det är hela poängen med Loopa — en köpare ska se exakt vad
 * besiktningen såg, inte "bruksslitage, se bilder" — och det håller bara om annonsen också berättar
 * VEM som tittat och att det var en maskin. Ett skick satt av en AI som utger sig för att vara
 * säljarens egen bedömning vore samma lögn som en bortretuscherad repa.
 *
 * Därefter allt en möbelannons behöver för att inte behöva en fråga i meddelandefunktionen: mått,
 * övriga specifikationer, skicket i klartext, varje skada, och — på Tradera — leveranssättet.
 *
 * Sist Loopa-ID:t. Annonsen bakom det är publik, och det är där påståendena ovan går att kontrollera
 * mot bild, källor och en skada i taget.
 */
export function composeAd(job: ConditionJob, options: AdOptions): AdBlock[] {
  const result = job.result!;
  const card = result.listing!.result!;
  const loopaId = loopaIdFor(job.id);
  const blocks: AdBlock[] = [];

  // Samma regel som kortet och betyget: säljarens avvisade fynd bort, och andra besiktningens
  // underkända likaså. Annonstexten är kortet i textform och får inte räkna fler skador än det.
  const damages = result.damages.filter(damageStands);
  const grade = result.grade;

  // Avsändaren först, före allt annat. Den som skummar en annons läser den första raden.
  const found =
    damages.length > 0
      ? `hittat ${damages.length} ${damages.length === 1 ? "synlig skada" : "synliga skador"}`
      : "inte hittat någon synlig skada";
  const opening =
    `Loopas AI har gått igenom ${result.images.length} ${result.images.length === 1 ? "vy" : "vyer"} av möbeln` +
    `${result.reviewed ? " i två besiktningar" : ""}, ${found} och `;
  const tail = damages.length > 0 ? " Skadorna står utskrivna längre ner, en och en." : "";

  blocks.push(paragraph([{ text: "Den här annonsen är skapad av Loopa.", strong: true }]));
  blocks.push(
    paragraph(
      grade
        ? [
            { text: `${opening}satt skicket ` },
            { text: grade.label, strong: true },
            { text: ` (${grade.canonicalCondition}).${tail}` },
          ]
        : [{ text: `${opening}sammanställt uppgifterna nedan.${tail}` }],
    ),
  );

  blocks.push(paragraph([{ text: card.listing.description }]));

  // Måtten för sig. De avgör om möbeln passar där den ska stå, och ska inte behöva letas fram ur en
  // lista där de ligger mellan träslag och årsmodell.
  const dimensions = card.attributes.filter((a) => DIMENSION_HINT.test(a.key) || DIMENSION_HINT.test(a.label));
  const rest = card.attributes.filter((a) => !dimensions.includes(a));
  blocks.push(paragraph([{ text: "Mått", strong: true }]));
  if (dimensions.length > 0) {
    blocks.push(attributeList(dimensions));
    // Måtten finns numera alltid — men inte alltid belagda. Står de bara på uppskattning ska det stå
    // i annonsen också, i klartext under talen och inte bara som ett "ca" framför dem.
    if (dimensions.every((d) => d.estimated)) {
      blocks.push(
        paragraph([
          {
            text:
              "Måtten är uppskattade utifrån typiska mått för möbeltypen och inte belagda mot någon källa." +
              " Fråga säljaren om de exakta måtten.",
          },
        ]),
      );
    }
  } else {
    blocks.push(
      paragraph([{ text: "Måtten kunde inte beläggas mot någon källa. Fråga säljaren om de behöver bekräftas." }]),
    );
  }
  if (rest.length > 0) {
    blocks.push(paragraph([{ text: "Specifikationer", strong: true }]));
    blocks.push(attributeList(rest));
  }

  blocks.push(
    paragraph([
      {
        text: `Skick: ${grade ? `${grade.label} — ${grade.canonicalCondition}` : "bedömt utifrån bilderna"}`,
        strong: true,
      },
    ]),
  );
  if (grade?.rationale) blocks.push(paragraph([{ text: grade.rationale }]));
  // Annonsgeneratorns egen skicktext (`card.listing.conditionText`) står AVSIKTLIGT inte här.
  // Den skrivs av en modell som sett bilderna men inte besiktningen, och den skriver därför saker
  // som "fint begagnat skick utan synliga skador" på en möbel där besiktningen just räknat upp sex.
  // I en annons som säger att en AI hittat de här skadorna är en sådan mening inte bara överflödig,
  // den är osann. Skicket har EN röst i annonsen, och det är besiktningens.

  if (damages.length > 0) {
    blocks.push(
      paragraph([
        { text: `AI:n hittade ${damages.length} ${damages.length === 1 ? "skada" : "skador"}:`, strong: true },
      ]),
    );
    // Numrerad: samma ordning och samma nummer som nålarna på annonsen, så en skada går att slå
    // upp där utan att först räknas fram.
    blocks.push({ kind: "list", ordered: true, items: damages.map(describeDamage) });
  } else {
    blocks.push(paragraph([{ text: "AI:n hittade inga synliga skador.", strong: true }]));
  }

  if (options.delivery) {
    // Leveransen är det köparen annars skriver ett meddelande om, och svaret är inte "hämtas hos
    // säljaren" längre — Loopa kör hem möbeln. Två saker måste stå: att inget tillkommer i kassan,
    // och vad som händer efter köpet. Beloppet skrivs ut trots att köparen inte betalar det separat;
    // en hemleverans som bara sägs "ingå" läses som att den inte är värd något.
    blocks.push(paragraph([{ text: "Leverans", strong: true }]));
    blocks.push(paragraph([{ text: "Leverans endast — frakt ingår. Boka tid efter köp.", strong: true }]));
    blocks.push(
      paragraph([
        {
          text:
            `Hemleveransen kostar ${SHIPPING_INCLUDED_SEK} kr och är redan inräknad i priset — ingenting ` +
            "tillkommer i kassan. Efter köpet bokas leveransen: en budfirma kör möbeln hem till din dörr, " +
            "och du väljer leveranstid via SMS. Avhämtning erbjuds inte.",
        },
      ]),
    );
  }

  const url = publicCardUrl(loopaId);
  blocks.push(paragraph([{ text: `Loopa-ID: ${loopaId}`, strong: true }]));
  blocks.push(
    paragraph([
      {
        text:
          "Varje annons hos Loopa är publik. Sök på Loopa-ID:t hos Loopa så ser du hela besiktningen: " +
          "skicket, varje skada, måtten och källorna bakom uppgifterna." +
          (url ? ` ${url}` : ""),
      },
    ]),
  );

  return blocks;
}

/**
 * Annonsen som HTML — Traderas annonser renderas som HTML (kontrollerat mot en publicerad annons:
 * `<br>` och `<strong>` går fram, `&` kommer tillbaka escapat).
 *
 * Allt escapas här och ingenstans annars. Blocken bär RÅ text, så samma innehåll kan gå ut som ren
 * text utan att bära med sig `&amp;` från en HTML-vändning det aldrig var med om.
 */
export function renderAdHtml(blocks: AdBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "list") {
        const tag = block.ordered ? "ol" : "ul";
        return `<${tag}>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</${tag}>`;
      }
      const inner = block.runs
        .map((run) => {
          const html = escapeHtml(run.text).replace(/\n+/g, "<br>");
          return run.strong ? `<strong>${html}</strong>` : html;
        })
        .join("");
      return `<p>${inner}</p>`;
    })
    .join("\n");
}

/**
 * Annonsen som ren text — det Blockets beskrivningsfält tar emot.
 *
 * Ingen markdown, inga stjärnor kring rubrikerna: det säljaren klistrar in ska se ut som färdig
 * annonstext direkt, och `**Mått**` i ett fält som inte renderar markdown är en asterisk för mycket.
 * Punktlistan får en bullet och skadelistan sina nummer, för att de ÄR listor även utan HTML.
 *
 * En lista hålls ihop med stycket ovanför med ett enkelt radbrott. Rubriken och dess punkter är en
 * sak, och en tom rad mellan dem hade brutit isär det som hör ihop.
 */
export function renderAdPlain(blocks: AdBlock[]): string {
  let out = "";
  for (const [i, block] of blocks.entries()) {
    if (i > 0) out += block.kind === "list" && blocks[i - 1].kind === "paragraph" ? "\n" : "\n\n";
    out +=
      block.kind === "list"
        ? block.items.map((item, n) => (block.ordered ? `${n + 1}. ${item}` : `• ${item}`)).join("\n")
        : block.runs.map((run) => run.text).join("");
  }
  return out;
}

/**
 * Priset annonsen sätts till: MÖBELNS pris, utan frakt.
 *
 * Säljarens eget val först. Har de satt ett prisspann är startpriset i den stegen ett BESLUT, och det
 * går före varje maskinellt förslag — hela poängen med spannet är att de vet något om sin egen
 * brådska som prismotorn inte kan veta.
 *
 * Därefter besiktningens pris, det enda som räknat AV för skadorna, och sist annonsgeneratorns
 * förslag, som inte sett skadorna men är bättre än inget.
 */
export function resolveAdPrice(job: ConditionJob): { value: number; source: "seller" | "condition" | "listing" } | null {
  const ladder = job.priceLadder;
  if (ladder && ladder.currentPrice > 0) return { value: Math.round(ladder.currentPrice), source: "seller" };

  const price = job.result?.price;
  if (price?.status === "ok" && price.default && price.default > 0) {
    return { value: Math.round(price.default), source: "condition" };
  }
  const suggested = job.result?.listing?.result?.pricing.suggestedPriceSek;
  if (suggested && suggested > 0) return { value: Math.round(suggested), source: "listing" };
  return null;
}

/**
 * Bilderna till annonsen: omslaget först, obrukbara bildrutor bortsorterade.
 *
 * Ordningen är inte kosmetisk. Tradera gör den första uppladdade bilden till annonsens omslag, och
 * på Blocket är det den första säljaren laddar upp — i båda fallen är det bilden en köpare ser i
 * sökresultatet. `coverImageId` sätts av pipelinen; saknas den (jobb från före omslagsvalet) räknas
 * den fram av resolveCoverImageId innan det här anropas.
 */
export async function adImages(job: ConditionJob): Promise<CapturedImage[]> {
  const images = job.result?.images ?? job.images ?? [];
  return presentableImages(images, path.join(jobDir(job.id), "originals"), job.result?.coverImageId ?? null);
}

/** Annonsrubriken, eller tom sträng när det inte finns någon att bygga av. */
export function adTitle(job: ConditionJob): string {
  const card = job.result?.listing?.result;
  if (!card) return "";
  return (
    card.listing.title || [card.identity.brand, card.identity.exactProduct].filter(Boolean).join(" ")
  ).trim();
}

function paragraph(runs: AdRun[]): AdBlock {
  return { kind: "paragraph", runs };
}

function attributeList(attributes: ListingAttribute[]): AdBlock {
  return { kind: "list", ordered: false, items: attributes.map((a) => `${a.label}: ${a.value}`) };
}

function describeDamage(damage: Damage): string {
  const head = [TYPE_LABELS[damage.type], damage.part].filter(Boolean).join(" på ");
  const where = damage.semanticLocation ? ` (${damage.semanticLocation})` : "";
  const severity = SEVERITY_LABELS[damage.severity];
  return `${head}${where} — ${severity}. ${damage.description}`.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
