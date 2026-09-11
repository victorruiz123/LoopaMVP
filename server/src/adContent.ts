/**
 * Annonsen, oberoende av var den publiceras.
 *
 * Texten, priset och bildordningen bodde tidigare inne i Tradera-publiceringen. De ligger här i
 * stället för att annonsen är en sak och kanalen en annan: vad som står om möbeln — samma skador,
 * samma mått, samma skickord — ska avgöras på ETT ställe, oavsett var den sedan hamnar.
 *
 * Här fanns en andra väg ut: en färdig text att föra över för hand till Blocket. Den är borttagen,
 * och med den `renderAdPlain` som renderade blocken till den rena text Blockets beskrivningsfält
 * tog emot. Kvarvarande kanal är Tradera-publiceringen.
 *
 * Annonsen byggs ändå som BLOCK och inte som färdig HTML. Renderingen är ett eget steg
 * (`renderAdHtml`), så nästa kanal med ett annat textformat kostar en renderare och inte en andra
 * annonstext som börjar glida isär från den här.
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
  /**
   * Om Loopa ska stå som SÄLJARE och inte bara som avsändare för texten.
   *
   * Samma skiljelinje som `delivery`, och av samma skäl: på Tradera ligger annonsen på Loopas konto,
   * pengarna går till Loopa och det är Loopa som bokar budfirman. Då ska det stå i första raden —
   * en köpare som tror att de handlar av en privatperson gissar fel om både frakt och ansvar. Där
   * Loopa bara skrivit texten åt en säljare (Blocket-vägen) vore samma mening osann.
   */
  loopaSells: boolean;
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
function publicCardUrl(loopaId: string): string | null {
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
/**
 * Meningar som lovar något om hämtning eller frakt. Se anropet i composeAd för varför de ska bort.
 *
 * `skick` fastnar INTE i den här: mönstret kräver "skicka", "skickas" eller "skickar", alltså verbet
 * — annars hade "Gott begagnat skick" läst som ett fraktlöfte och beskrivningen tömts på det enda
 * ordet den handlar om.
 */
const LEVERANSLOFTE = /(hämt|avhämt|upphämt|frakt|leverans|levereras|leverera|skicka[rs]?(?![a-zà-ÿ])|postas|budbil)/i;

function utanLeveransloften(text: string): string {
  // Meningsgräns: punkt, utrops- eller frågetecken följt av blanksteg. Avslutningen "Hämtas enligt
  // överenskommelse." saknar ofta mellanslag efter sig, därför tas även radslut som gräns.
  const meningar = text.split(/(?<=[.!?])\s+/);
  const kvar = meningar.filter((m) => !LEVERANSLOFTE.test(m));
  return kvar.join(" ").trim();
}

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

  // Avsändaren OCH säljaren i samma rad. Att annonsen är skriven av Loopa säger vem som står bakom
  // orden; att möbeln säljs av Loopa säger vem köparen gör affär med — och det andra är det som
  // avgör vad de kan förvänta sig av frakt, betalning och ansvar.
  blocks.push(
    paragraph([
      {
        text: options.loopaSells
          ? "Den här möbeln säljs av Loopa, och annonsen är skriven av Loopa."
          : "Den här annonsen är skapad av Loopa.",
        strong: true,
      },
    ]),
  );
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

  /**
   * Möbelbeskrivningen — men utan generatorns egna leveranslöften.
   *
   * SAMMA REGEL SOM SKICKET NEDAN: uppgiften har EN röst i annonsen. Beskrivningen skrivs av en
   * modell som sett bilderna men inte affären, och den avslutar gärna med "Hämtas enligt
   * överenskommelse" eller "kan skickas mot fraktkostnad" — meningar som var sanna när en
   * privatperson sålde själv, och som nu står rakt emot leveransstycket längre ner: Loopa kör hem
   * möbeln, avhämtning erbjuds inte, frakten är redan betald. En annons som säger båda sakerna
   * lämnar köparen att gissa vilken som gäller, och den gissningen blir ett meddelande att svara på.
   *
   * MENINGEN FALLER HELT, även om den bär något om möbeln på köpet. Det som går förlorat står ändå
   * i måtten, specifikationerna och skadelistan; det som blir kvar annars är ett löfte vi inte kan
   * hålla. Blir ingenting kvar utelämnas stycket — resten av annonsen beskriver möbeln ändå.
   */
  const beskrivning = options.delivery ? utanLeveransloften(card.listing.description) : card.listing.description;
  if (beskrivning) blocks.push(paragraph([{ text: beskrivning }]));

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
              // "Fråga säljaren" är fel tilltal i en annons där Loopa ÄR säljaren — köparen skulle
              // leta efter en tredje part som inte finns. Samma rad, riktad till rätt motpart.
              (options.loopaSells ? " Fråga oss om de exakta måtten." : " Fråga säljaren om de exakta måtten."),
          },
        ]),
      );
    }
  } else {
    blocks.push(
      paragraph([
        {
          text:
            "Måtten kunde inte beläggas mot någon källa." +
            (options.loopaSells ? " Fråga oss om du behöver dem bekräftade." : " Fråga säljaren om de behöver bekräftas."),
        },
      ]),
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

  /**
   * Pälsdjur och lukt — de två uppgifterna ingen bild kan bära.
   *
   * EGEN RUBRIK, OCH EGEN AVSÄNDARE. Resten av annonsen är besiktningens ord, och det är hela dess
   * värde: en köpare ska veta att skadorna kommer ur en granskning och inte ur en säljares
   * självbild. De här två raderna kommer från motsatt håll — säljaren har svarat på en fråga — och
   * att blanda in dem i AI:ns stycken hade tillskrivit maskinen ett påstående den inte kan göra.
   * En katt syns inte på en soffa, och lukt syns aldrig.
   *
   * BÅDA SVAREN SKRIVS UT, även nejen. Ett utelämnat nej är inte ett nej utan en tystnad, och det är
   * just tystnaden en allergiker skriver ett meddelande om. Har säljaren aldrig svarat står stycket
   * inte alls: ett tomt fält får inte bli ett nej i text.
   */
  const disclosures = job.sellerDisclosures;
  if (disclosures) {
    blocks.push(paragraph([{ text: "Från säljaren", strong: true }]));
    const smell = disclosures.smell
      ? disclosures.smellNote
        ? // Säljarens egna ord, oomskrivna: "luktar rök" och "luktar svagt av källare" är olika
          // saker för en köpare, och skillnaden är precis det en sammanfattning tar bort.
          `Möbeln luktar något. Säljaren beskriver lukten: ${disclosures.smellNote}`
        : "Möbeln luktar något. Säljaren har inte beskrivit lukten närmare."
      : "Säljaren känner ingen lukt från möbeln.";
    /**
     * Antalet stolar står FÖRST i listan, och står bara när säljaren räknat upp mer än en.
     *
     * Det är inte en upplysning av samma slag som de andra två — pälsdjur och lukt beskriver möbeln,
     * det här säger vad köparen får för pengarna. Men det hör hemma just här ändå: priset ovanför
     * gäller hela bunten (se prisForAntalStolar), och en annons som visar ett buntpris under ett
     * foto av en stol läser som ett styckpris. Raden är det som gör talet begripligt.
     */
    const antal = disclosures.chairCount ?? null;
    blocks.push({
      kind: "list",
      ordered: false,
      items: [
        ...(antal && antal > 1 ? [`Säljs som ett set om ${antal} stolar — priset gäller alla.`] : []),
        disclosures.pets
          ? "Det finns pälsdjur i hemmet där möbeln har stått."
          : "Det finns inga pälsdjur i hemmet där möbeln har stått.",
        smell,
      ],
    });
    blocks.push(
      paragraph([
        {
          text:
            "De två uppgifterna kommer från säljaren och inte från besiktningen — varken pälsdjur " +
            "eller lukt går att se på bild.",
        },
      ]),
    );
  }

  if (options.delivery) {
    // Leveransen är det köparen annars skriver ett meddelande om, och svaret är inte "hämtas hos
    // säljaren" längre — Loopa kör hem möbeln. Tre saker måste stå: att det BARA är hemleverans, att
    // ingenting tillkommer i kassan, och vem som gör vad efter köpet. Beloppet skrivs ut trots att
    // köparen inte betalar det separat; en hemleverans som bara sägs "ingå" läses som att den inte
    // är värd något.
    blocks.push(paragraph([{ text: "Leverans", strong: true }]));
    blocks.push(
      paragraph([{ text: "Endast hemleverans — frakten ingår i priset.", strong: true }]),
    );
    blocks.push(
      paragraph([
        {
          text:
            "Loopa löser hemleveransen åt dig efter köpet: en budfirma kör möbeln hem till din dörr, och " +
            "du väljer leveranstid via SMS. " +
            `Hemleveransen kostar ${SHIPPING_INCLUDED_SEK} kr och är redan inräknad i priset — ingenting ` +
            "tillkommer i kassan. Avhämtning erbjuds inte.",
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
