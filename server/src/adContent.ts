/**
 * Annonsen, oberoende av var den publiceras.
 *
 * Texten, priset och bildordningen bodde tidigare inne i Tradera-publiceringen. De ligger här i
 * stället för att annonsen är en sak och kanalen en annan: vad som står om möbeln — samma skador,
 * samma mått, samma skickord — ska avgöras på ETT ställe, oavsett var den sedan hamnar.
 *
 * Här fanns en andra väg ut: en färdig text att föra över för hand till Blocket. DEN vägen är
 * borttagen — att lämna tillbaka annonsen som text att bära någon annanstans var inte att sälja med
 * Loopa. `renderAdPlain` är däremot tillbaka, och nu för motsatt ärende: Blocket-roboten fyller i
 * beskrivningsfältet i deras formulär, och det fältet tar ren text. Ingen människa för över något.
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
import { SHIPPING_INCLUDED_SEK } from "./hemleverans.js";
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
   * Sant på BÅDA marknadsplatserna. Annonsen ligger på ett Loopa-konto, Loopa bokar budfirman efter
   * köpet, och hemleveransen är inräknad i priset som står — så texten kan lova den.
   *
   * Flaggan finns kvar trots att båda kanalerna säger sant, och det är med flit: den dag en annons
   * går ut i någon annans namn — en säljare som lägger upp själv — är löftet om hemleverans något de
   * fick hålla utan att ha lovat det, och då ska det gå att stänga av med ett `false` i stället för
   * att texten måste skrivas om. Det var precis så Blocket-vägen såg ut innan roboten fanns.
   */
  delivery: boolean;
  /**
   * Om Loopa ska stå som SÄLJARE och inte bara som avsändare för texten.
   *
   * Samma skiljelinje som `delivery` och sant i samma fall: ligger annonsen på Loopas konto går
   * pengarna till Loopa och det är Loopa som bokar budfirman. Då ska det stå i första raden — en
   * köpare som tror att de handlar av en privatperson gissar fel om både frakt och ansvar.
   */
  loopaSells: boolean;
  /**
   * Om den köpfria annonssidan ska stå med i texten.
   *
   * SANT BARA PÅ TRADERA. Sidan (/butik/info/<loopaId>) är besiktningen utan köpruta, och den är
   * byggd för just den läsaren: någon som står mitt i ett bud och vill kontrollera att skicket i
   * annonsen stämmer. Den ska inte kunna köpa av oss i stället — då hade länken flyttat affären ur
   * kanalen den ligger i.
   *
   * FALSKT PÅ BLOCKET, tills vidare. Inte för att sidan vore fel där, utan för att länken är ny och
   * ska prövas på ett ställe i taget: Blocket-annonsen är ordagrant Traderas (se publish.ts), och
   * går texten ut på båda samtidigt finns inget att jämföra utfallet mot. Loopa-ID:t och den
   * publika uppslagssidan står kvar i båda.
   */
  infoPage: boolean;
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
 * Den köpfria annonssidan — möbeln som den står i butiken, utan köpruta.
 *
 * SKILD FRÅN /c/ MED FLIT, fast båda visar samma besiktning. Uppslagssidan svarar på "vad betyder
 * det här Loopa-ID:t" och börjar därför i en sökruta; den här svarar på "vad är det för möbel jag
 * tittar på" och börjar i möbeln — bilden, skicket, skadorna, måtten. Det är två olika frågor, och
 * den som klickar på en länk i en annons ställer den andra.
 *
 * Samma bas och samma sena avläsning som ovan, av samma skäl.
 */
function infoPageUrl(loopaId: string): string | null {
  const base = process.env.LOOPA_PUBLIC_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}/butik/info/${loopaId}` : null;
}

/**
 * Annonstexten som block.
 *
 * ORDNINGEN ÄR KÖPARENS, INTE VÅR. Texten öppnade förut med två stycken om Loopa — vem som skrivit
 * annonsen, hur många vyer AI:n gått igenom, i hur många besiktningar — och först i tredje stycket
 * stod det vad möbeln var. Den som skummar en annonslista läser en rad och bläddrar vidare, och den
 * raden handlade om oss. Nu står avsändaren på en rad, möbeln på nästa, och allt som är en
 * MÄTNING (mått, skick, skador) samlat därefter.
 *
 * AVSÄNDAREN STÅR KVAR FÖRST, kortad till en mening. Att skicket är satt av en maskin och inte av
 * säljaren är inte en teknisk detalj utan hela skillnaden mot "bruksslitage, se bilder": ett skick
 * satt av en AI som utger sig för att vara säljarens egen bedömning vore samma lögn som en
 * bortretuscherad repa. Vad AI:n faktiskt gjorde — hur många håll, hur många gånger, vad den
 * hittade — flyttade däremot NER till skickstycket, där påståendet det kvalificerar står. Uppgiften
 * är densamma; den står bara där den betyder något.
 *
 * SAMMA SAK SÄGS EN GÅNG. Skadeantalet stod på tre ställen (ingressen, en rad som pekade nedåt, och
 * listans rubrik) och skicket på två, med två olika ord för samma betyg. En annons som upprepar sig
 * läser som en annons som fyller ut, och läsaren börjar skumma just det som ska läsas noga.
 *
 * Sist Loopa-ID:t och EN länk — den till sidan där påståendena går att kontrollera mot bild, källor
 * och en skada i taget.
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

  /**
   * Avsändaren på EN rad, och båda sakerna den måste bära.
   *
   * Att annonsen är skriven av Loopa säger vem som står bakom orden; att möbeln SÄLJS av Loopa säger
   * vem köparen gör affär med, vilket är det som avgör vad de kan vänta sig av frakt, betalning och
   * ansvar. Att granskningen är gjord av en AI står med här och inte bara nere vid skicket, för att
   * raden annars läser som att en människa tittat — och den som skummar läser bara den här raden.
   *
   * Tre meningar blev en. Vad AI:n hittade står i skickstycket, där siffran hör hemma.
   */
  blocks.push(
    paragraph([
      {
        text: options.loopaSells
          ? "Säljs av Loopa. Vi har filmat möbeln, granskat den med AI och skrivit annonsen."
          : "Annonsen är skriven av Loopa. Vi har filmat möbeln och granskat den med AI.",
        strong: true,
      },
    ]),
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

  /**
   * Skicket — ETT ord, inte två.
   *
   * Raden löd "Skick: Gott begagnat skick — Mycket bra skick": två etiketter för samma betyg, med ett
   * tankstreck emellan som läser som att de säger olika saker. `canonicalCondition` är enligt sin egen
   * typ de publika skickorden (fyra möjliga, se types.ts) och är alltså det ord som är skrivet för en
   * köpare; `grade.label` är vår egen formulering av samma sak och behövs inte bredvid den.
   */
  blocks.push(
    paragraph([
      { text: `Skick: ${grade ? grade.canonicalCondition : "bedömt utifrån bilderna"}`, strong: true },
    ]),
  );
  if (grade?.rationale) blocks.push(paragraph([{ text: grade.rationale }]));
  // Annonsgeneratorns egen skicktext (`card.listing.conditionText`) står AVSIKTLIGT inte här.
  // Den skrivs av en modell som sett bilderna men inte besiktningen, och den skriver därför saker
  // som "fint begagnat skick utan synliga skador" på en möbel där besiktningen just räknat upp sex.
  // I en annons som säger att en AI hittat de här skadorna är en sådan mening inte bara överflödig,
  // den är osann. Skicket har EN röst i annonsen, och det är besiktningens.

  /**
   * Vad granskningen faktiskt bestod i, precis före det den kom fram till.
   *
   * Stod tidigare i ingressen, långt från skadelistan, i orden "gått igenom 2 vyer av möbeln i två
   * besiktningar". "Vy" och "besiktning" är VÅRA ord för en filmad vinkel och en omkörning av
   * granskningen; en köpare läser "2 vyer" som att vi sett två bilder. "Från 2 håll" och "två
   * gånger" säger samma sak med ord som inte behöver förklaras.
   *
   * Antalet skador står HÄR och bara här. Det stod förut också i ingressen och i en rad som sa att
   * skadorna kom längre ner — en hänvisning nedåt i en text man ändå läser uppifrån och ner.
   */
  const granskning =
    `Loopas AI har granskat möbeln från ${result.images.length === 1 ? "ett" : result.images.length} ` +
    `${result.images.length === 1 ? "håll" : "håll"}${result.reviewed ? ", två gånger," : ""} och `;
  if (damages.length > 0) {
    blocks.push(
      paragraph([
        {
          text: `${granskning}hittade ${damages.length} ${damages.length === 1 ? "skada" : "skador"}:`,
          strong: true,
        },
      ]),
    );
    // Numrerad: samma ordning och samma nummer som nålarna på annonsen, så en skada går att slå
    // upp där utan att först räknas fram.
    blocks.push({ kind: "list", ordered: true, items: damages.map(describeDamage) });
  } else {
    blocks.push(paragraph([{ text: `${granskning}hittade inga synliga skador.`, strong: true }]));
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
    // Kortad, men samma två saker: vem som svarat, och varför det inte kunde kontrolleras.
    blocks.push(
      paragraph([
        { text: "Uppgifterna kommer från säljaren och inte från besiktningen — varken pälsdjur eller lukt syns på bild." },
      ]),
    );
  }

  if (options.delivery) {
    /**
     * Leveransen — det köparen annars skriver ett meddelande om.
     *
     * Fyra uppgifter måste stå, och alla fyra står kvar: att leveransen ingår i priset, vad som
     * händer efter köpet, vad den kostar, och att avhämtning inte är ett alternativ. Beloppet
     * skrivs ut trots att köparen inte betalar det separat — en hemleverans som bara sägs "ingå"
     * läses som att den inte är värd något.
     *
     * EN RUBRIK FÄRRE, EN MENING FÄRRE. "Leverans" följt av "Endast hemleverans — frakten ingår i
     * priset" var en rubrik ovanpå en rubrik, och "Loopa löser hemleveransen åt dig efter köpet:"
     * var en inledning till en mening som sedan sa exakt vad vi löser. Den feta raden är rubriken
     * nu, och den säger det viktigaste i fyra ord. "Endast" behövs inte för att stänga avhämtningen
     * — sista meningen gör det rakt ut.
     */
    blocks.push(paragraph([{ text: "Hemleverans ingår i priset.", strong: true }]));
    blocks.push(
      paragraph([
        {
          text:
            "En budfirma kör möbeln hem till din dörr efter köpet, och du väljer leveranstid via SMS. " +
            `Hemleveransen kostar ${SHIPPING_INCLUDED_SEK} kr och är redan inräknad i priset — ingenting ` +
            "tillkommer i kassan. Avhämtning erbjuds inte.",
        },
      ]),
    );
  }

  /**
   * Loopa-ID:t och EN väg till besiktningen.
   *
   * Här stod två stycken med var sin länk: ett som bad läsaren söka upp ID:t på /c/, och ett som
   * pekade på den köpfria sidan. Båda leder till samma uppgifter, och två länkar i rad som säger
   * nästan samma sak läser som utfyllnad — värre, de tvingar läsaren att välja mellan dem utan att
   * ha något att välja på.
   *
   * KANALEN AVGÖR VILKEN SOM STÅR. Har annonsen en köpfri sida att peka på (Tradera) är den den
   * bättre destinationen: möbeln först, ingen sökruta att fylla i. Saknas den (Blocket) står
   * uppslagsvägen kvar precis som förut. ID:t skrivs ut i båda fallen — det är det köparen har kvar
   * om länken inte går fram, och det står i annonsen även när ingen adress är känd.
   *
   * REDAN PUBLICERADE ANNONSER BÄR /c/ INBAKAT. Att nya annonser slutar skriva ut den adressen
   * ändrar ingenting för dem: /c/ svarar där den står, för all framtid, och undantaget som ser till
   * det ligger kvar i butik/seo.ts.
   */
  blocks.push(paragraph([{ text: `Loopa-ID: ${loopaId}`, strong: true }]));
  const info = options.infoPage ? infoPageUrl(loopaId) : null;
  const kort = publicCardUrl(loopaId);
  if (info) {
    /*
     * Sidan säger rakt ut att den inte är ett andra ställe att köpa på. Utan den meningen läser en
     * Loopa-länk mitt i en Tradera-annons som ett försök att ta affären därifrån, vilket både
     * köparen och Tradera skulle ha rätt att irritera sig på.
     */
    blocks.push(
      paragraph([
        {
          text:
            `Se hela besiktningen — alla bilder, måtten och varje skada utpekad: ${info} ` +
            "Sidan är bara information, köpet gör du här i annonsen.",
        },
      ]),
    );
  } else {
    blocks.push(
      paragraph([
        {
          text:
            "Varje annons hos Loopa är publik. Sök på Loopa-ID:t hos Loopa så ser du hela besiktningen: " +
            "skicket, varje skada, måtten och källorna bakom uppgifterna." +
            (kort ? ` ${kort}` : ""),
        },
      ]),
    );
  }

  return blocks;
}

/**
 * Annonsen som REN TEXT — Blockets beskrivningsfält är en textarea utan märkspråk.
 *
 * Granne med `renderAdHtml` och byggd ur samma block, vilket är hela poängen med att annonsen är
 * block och inte färdig text: samma skador, samma mått och samma skickord går ut på båda kanalerna,
 * och en ändring i `composeAd` når dem samtidigt. Det som skiljer är formen — `strong` finns inte i
 * ren text, punktlistan blir bullets, och ingenting escapas eftersom blocken bär rå text.
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

/**
 * En skada som en rad i listan.
 *
 * "Repa på bordsskiva (vänstra hörnet) — måttlig. En repa på cirka 4 cm." — tankstrecket mitt i
 * delade raden i två halvor som båda började om, och allvarsgraden stod som ett eget påstående
 * mellan platsen och beskrivningen. Platsen hör ihop med delen och allvarsgraden hör ihop med
 * skadan, så de sitter nu på var sin sida: delen och var på den, sedan hur illa det är, sedan
 * besiktningens egna ord. Samma fyra uppgifter, en klausul mindre att ta sig igenom.
 */
function describeDamage(damage: Damage): string {
  const head = [TYPE_LABELS[damage.type], damage.part].filter(Boolean).join(" på ");
  const where = damage.semanticLocation ? `, ${damage.semanticLocation}` : "";
  const severity = SEVERITY_LABELS[damage.severity];
  return `${head}${where} (${severity}). ${damage.description}`.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
