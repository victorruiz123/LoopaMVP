import { callSellerGenerate, type Resolution, type SellerCall } from "../listing.js";
import { resolveCandidateImages, resolveProductPage, type SourceRef } from "../candidateImages.js";
import { mergeSpecs } from "../specHarvest.js";
import { getJob, getJobSync, jobDir, persist } from "../jobStore.js";
import { estimatePrice, pricingSignature, takeSpeculativePrice } from "../pricing.js";
import type { CapturedImage, ListingAttribute, ModelCandidate, ProductImage } from "../types.js";

/** Hur länge prissättningen väntar på att skickbedömningen ska bli klar. */
const CONDITION_WAIT_MS = 180_000;

/**
 * Gav försöket något att välja bland?
 *
 * Att bara fråga efter `kind` räcker inte: generatorn svarar `needs_selection` även när den skrivit
 * "KANDIDAT: INGEN", och det är en tom väljarskärm precis som ett `ok` utan modellnamn. Villkoret
 * räknar kandidater, för det är kandidater säljaren ska se.
 */
function barren(call: SellerCall): boolean {
  return call.kind !== "needs_selection" || call.candidates.length === 0;
}

/**
 * Ett svar värt att stanna på: kandidater OCH grundade källor bakom dem.
 *
 * Generatorn erbjuder numera kandidater även när den grundade sökningen föll — förslag får läsas ur
 * ogrundad text, fakta aldrig. Ett sådant svar är inte tomt, men det är sämre: källorna är det fas 2
 * ärver när dess EGEN sökning kommer tillbaka tom, och utan dem har annonsen inget belagt att bygga
 * mått på. Alltså frågar vi en gång till — samma enda omförsök som förut, nu med en tröskel som ser
 * skillnad på "inget svar" och "ogrundat svar".
 */
function settled(call: SellerCall): boolean {
  return call.kind === "needs_selection" && call.candidates.length > 0 && call.sources.length > 0;
}

/**
 * Två försök i serie, och det bättre av dem.
 *
 * Den första omgångens sökning. Ett omval bygger sin egen uthållighet ovanpå samma anrop — se
 * `collectNewCandidates`, som söker om tills fyra NYA namn står på skärmen.
 */
async function searchCandidates(jobId: string, brand: string, images: CapturedImage[], dir: string): Promise<SellerCall> {
  const call = await callSellerGenerate(brand, images, dir);
  if (settled(call)) return call;
  console.info(
    `[identify] ${jobId.slice(0, 8)} ${barren(call) ? "inga kandidater" : "ogrundade kandidater"}` +
      " på första försöket — försöker igen",
  );
  const second = await callSellerGenerate(brand, images, dir);
  // Behåll det bättre av de två: grundat slår ogrundat, ogrundade kandidater slår tomt.
  return settled(second) || (barren(call) && !barren(second)) ? second : call;
}

/** Samma lista, i samma ordning? Avgör om en sen bildhämtning fortfarande hör till det som visas. */
const sameList = (a: ModelCandidate[], b: ModelCandidate[]) =>
  a.length === b.length && a.every((c, i) => c.model === b[i]?.model);

/**
 * Produktbilderna hämtas EFTER att kandidaterna sparats, aldrig före.
 *
 * Väljarskärmen ska dyka upp exakt lika snabbt som förut — bilderna är en förbättring av den, inte
 * ett villkor för den. En kandidat vars bild aldrig landar är fortfarande fullt valbar.
 */
function attachCandidateImages(jobId: string, candidates: ModelCandidate[], sources: SourceRef[]): void {
  /**
   * Skrivs in ÄVEN när säljaren redan hunnit välja.
   *
   * Förut avbröts skrivningen så fort valet var gjort — bilderna var ändå bara till för
   * valskärmen. Nu bär hämtningen också sidans mått, och de är som mest värda EFTER valet: det
   * är annonsen som ska fyllas. Kandidatlistan används inte till något annat när identiteten är
   * avgjord, så en sen skrivning kan inte välta någon skärm.
   *
   * Anropas mer än en gång. Hämtningen lämnar ifrån sig de bilder den redan hittat innan den går
   * vidare och letar upp dem som fattas, så säljaren ser den första bilden när den finns och inte
   * när den sista gett upp. I en sådan delskrivning saknar de kandidater som fortfarande letas
   * `imageUrl` helt — det är precis vad väljarskärmen läser som "vänta, fler är på väg".
   */
  const publish = async (withImages: ModelCandidate[]): Promise<void> => {
    const fresh = getJobSync(jobId) ?? (await getJob(jobId));
    if (!fresh) return;
    if (fresh.identityStatus !== "needs_selection" && fresh.identityStatus !== "resolved") return;
    /**
     * Men bara i den lista bilderna faktiskt hör till.
     *
     * Hämtningen tar upp till åtta sekunder, och säljaren kan hinna trycka "hitta nya" under tiden.
     * Utan den här jämförelsen hade den gamla omgången skrivit tillbaka sina fyra avfärdade förslag
     * ovanpå de nya — långt efter att skärmen bytt innehåll.
     */
    if (!sameList(fresh.candidates ?? [], candidates)) return;
    fresh.candidates = withImages;
    // Den valda kandidaten är den enda vars sida annonsen ska byggas på — flytta över den hit så
    // fas 2 slipper leta i listan.
    const chosen = fresh.selected && withImages.find((c) => c.model === fresh.selected!.model);
    if (chosen) fresh.selected = { ...fresh.selected!, pageSpecs: chosen.pageSpecs, imageSource: chosen.imageSource };
    await persist(fresh);
  };

  void resolveCandidateImages(candidates, sources, publish)
    .then(async (withImages) => {
      await publish(withImages);
      const hits = withImages.filter((c) => c.imageUrl).length;
      const specced = withImages.filter((c) => c.pageSpecs?.length).length;
      console.info(
        `[identify] ${jobId.slice(0, 8)} bilder ${hits}/${withImages.length} specar ${specced}/${withImages.length}` +
          ` (källor: ${sources.map((sp) => sp.url.slice(0, 60)).join(", ") || "inga"})`,
      );
    })
    /**
     * Tyst var fel: när hämtningen föll stod fyra kandidater utan bild och ingenting sa varför.
     *
     * Och de stod inte bara utan bild — de stod utan BESKED. `undefined` betyder "letar fortfarande",
     * så väljarskärmen fortsatte visa skimrande platshållare för bilder som ingen längre letade efter,
     * ända tills klienten gav upp efter fem minuter. Ett fall är också ett svar: kandidaterna skrivs
     * med `null`, "ingen bild hittades", och skärmen slutar vänta.
     */
    .catch(async (err) => {
      console.warn(`[identify] ${jobId.slice(0, 8)} bildhämtningen föll — ${err instanceof Error ? err.message : err}`);
      await publish(candidates.map((c) => ({ ...c, imageUrl: c.imageUrl ?? null }))).catch(() => {});
    });
}

/**
 * Fas 1: vilken modell är det här?
 *
 * Körs parallellt med skickbedömningen så fort bilderna finns. Besiktningen behöver inte modellen och
 * identifieringen behöver inte betyget — de två spåren delar bara bildrutorna, så att kedja dem hade
 * lagt 6-11 sekunder ovanpå i stället för bredvid.
 *
 * Svarar generatorn med kandidater stannar flödet och väntar på säljaren. Kunde den avgöra modellen
 * själv (stark toppkandidat utan verklig konkurrens) hoppas valskärmen över helt — den finns för
 * VERKLIG tvetydighet, inte för varje möbel.
 */
export async function runIdentify(jobId: string, brand: string, images: CapturedImage[]): Promise<void> {
  const dir = jobDir(jobId);
  const startedAt = Date.now();

  /**
   * Ett nytt försök när sökningen inte kom tillbaka grundad.
   *
   * Felet är inte en timeout utan att modellen ibland avstår från att söka: den svarar snabbt, med
   * `sources=0`. Mätt över fyra körningar i rad gav två stycken tre kandidater vardera medan två gav
   * noll, med samma bilder och samma märke. Generatorn räddar numera kandidaterna ur även en sådan
   * körning, men inte källorna — och det är källorna omförsöket är till för.
   *
   * Vi har råd att fråga igen: identifieringen löper parallellt med skickbedömningen, som tar 20-40 s
   * ändå. Ett andra försök kostar alltså ingenting på kritiska vägen. Ett, inte fler — svarar den
   * likadant två gånger är det inte slumpen längre, och då ska säljaren få skriva namnet själv i
   * stället för att vänta på ett tredje.
   *
   * FÖRSÖKEN KÖRS I SERIE, aldrig bredvid varandra. Att överlappa dem gjorde väntan kortare på
   * papperet men lät två grundade sökningar på samma nyckel gå samtidigt — och den grundade sökningen
   * är känslig nog att det slog ut kandidaterna helt. Samma sorts känslighet som bildtaket: se
   * `MAX_LISTING_IMAGES` i listing.ts, där 6 bildrutor i stället för 3 tog kandidaterna i 8 fall av 10.
   * Latens får inte köpas med den här sökningens träffsäkerhet.
   */
  const call = await searchCandidates(jobId, brand, images, dir);
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return;

  if (call.kind === "needs_selection") {
    job.identityStatus = "needs_selection";
    job.candidates = call.candidates;
    // Sparas för fas 2. Sökningen där kommer tillbaka tom i två fall av tre på den här vägen, och
    // då är det här underlaget det enda belagda som finns.
    job.identityResearch = { researchText: call.researchText, sources: call.sources };
    console.info(
      `[identify] ${jobId.slice(0, 8)} needs_selection candidates=${call.candidates.length}` +
        ` sources=${call.sources.length} ms=${Date.now() - startedAt}`,
    );
    await persist(job);

    attachCandidateImages(jobId, call.candidates, call.sources);
    return;
  } else if (call.kind === "ok") {
    /**
     * Generatorn kom fram till ett svar utan att kunna erbjuda kandidater — numera bara när varken
     * den grundade eller den ogrundade texten bar en enda KANDIDAT-rad.
     *
     * Vi accepterar det inte som fastställt. Ett modellnamn den inte kunde belägga mot en källa är en
     * gissning, och att visa en gissning som "din modell" är sämre än att fråga. Har den ändå fått
     * fram något namn erbjuds det som en kandidat; annars får säljaren skriva själv.
     */
    const r = call.listing.result;
    const guessed = r?.identity.exactProduct?.trim();
    job.identityStatus = "needs_selection";
    const warnings = r?.warnings ?? [];
    job.identityError = identityNote(warnings);
    job.candidates = guessed
      ? [{
          brand: r!.identity.brand ?? brand,
          model: guessed,
          variant: r!.identity.variant,
          productType: r!.identity.category,
          confidence: r!.identity.confidence === "high" ? "strong" : r!.identity.confidence === "medium" ? "likely" : "possible",
          distinguishingDetail: r!.identity.uncertaintyNote,
        }]
      : [];
    console.info(
      `[identify] ${jobId.slice(0, 8)} no-candidates (research föll) guessed=${guessed ?? "-"}` +
        ` varningar=${warnings.join("|") || "inga"} ms=${Date.now() - startedAt}`,
    );
    /**
     * Också gissningen ska få sin bild — och framför allt sitt besked.
     *
     * Den här grenen skrev en kandidat men startade aldrig någon bildhämtning, och `imageUrl` blev
     * därmed stående som `undefined`: "letar fortfarande". Ingen letade. Väljarskärmen visade en
     * skimrande platshållare och pollade i fem minuter efter en bild som ingen hade beställt — den
     * enda vägen där laddningen bokstavligen var oändlig.
     *
     * Sidorna är annonsens egna källor. De är tunnare här än på kandidatvägen, för det var just
     * grundningen som föll, men de är vad som finns — och en gissning behöver bilden MEST: säljaren
     * ska kunna se med en gång att namnet inte stämmer.
     */
    await persist(job);
    if (job.candidates.length > 0) attachCandidateImages(jobId, job.candidates, r?.sources ?? []);
    return;
  } else {
    job.identityStatus = "unavailable";
    job.identityError = call.reason;
    console.warn(`[identify] ${jobId.slice(0, 8)} unavailable — ${call.reason}`);
  }
  await persist(job);
}

/**
 * "Vi hittade inga modeller" är inte samma sak som "vi kunde inte söka".
 *
 * Är AI-tjänsten överbelastad faller båda generatoranropen på ett par hundra millisekunder, båda
 * kandidatförsöken med dem, och säljaren landade på en tom valskärm som lade skulden på möbeln: inga
 * förslag, ingen förklaring, och en uppmaning att skriva namnet själv. Generatorn säger i sina
 * `warnings` vilket av de två fallen det var, och den skillnaden ska stå på skärmen — inte gissas
 * fram av den som väntar.
 *
 * `null` när sökningen faktiskt blev av. Då är den tomma listan ett riktigt svar, och en rad som
 * ursäktar sig hade bara sått tvivel om ett besked som stämmer.
 */
export function identityNote(warnings: string[]): string | null {
  if (warnings.includes("model_overloaded")) {
    return (
      "AI-tjänsten är hårt belastad just nu, så modellsökningen blev aldrig av." +
      " Försök igen om en stund, eller skriv modellnamnet själv om du vet det."
    );
  }
  if (warnings.includes("research_failed") || warnings.includes("structure_failed")) {
    return (
      "Modellsökningen kom inte fram den här gången — det är ett fel i vårt led, inte i dina bilder." +
      " Försök igen, eller skriv modellnamnet själv om du vet det."
    );
  }
  return null;
}

/** Namnet som skickas som förbud till sökningen, och som jämförs mot när svaret kommer tillbaka. */
const fullName = (c: ModelCandidate) => [c.brand, c.model].filter(Boolean).join(" ").trim();

/**
 * Sista spärren mot att ett avfärdat förslag kommer tillbaka.
 *
 * Sållningen görs redan i generatorns egen kandidatläsning, och där med en tolerantare regel (se
 * `parseCandidates`). Den här är exakt och trubbig med flit: den finns bara för att ett förslag
 * säljaren just sagt nej till aldrig ska nå skärmen igen om det mot förmodan slinker igenom där.
 */
const wasRejected = (c: ModelCandidate, rejected: ModelCandidate[]) => {
  const key = fullName(c).toLowerCase();
  return rejected.some((r) => fullName(r).toLowerCase() === key);
};

/**
 * "Ingen av dem" — säljaren avfärdar hela listan och ber om fyra andra.
 *
 * Alla fyra kan vara fel. Möbeln finns då fortfarande i varumärkets sortiment, bara inte bland de
 * namn den här körningen råkade hitta, och utan den här vägen var säljarens enda utväg att skriva ett
 * modellnamn de per definition inte känner till — de tittar ju på möbeln utan att veta vad den heter.
 *
 * De avfärdade förslagen sparas på jobbet och följer med som förbudslista. Det är hela poängen: ett
 * omval som ger tillbaka samma fyra namn är inte ett nytt försök, det är samma återvändsgränd en
 * gång till.
 *
 * Anroparen inväntar BARA att jobbet flippat till sökläge — sedan svarar den 202 och sökningen löper
 * vidare i bakgrunden, precis som den första omgången. Skärmen får sin väntan att visa direkt, och
 * klientens pollning hittar de nya förslagen när de landar.
 */
export async function findMoreCandidates(jobId: string): Promise<{ ok: true } | { error: string }> {
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return { error: "Job not found" };
  // Efter valet är fas 2 igång: annons och pris byggs på modellen, och en ny kandidatlista har
  // ingenstans att ta vägen.
  if (job.identityStatus === "resolved") return { error: "Modellen är redan vald." };
  if (job.identityStatus === "identifying") return { error: "Sökningen pågår redan." };
  const brand = job.identity?.brand?.trim();
  if (!brand) return { error: "Inget märke att söka på." };
  const images = job.images ?? job.result?.images ?? [];
  if (images.length === 0) return { error: "Jobbet har inga sparade bildrutor att söka på." };

  const seen = new Set<string>();
  const rejected = [...(job.rejectedCandidates ?? []), ...(job.candidates ?? [])].filter((c) => {
    const key = fullName(c).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  job.rejectedCandidates = rejected;
  job.candidates = [];
  job.candidateRound = (job.candidateRound ?? 0) + 1;
  job.identityStatus = "identifying";
  job.identityError = null;
  await persist(job);

  void runCandidateRound(jobId, brand, images, rejected).catch((err) => {
    console.warn(`[identify] ${jobId.slice(0, 8)} omval föll — ${err instanceof Error ? err.message : String(err)}`);
  });
  return { ok: true };
}

/** Så många förslag ett omval ska lämna. Fyra, precis som den första omgången. */
const CANDIDATES_PER_ROUND = 4;

/**
 * Hur många sökningar ett omval får göra för att fylla de fyra platserna.
 *
 * EN sökning räcker sällan. Modellen får de avfärdade namnen i prompten och skriver ändå tillbaka
 * flera av dem; de sållas bort i kod, och kvar stod ett enda nytt förslag ur en omgång som utgav sig
 * för att bära fyra. Det syns i det sparade jobbet med tre omval (Savo-stolen under
 * `server/data/jobs`): 4 nya namn i första omgången, 2 i andra, 1 i tredje — inte för att
 * sortimentet tog slut, utan för att den upprepade sig.
 *
 * Alltså söker omgången om tills platserna är fyllda, med de redan hittade tillagda i förbudslistan
 * så nästa sökning tvingas leta någon annanstans. Taket är tre sökningar i serie: var och en kostar
 * 6-9 sekunder grundad sökning, och säljaren står och väntar på skärmen medan de löper. Fyller den
 * första sökningen alla fyra platserna görs bara den — det vanliga fallet blir inte långsammare.
 */
const MAX_ROUND_SEARCHES = 3;

/** Vad en omvalsomgång bär med sig tillbaka. */
type CandidateRound = {
  /** Upp till fyra förslag som varken säljaren avfärdat eller omgången redan lämnat. */
  candidates: ModelCandidate[];
  /** Källorna från ALLA sökningar i omgången — bildhämtningen ska kunna slå upp varenda kandidat. */
  sources: SourceRef[];
  /** Underlaget till fas 2: den första grundade sökningens text och egna källor, eller inget. */
  research: { researchText: string; sources: SourceRef[] } | null;
  /** Skälet från en fallen sökning. Värt att visa bara när omgången blev helt tom. */
  error: string | null;
  searches: number;
};

/**
 * Fyll fyra platser med förslag säljaren INTE redan sagt nej till.
 *
 * Sökningen skickas in som funktion: hela regeln — hur många gånger, med vilken förbudslista, och
 * när det är läge att sluta — går därmed att köra utan generator.
 *
 * Omgången söker vidare av två skäl, aldrig fler: platserna är inte fyllda, eller ingen sökning har
 * kommit tillbaka grundad. Det andra är samma omförsök som första omgången gör (se
 * `searchCandidates`) — förslag får läsas ur ogrundad text, men fas 2 ärver bara belagt underlag.
 */
export async function collectNewCandidates(
  rejected: ModelCandidate[],
  search: (rejectedNames: string[], listedNames: string[]) => Promise<SellerCall>,
  stillWanted: () => boolean = () => true,
): Promise<CandidateRound> {
  const rejectedNames = rejected.map(fullName).filter(Boolean);
  const candidates: ModelCandidate[] = [];
  const sources: SourceRef[] = [];
  let research: CandidateRound["research"] = null;
  let error: string | null = null;
  let searches = 0;

  while ((candidates.length < CANDIDATES_PER_ROUND || !research) && searches < MAX_ROUND_SEARCHES) {
    // Bara mellan sökningarna: säljaren kan ha skrivit namnet själv medan den förra löpte, och då
    // finns det ingen kvar som väntar på de här förslagen.
    if (searches > 0 && !stillWanted()) break;
    searches++;
    // De två listorna hålls isär hela vägen ut i prompten: det säljaren avfärdat är fel möbler, det
    // omgången själv hittat är bara upptagna platser. Båda sållas bort ur svaret.
    const call = await search(rejectedNames, candidates.map(fullName).filter(Boolean));

    if (call.kind === "unavailable") {
      error = call.reason;
      // Hellre de förslag vi redan har än ännu en väntan på en generator som just föll.
      if (candidates.length > 0) break;
      continue;
    }
    // `ok` betyder att generatorn byggde en annons i stället för att föreslå — den svarar så bara
    // utan förbudslista, alltså aldrig här. Landar den ändå är svaret på "hitta nya" förslag.
    if (call.kind !== "needs_selection") continue;

    error = null;
    for (const c of call.candidates) {
      if (candidates.length >= CANDIDATES_PER_ROUND) break;
      // Sållningen görs redan i generatorns kandidatläsning, och där tolerantare. Den här fångar
      // dessutom dubbletterna MELLAN sökningarna i samma omgång.
      if (wasRejected(c, rejected) || wasRejected(c, candidates)) continue;
      candidates.push(c);
    }
    for (const s of call.sources) if (!sources.some((x) => x.url === s.url)) sources.push(s);
    // Fas 2 ärver EN sökning, aldrig tre hopklistrade: den första grundade. Text om fyra andra
    // modeller hade gett annonsen mått som hör till någon annan möbel.
    if (!research && call.sources.length > 0) research = { researchText: call.researchText, sources: call.sources };
  }

  return { candidates, sources, research, error, searches };
}

/** Själva omvalssökningen. Skriver alltid tillbaka ett `needs_selection` — även när den blev tom. */
async function runCandidateRound(
  jobId: string,
  brand: string,
  images: CapturedImage[],
  rejected: ModelCandidate[],
): Promise<void> {
  const startedAt = Date.now();
  const dir = jobDir(jobId);
  const round = await collectNewCandidates(
    rejected,
    (rejectedNames, listedNames) => callSellerGenerate(brand, images, dir, undefined, undefined, rejectedNames, listedNames),
    // Avbryt mellan sökningarna om säljaren hunnit avgöra identiteten själv. Saknas jobbet i
    // minnet är det inget besked om att valet är gjort — då fortsätter omgången.
    () => (getJobSync(jobId)?.identityStatus ?? "identifying") === "identifying",
  );
  const found = round.candidates;

  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return;
  // Säljaren kan ha skrivit namnet själv medan sökningen pågick. Då är identiteten avgjord, och en
  // lista som landar efteråt får inte välta den.
  if (job.identityStatus !== "identifying") return;

  job.candidates = found;
  job.identityStatus = "needs_selection";
  // Underlaget byts bara mot ett som faktiskt bär något: en tom omgång får inte kasta de källor den
  // första gav, för det är dem fas 2 ärver när dess egen sökning kommer tillbaka tom.
  if (found.length > 0 && round.research) job.identityResearch = round.research;
  // Att inte hitta fler modeller är inget fel — det är ett svar, och skärmen säger det med sin egen
  // text. Bara en fallen generator är värd en varningsrad, och bara när den lämnade skärmen tom:
  // med fyra förslag uppe är en ursäkt för en sökning som föll däremellan bara brus.
  if (found.length === 0 && round.error) job.identityError = round.error;
  await persist(job);

  console.info(
    `[identify] ${jobId.slice(0, 8)} omval=${job.candidateRound ?? 1} nya=${found.length}` +
      ` sökningar=${round.searches} avfärdade=${rejected.length} ms=${Date.now() - startedAt}`,
  );

  if (found.length > 0) attachCandidateImages(jobId, found, round.sources);
}

/**
 * Fas 2: säljaren har valt. Bygg annonsen på den modellen, och prissätt.
 *
 * Priset ligger sist med flit. Prismotorn söker på modellnamnet och drar av för skadorna, så den
 * behöver BÅDA de andra spåren klara — det är den enda punkt i flödet där de möts.
 */
export async function finalizeWithModel(jobId: string, resolution: Resolution): Promise<void> {
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return;
  const images = job.images ?? job.result?.images ?? [];
  const dir = jobDir(jobId);
  const startedAt = Date.now();

  const model =
    resolution.kind === "seller_selected" ? resolution.selected.model : resolution.kind === "manual" ? resolution.manualModel : "";
  const brand = job.identity?.brand ?? (resolution.kind === "seller_selected" ? resolution.selected.brand : null);
  job.identity = { brand, model };
  job.selected = resolution.kind === "seller_selected" ? resolution.selected : null;
  job.identityStatus = "resolved";
  // Bar kandidaten säljaren valde redan sin produktbild är omslaget klart här, utan en enda hämtning
  // till — det är samma bild de nyss pekade på. Annars hämtas ett omslag längre ned.
  job.productImage = job.selected?.imageUrl
    ? { url: job.selected.imageUrl, sourceUrl: job.selected.imageSource ?? null }
    : null;
  await persist(job);

  /**
   * Annonsen och priset körs PARALLELLT.
   *
   * De behöver inte varandra: annonsen byggs på modellen och bilderna, priset på modellen och
   * skadelistan. Kedjade betydde det att prissättningen inte ens började förrän annonsen var klar —
   * alltså stod den still i 13-20 sekunder medan säljaren läste specifikationerna, för att sedan ta
   * sina 10 sekunder när de klickade vidare. Nu löper de bredvid varandra, och priset är oftast
   * färdigt innan säljaren lämnar specifikationsskärmen.
   */
  /**
   * Specifikationerna hämtas om när måtten saknas.
   *
   * Mätt över sex körningar: när den grundade sökningen gav källor kom måtten fram (Bredd 81, Djup 92,
   * Höjd 80-82, Sitthöjd 44), och när den gav noll källor kom ingenting alls. Det är samma sviktande
   * sökning som fäller kandidaterna, och samma botemedel — fråga en gång till.
   *
   * Måtten är det enda vi provar om på. Material och nypris saknas ibland av en verklig anledning:
   * uppgiften finns inte publicerad. Måtten finns alltid publicerade någonstans, så saknas de har
   * sökningen misslyckats snarare än letat förgäves.
   */
  const prior = job.identityResearch ?? undefined;

  /**
   * Specifikationerna från den valda kandidatens produktsida, som de ser ut JUST NU.
   *
   * Läses om vid varje användning med flit. Sidhämtningen startade när kandidaterna visades och tar
   * upp till åtta sekunder; en säljare som väljer direkt hinner före den. Att läsa från jobbet i
   * stället för från det val som kom in med anropet betyder att en sida som landar under tiden
   * annonsen byggs ändå kommer med.
   */
  const freshPageSpecs = async (): Promise<ListingAttribute[]> => {
    const fresh = getJobSync(jobId) ?? (await getJob(jobId));
    const selected = fresh?.selected?.model === model ? fresh.selected : null;
    const listed = fresh?.candidates?.find((c) => c.model === model);
    return selected?.pageSpecs ?? listed?.pageSpecs ?? [];
  };

  /**
   * Annonsen plus det produktsidan själv skrev ut.
   *
   * Sökningens egna fynd rörs aldrig — skörden fyller bara luckor. Mätt på 78 skarpa annonser: de 52
   * som fick källor hade mått i 46 fall, medan de 26 utan källor hade mått i ETT. Det är den luckan
   * det här stänger, och den stängs utan ett enda extra anrop.
   */
  const withPageSpecs = <T extends { result: { attributes: ListingAttribute[] } | null }>(
    listing: T,
    specs: ListingAttribute[],
  ): T => {
    if (!listing.result || specs.length === 0) return listing;
    const attributes = mergeSpecs(listing.result.attributes, specs);
    return attributes === listing.result.attributes ? listing : { ...listing, result: { ...listing.result, attributes } };
  };

  const generateOnce = () =>
    callSellerGenerate({ brand, model }, images, dir, resolution, prior).then((call) =>
      call.kind === "ok"
        ? call.listing
        : {
            status: "unavailable" as const,
            unavailableReason: call.kind === "unavailable" ? call.reason : "Oväntat kandidatsvar i fas 2.",
            result: null,
            latencyMs: Date.now() - startedAt,
          },
    );

  // Uppskattade mått räknas inte som fynd. Annonsen bär dem alltid numera, och läste villkoret dem
  // som mått hade omförsöket — det som faktiskt hämtar hem de riktiga måtten — aldrig kört igen.
  const hasDimensions = (l: Awaited<ReturnType<typeof generateOnce>>) =>
    !!l.result?.attributes.some((a) => !a.estimated && /(mått|bredd|djup|höjd|längd|diameter|sitthöjd|sitsdjup)/i.test(a.label));

  /**
   * Upp till tre försök, bundna av en väggklocka.
   *
   * Ett omförsök räckte inte. Mätt på samma stol, samma sex bildrutor, sexton minuter isär: en körning
   * gav sex källor och alla mått, nästa dog på `network error: fetch failed` och omförsöket slog i
   * 24-sekundersbudgeten. Två olika fel i rad, båda utanför modellen — och då finns inget att lära av
   * att ge upp efter det andra.
   *
   * Budgeten finns för att spåret ändå löper parallellt med skickbedömningen: så länge den håller på
   * kostar ett försök till ingenting, men den får inte bli det som håller kortet.
   */
  const RETRY_BUDGET_MS = 55_000;
  /** Ett nytt försök är bara meningsfullt om det hinner bli klart. */
  const MIN_TIME_FOR_ATTEMPT_MS = 20_000;

  /**
   * Publicera FÖRSTA svaret direkt, försök vidare i bakgrunden.
   *
   * Omförsöken låg tidigare före publiceringen, så säljaren väntade ut allihop: när sökningen
   * timeoutar bränner varje försök hela sin 24-sekundersbudget, och tre försök blev 75 sekunders
   * "Bygger annonsen…" innan något alls visades. Nu visas annonsen så fort det finns en, och måtten
   * fylls i om ett senare försök hittar dem — samma mönster som delresultatet i skickbedömningen.
   */
  const publish = async (listing: Awaited<ReturnType<typeof generateOnce>>, improving: boolean) => {
    const job = getJobSync(jobId) ?? (await getJob(jobId));
    if (!job) return;
    job.identity = { brand, model };
    // Märkt med om fler försök kan komma. Klienten slutar polla först när den ser `improving: false`,
    // annars fastnar skärmen på det första svaret medan ett bättre skrivs in bakom den.
    const marked = { ...listing, improving };
    if (job.result) job.result.listing = marked;
    else job.pendingListing = marked;
    await persist(job);
  };

  /** Kommer slingan nedan att göra ett försök till? Samma villkor som dess `break`. */
  const moreToCome = (l: Awaited<ReturnType<typeof generateOnce>>, until: number) =>
    !hasDimensions(l) && until - Date.now() >= MIN_TIME_FOR_ATTEMPT_MS;

  const listingPromise = (async () => {
    const until = Date.now() + RETRY_BUDGET_MS;
    const enrich = async <T extends { result: { attributes: ListingAttribute[] } | null }>(listing: T) =>
      withPageSpecs(listing, await freshPageSpecs());
    let best = await enrich(await generateOnce());
    await publish(best, moreToCome(best, until));
    console.info(
      `[identify] ${jobId.slice(0, 8)} väg=${resolution.kind} listing=${best.status} mått=${hasDimensions(best)}` +
        ` medskickade_källor=${prior?.sources.length ?? 0} källor=${best.result?.sources?.length ?? 0} ms=${Date.now() - startedAt}`,
    );

    for (let attempt = 2; attempt <= 3; attempt++) {
      // Starta inte ett försök som ändå inte hinner klart — 24 sekunders säker väntan i onödan.
      if (hasDimensions(best) || until - Date.now() < MIN_TIME_FOR_ATTEMPT_MS) break;
      console.info(`[identify] ${jobId.slice(0, 8)} inga mått — försök ${attempt} av 3 i bakgrunden`);
      const next = await enrich(await generateOnce());
      // Bara belagda attribut räknas. De uppskattade måtten följer med varje försök och säger inget om
      // vilket av dem som fick veta mest — de hade bara gjort jämförelsen till en fråga om möbeltyp.
      const count = (l: typeof best) => l.result?.attributes.filter((a) => !a.estimated).length ?? 0;
      if (hasDimensions(next) || count(next) > count(best)) {
        best = next;
        await publish(best, moreToCome(best, until));
      }
    }
    // Sista ordet, alltid skrivet: slingan kan ha slutat utan att publicera (försöket blev inte bättre),
    // och då står `improving: true` kvar på jobbet med ingen som någonsin tar bort det. Skörden läses
    // om en sista gång — sidan kan ha landat medan det sista försöket kördes.
    best = await enrich(best);
    await publish(best, false);
    return { ...best, improving: false };
  })();

  /**
   * Priset skrivs in i jobbet SÅ FORT prismotorn svarat.
   *
   * DET HÄR VAR FELET bakom "priset kommer först på annonsen": de två spåren KÖRDE parallellt men
   * PUBLICERADES seriellt. Priset låg kvar i sitt löfte tills `await listingPromise` släppt igenom, och
   * annonsspåret får försöka tre gånger efter mått inom en budget på 55 sekunder. Mätt på 98 sparade
   * jobb tar prisanropet 15 s (median, p90 32 s) och ett annonsanrop 14 s (p90 22 s) — men prisskärmen
   * fick vänta ut hela omförsöksslingan, inte sitt eget anrop.
   *
   * Skrivningen hör hemma i spåret som räknar fram talet. Annonsen har sin egen (se `publish`), och den
   * ena ska inte kunna hålla den andra.
   */
  const pricePromise = (async () => {
    // Priset behöver skadelistan. Skickbedömningen kör i sitt eget spår och kan mycket väl vara klar.
    const ready = await waitForCondition(jobId);
    if (!ready?.result) return null;
    /**
     * Spekulationen först: prismotorn kan redan ha räknat fram exakt det här talet parallellt med
     * granskningen. Gäller den både modellen säljaren valde och den slutliga skadelistan är svaret
     * säljarens — annars faller vi tillbaka på anropet som alltid gjorts här.
     */
    const signature = pricingSignature(ready.result.damages, ready.result.grade?.canonicalCondition ?? null);
    const speculated = await takeSpeculativePrice(jobId, { brand, model }, signature);
    const price =
      speculated ??
      (await estimatePrice(
        { brand, model },
        ready.result.damages,
        ready.result.grade?.canonicalCondition ?? null,
        null,
      ));
    const target = getJobSync(jobId) ?? (await getJob(jobId));
    if (target?.result) {
      target.result.price = price;
      target.result.identity = { brand, model };
      await persist(target);
    }
    console.info(`[identify] ${jobId.slice(0, 8)} price=${price?.status ?? "none"} spekulerat=${speculated ? "ja" : "nej"} ms=${Date.now() - startedAt}`);
    return price;
  })();

  // Publicera annonsen så fort DEN är klar — säljaren ska inte vänta in priset för att se
  // specifikationerna.
  const listing = await listingPromise;
  console.info(`[identify] ${jobId.slice(0, 8)} listing=${listing.status} ms=${Date.now() - startedAt}`);

  /**
   * Omslaget, när kandidatvalet inte redan gav ett.
   *
   * Startas HÄR för att annonsens källor först nu finns — det är de sidorna sökningen belagt modellen
   * mot, alltså de troligaste att bära dess produktbild.
   *
   * Skrivs in för sig, inte tillsammans med priset. En kall butikssida får åtta sekunder på sig, och
   * att lägga den väntan framför prisskrivningen hade gjort en bild till något priset står och väntar
   * på. Omslaget behövs på annonsskärmen, priset redan på skärmen före.
   */
  void (job.productImage
    ? Promise.resolve({ image: job.productImage as ProductImage, specs: [] as ListingAttribute[] })
    : resolveProductPage({ brand, model }, listing.result?.sources ?? [])
  )
    .then(async ({ image, specs }: { image: ProductImage | null; specs: ListingAttribute[] }) => {
      const withCover = getJobSync(jobId) ?? (await getJob(jobId));
      if (!withCover) return;
      // Skrivs på JOBBET även när besiktningen ännu inte lämnat något resultat att hänga det på.
      // completeJob flyttar in det när den gör det — samma väg som annonsen tar.
      withCover.productImage = image;
      if (withCover.result) withCover.result.productImage = image;
      /**
       * Sidan gav mer än ett omslag.
       *
       * Det här är manual-vägens enda produktsida: säljaren skrev modellnamnet själv, så det fanns
       * ingen kandidat vars sida kunde hämtas i förväg. Hämtningen sker ändå för bildens skull, och
       * måtten står på samma sida. Skrivs in i den annons som redan ligger på jobbet — den är
       * publicerad, och kompletteras här på samma sätt som ett sent omförsök gör.
       */
      const current = withCover.result?.listing ?? withCover.pendingListing ?? null;
      if (specs.length > 0 && current?.result) {
        current.result.attributes = mergeSpecs(current.result.attributes, specs);
      }
      await persist(withCover);
      console.info(
        `[identify] ${jobId.slice(0, 8)} omslag=${image ? new URL(image.url).hostname : "inget"}` +
          ` sidspecar=${specs.map((sp) => sp.label).join("/") || "inga"} ms=${Date.now() - startedAt}`,
      );
    })
    .catch(() => {});

  const afterListing = getJobSync(jobId) ?? (await getJob(jobId));
  if (afterListing) {
    afterListing.identity = { brand, model };
    if (afterListing.result) afterListing.result.listing = listing;
    else afterListing.pendingListing = listing;
    await persist(afterListing);
  }

  // Priset är redan inskrivet av sitt eget spår ovan. Väntan här är på att fas 2 ska vara slut, inte
  // på något som ska publiceras: den sista skrivningen finns för att annonsen kan ha landat i
  // `pendingListing` innan skickresultatet fanns, och ska flyttas in när det gör det.
  await pricePromise;
  const target = getJobSync(jobId) ?? (await getJob(jobId));
  if (!target?.result) return;
  target.result.identity = { brand, model };
  target.result.listing = listing;
  await persist(target);
  console.info(`[identify] ${jobId.slice(0, 8)} fas2 klar total_ms=${Date.now() - startedAt}`);
}

async function waitForCondition(jobId: string) {
  const until = Date.now() + CONDITION_WAIT_MS;
  while (Date.now() < until) {
    const job = getJobSync(jobId) ?? (await getJob(jobId));
    if (!job) return null;
    if (job.progress.stage === "error") return null;
    if (job.result && !job.result.reviewPending) return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
