import { listJobs } from "./jobStore.js";
import { damageStands } from "./pipeline/grade.js";
import { loopaIdFor, normalizeLoopaId } from "./loopaId.js";
import { harGodkantOmslag, publikaGalleribilder } from "./pipeline/bild/omslag.js";
import type {
  CapturedImage,
  ConditionJob,
  Damage,
  EvidenceMark,
  FurnitureIdentity,
  GeneratedListing,
  GradeExplanation,
  Impact,
  ProductImage,
  Severity,
} from "./types.js";

/**
 * Den publika annonsen.
 *
 * Kortet är publikt med flit: Tradera-annonsen bär ett Loopa-ID, och den som läser annonsen ska kunna
 * slå upp hela besiktningen bakom priset — skicket, varje skada, måtten och källorna. En annons som
 * påstår "AI-granskad" utan att gå att kontrollera är bara ett påstående till.
 *
 * Det som INTE följer med är lika medvetet. Ägaren, säljarens egna bildrutor och bevisbilderna stannar
 * bakom inloggningen: fotografierna är tagna i någons hem, och de behövs inte för att kontrollera ett
 * skick — skadorna sitter på renderingen, som byggs ur måtten. Publikt betyder att kortet går att
 * läsa, inte att allt bakom det ligger öppet.
 *
 * ETT undantag, och det är omslaget: möbeln urklippt mot vitt (se pipeline/bild/). Den bilden är
 * härledd ur en av säljarens bildrutor men visar bara möbeln — rummet, hemmet och allt annat som
 * råkade vara i bild är bortklippt. Den som läser en annons ska se VAD som säljs, och att visa
 * tillverkarens katalogbild av en ny exemplar i stället vore att svara på frågan med fel möbel.
 */

/** En skada som den står på det publika kortet. Bevisbilder och säljarens granskningsläge följer inte med. */
export interface PublicDamage {
  id: string;
  type: Damage["type"];
  part: string;
  semanticLocation: string;
  severity: Severity;
  impact: Impact;
  description: string;
  /**
   * Bildrutan skadan syns i, med den utmärkta rutan.
   *
   * Null när inspektionen inte lämnade någon bevisruta — då står anmärkningen kvar i listan med sin
   * text, för att den är sann även utan foto. En rad utan bild är sämre än en med; en rad som
   * försvinner för att bilden fattas är en skada vi tigit om.
   *
   * Måtten följer med för att markeringen är angiven i ANDELAR av bilden. Utan dem måste vyn gissa
   * bildens proportion, och en ruta ritad på en gissad proportion sitter fel — vilket är värre än
   * ingen ruta alls, för den pekar då ut ett ställe där skadan inte är.
   */
  bild: { url: string; mark: EvidenceMark; width: number; height: number } | null;
}

/** Priset, nedskalat till det kortet visar. Prismotorns egen matchningsstatistik är inte publik. */
export interface PublicPrice {
  status: "ok" | "no_data" | "unavailable";
  low: number | null;
  default: number | null;
  high: number | null;
  currency: "SEK";
  damageDeduction: number | null;
  unavailableReason: string | null;
}

export interface PublicCard {
  loopaId: string;
  createdAt: string;
  identity: FurnitureIdentity | null;
  card: GeneratedListing;
  grade: GradeExplanation | null;
  price: PublicPrice | null;
  damages: PublicDamage[];
  /** Hur många vyer besiktningen såg. Bildrutorna själva är inte publika — antalet är det som säger något. */
  imageCount: number;
  reviewed: boolean;
  productImage: ProductImage | null;
  /**
   * Kortets omslag, på ett Loopa-ID och inte på en jobbadress.
   *
   * `kind` säger vad porten FAKTISKT kommer att lämna ut på den adressen, och kortet skriver ut det
   * under bilden: `cutout` = möbeln urklippt mot vitt av produktbildssystemet, `photo` = säljarens
   * bildruta med rummet kvar. Skillnaden är inte kosmetisk. Urklippet är VÅR redigering av
   * bakgrunden, och ett kort som räknar upp varje skråma får inte tiga om att det rört bilden.
   *
   * Fältet räknas ur samma funktion som porten frågar (`harGodkantOmslag`), så de två kan inte
   * hamna i otakt: står det `cutout` här är det ett urklipp som kommer, och står det `photo` är det
   * bildrutan.
   */
  cover: { url: string; kind: "cutout" | "photo"; backdrop: string | null } | null;
  /**
   * Annonsens galleri: möbeln från flera håll, alla urklippta, omslaget först.
   *
   * ADRESSERNA RÄKNAS HÄR OCH INTE I VYN. Kortet vet vilka bilder som passerat kvalitetskontrollen
   * (`publikaGalleribilder`) och porten frågar samma funktion; en vy som i stället gissade adresser
   * ur ett antal hade bett om bilder porten vägrar lämna ut så fort en enda vinkel underkänts.
   *
   * TOM LISTA ÄR NORMALT och betyder "bara omslaget" — jobb byggda före galleriet, jobb där bara en
   * bildruta dög, och jobb vars omslag inte är godkänt. Vyn ska då visa `cover` precis som förut,
   * inte en bläddring med ett enda kort i.
   *
   * BARA URKLIPP. Till skillnad från `cover`, som faller tillbaka på säljarens orörda bildruta när
   * urklippet uteblir, innehåller den här listan aldrig ett rumsfoto. Bildrutorna är filmade i
   * någons hem, och det som gör dem publicerbara är just att rummet är bortklippt — fem foton ur ett
   * vardagsrum är en helt annan sak att lägga ut än ett.
   */
  bilder: Array<{ url: string; kind: "cutout" }>;
  /** Annonsen på Tradera, när kortet är publicerat dit. Kortet finns även utan den. */
  tradera: { status: string; url: string | null } | null;
}

/**
 * Skador som ska stå på kortet.
 *
 * Samma filtrering som Tradera-annonsen och annonsskärmen gör: en anmärkning säljaren avvisat är
 * inte längre ett fynd — och inte heller en som andra besiktningen underkänt. Ett fynd som betyget och
 * priset räknat bort får inte stå kvar på kortet: då står det ett falsklarm på köparens attest.
 * Ordningen är oförändrad, för numren i listan är de som står som nålar på renderingen och som
 * punkter i annonstexten.
 */
export function publicDamages(damages: Damage[], loopaId: string, images: CapturedImage[]): PublicDamage[] {
  const bilder = new Map(images.map((i) => [i.id, i]));
  return damages
    .filter(damageStands)
    .map((d) => {
      // Första bevisrutan med en bildruta vi faktiskt har. Fler än en bild per skada är en
      // uppräkning kortet inte behöver: den som vill se skadan vill se DEN, inte varje vinkel.
      const bevis = d.evidence.find((e) => bilder.has(e.imageId));
      const bild = bevis ? bilder.get(bevis.imageId)! : null;
      return {
        id: d.id,
        type: d.type,
        part: d.part,
        semanticLocation: d.semanticLocation,
        severity: d.severity,
        impact: d.impact,
        description: d.description,
        bild: bevis && bild
          ? {
              url: `/api/cards/${loopaId}/skada/${encodeURIComponent(bevis.imageId)}`,
              mark: bevis.mark,
              width: bild.width,
              height: bild.height,
            }
          : null,
      };
    });
}

/**
 * Bildrutorna som är publika för ett kort: omslaget, och de som en kvarstående skada pekar ut.
 *
 * Porten frågar den här och ingenting annat. Skälet är att en bildruta är ett foto ur någons hem:
 * den som kan gissa ett bild-id ska inte kunna bläddra i filmningen, bara se de rutor kortet
 * faktiskt visar. Listan byggs ur samma `damageStands`-filter som kortet, så en skada som fallit
 * bort ur rapporten tar sin bild med sig ut ur porten samma sekund.
 */
export function publikaBildrutor(job: ConditionJob): Set<string> {
  const ut = new Set<string>();
  for (const d of job.result?.damages ?? []) {
    if (!damageStands(d)) continue;
    for (const e of d.evidence) ut.add(e.imageId);
  }
  return ut;
}

/**
 * Urklippet, var det än hann skrivas.
 *
 * Samma två ställen som annonsen och produktbilden: det byggs i sitt eget spår och landar antingen i
 * resultatet eller på jobbet, beroende på vilket spår som var först.
 */
export function cutoutOf(job: ConditionJob) {
  return job.result?.coverCutout ?? job.coverCutout ?? null;
}

/** Annonsen kan sitta på tre ställen — i resultatet, kvar på jobbet när besiktningen föll, eller ännu inte inflyttad. */
function listingOf(job: ConditionJob) {
  return job.result?.listing ?? job.listing ?? job.pendingListing ?? null;
}

/**
 * Kortet, eller null när jobbet inte är en annons.
 *
 * Ett jobb utan färdig annons har inget publikt att visa: det finns varken modell, mått eller
 * annonstext, bara ett skick utan möbel att hänga det på. Då är rätt svar att ID:t inte finns.
 */
/**
 * Om jobbet har ett publikt kort — och därmed ett publikt omslag.
 *
 * Egen funktion för att TVÅ ställen måste svara likadant: kortet självt och butikens projektion
 * (butik/normalize.ts), som lägger ut omslagets adress i rutnätet. Skulle de svara olika hade
 * rutnätet pekat på en bild som porten inte lämnar ut, och varje sådan ruta blivit en trasig bild.
 *
 * ETT AFFÄRSJOBB HAR INGET PUBLIKT KORT. Kortet är publikt för att en Tradera-annons bär ett
 * Loopa-ID som vem som helst ska kunna slå upp. En skanning inuti ett affärsrum har ingen annons och
 * ingen publik motpart — den beställdes av en köpare för en enskild affär. Att ge den ett publikt
 * kort vore att lägga ut någons hem-möbel, mått och skador på en gissbar adress.
 *
 * Detsamma gäller `adDerived`: en analys av någon annans annons är varken vår möbel eller vår
 * annons, och den ska inte gå att slå upp av någon som gissar ett ID.
 */
export function harPubliktKort(job: ConditionJob): boolean {
  return fardigAnnons(job) !== null;
}

/** Annonsen bakom kortet, eller null. Samma prövning som `harPubliktKort`, men med texten kvar. */
function fardigAnnons(job: ConditionJob): GeneratedListing | null {
  if (job.dealId || job.adDerived) return null;
  const listing = listingOf(job);
  return listing?.status === "ok" ? (listing.result ?? null) : null;
}

export function publicCardFor(job: ConditionJob): PublicCard | null {
  const annons = fardigAnnons(job);
  if (!annons) return null;

  const result = job.result;
  const price = result?.price ?? null;

  return {
    loopaId: loopaIdFor(job.id),
    createdAt: job.createdAt,
    identity: job.identity ?? null,
    card: annons,
    grade: result?.grade ?? null,
    price: price && {
      status: price.status,
      low: price.low,
      default: price.default,
      high: price.high,
      currency: price.currency,
      damageDeduction: price.damageDeduction,
      unavailableReason: price.unavailableReason,
    },
    damages: publicDamages(result?.damages ?? [], loopaIdFor(job.id), result?.images ?? []),
    imageCount: (result?.images ?? job.images ?? []).length,
    reviewed: result?.reviewed ?? false,
    productImage: result?.productImage ?? job.productImage ?? null,
    /**
     * OMSLAGET ÄR SÄLJARENS EGEN BILDRUTA, ORÖRD — och den ligger EFTER katalogbilden i vyn.
     *
     * Kortet bär två bilder och låter vyn välja: `productImage` är tillverkarens studiobild av
     * modellen, `cover` är den bildruta inspektionen pekat ut som möbeln framifrån. ListingView tar
     * katalogbilden först, för det är den som ser ut som en möbel man köper, och faller till
     * bildrutan när modellen inte gick att belägga.
     *
     * INGEN AV DEM ÄR REDIGERAD. Urklippet — möbeln friklippt och lagd på vitt eller på sin egen
     * suddade bakgrund — är avvecklat som omslag: en mask som nästan lyckas ger en möbel med en
     * tvättkorg fastvuxen i armstödet, och det ser värre ut än vilken orörd bild som helst.
     *
     * ETT FOTO PER ANNONS, inte fler. Bildrutorna är filmade i någons hem; den här är den enda som
     * lämnar inloggningen som omslag, och bara när kortet finns publikt.
     */
    cover:
      (result?.images?.length ?? 0) > 0
        ? {
            url: `/api/cards/${loopaIdFor(job.id)}/cover`,
            kind: harGodkantOmslag(cutoutOf(job)) ? "cutout" : "photo",
            /**
             * Vilken botten porten faktiskt kommer att lämna ut, räknad ur samma post som byggde
             * filen. Null på omslag byggda före studion — de står mot vitt, och bildtexten på
             * kortet ska då säga just det i stället för att lova ett rum som inte finns i bilden.
             */
            backdrop: harGodkantOmslag(cutoutOf(job)) ? (cutoutOf(job)?.backdrop ?? null) : null,
          }
        : null,
    /**
     * Galleriet, på Loopa-ID och i samma ordning som filerna byggdes.
     *
     * Första bilden är omslagets adress och inte `galleri/1.jpg`: den filen är omslagets VITA
     * version, och den som bläddrar ska börja i studiobilden — samma bild butikens rutnät visade
     * innan hen klickade. Att låta bläddringens första kort vara en annan bild än det man klickade
     * på läser som att man hamnat fel.
     */
    bilder: publikaGalleribilder(cutoutOf(job)).map((b, i) => ({
      url:
        i === 0
          ? `/api/cards/${loopaIdFor(job.id)}/cover`
          : `/api/cards/${loopaIdFor(job.id)}/bild/${i + 1}`,
      kind: "cutout" as const,
    })),
    tradera: job.tradera ? { status: job.tradera.status, url: job.tradera.url } : null,
  };
}

/**
 * Jobbet bakom ett Loopa-ID.
 *
 * Genomsökning och inte ett register: ID:t är härlett ur jobb-id:t (se loopaId.ts), så jobben ÄR
 * registret. Samma svep som profillistan redan gör, och jobStore håller dem i minnet efteråt.
 */
export async function jobByLoopaId(raw: string): Promise<ConditionJob | undefined> {
  const wanted = normalizeLoopaId(raw);
  if (!wanted) return undefined;
  for (const job of await listJobs()) {
    if (loopaIdFor(job.id) === wanted) return job;
  }
  return undefined;
}
