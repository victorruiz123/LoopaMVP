import path from "node:path";
import { stat } from "node:fs/promises";
import { callSellerGenerate, type Resolution, type SellerCall } from "../listing.js";
import { byggAnnons, byggAnnonsFranFakta } from "./annons.js";
import { IDENTIFY_DEADLINE_MS } from "../research/config.js";
import { allowanceFor, costOf, withCostScope } from "../cost/jobCost.js";
import { budgetStatus, canSpend } from "../cost/ledger.js";
import { markIncomplete, setTask } from "./tasks.js";
import { researchEnabled } from "../research/config.js";
import { Deadline } from "../research/deadline.js";
import { identifyFurniture, prepareImages, toModelCandidates, toSourceRefs } from "../research/pipeline.js";
import { beslutaEfterForskning, noteForEmptyResearch } from "./identifieringsval.js";
import { hamtaVarianter } from "./varianter.js";
import { resolveCandidateImages, resolveProductPage, type SourceRef } from "../candidateImages.js";
import { fargForAnnons, fargerI } from "./farg.js";
import { mergeSpecs } from "../specHarvest.js";
import { mattminnetsRader } from "../mattminne.js";
import { getJob, getJobSync, jobDir, persist } from "../jobStore.js";
import { lokalKandidatbild, registreradKandidatbild, registreraKandidatbilder } from "../kandidatbild.js";
import { beskrivningUr, losFranSokningar, losProduktsidor, referensKedjaPa, registerTyp, saljarbild, typOrd, unikaKallor, valMax, valjBland, type RefKandidat } from "../referensbild.js";
import { bedomReferensbild, typFranFoto, typfamilj } from "../candidateType.js";
import { pickReferenceRows, undertypForKandidat, valjReferensbild, type ReferenceCheck } from "../externalImages.js";
import { estimatePrice, pricingSignature, synkaStolpris, takeSpeculativePrice } from "../pricing.js";
import { kanVaraStol } from "../stolPris.js";
import { slugKey } from "../research/normalize.js";
import { cleanExternalLinks, mergeExternalSpec, pickModelPage, specHasFacts, structureExternalAnswer, structureExternalSpecs } from "../externalIdentify.js";
import { classifyAttribute, withKinds } from "../research/attributeKinds.js";
import type { IdentifyOk, ProductFacts, ResearchRunSummary } from "../research/types.js";
import type {
  CapturedImage,
  GeneratedListing,
  IdentityResult,
  ListingAttribute,
  ListingResult,
  ModelCandidate,
  ProductImage,
} from "../types.js";

/** Hur länge prissättningen väntar på att skickbedömningen ska bli klar. */
const CONDITION_WAIT_MS = 180_000;

/**
 * Specsökningar som är igång just nu, per jobb: ett variantval väntar in dem i stället för att söka om bredvid.
 *
 * (Här låg förut en FÖRVÄRMNING: fas 2 startades på toppkandidaten redan när valskärmen visades. Den är borttagen. Den var spekulativ
 * forskning — ett fullt specsanrop på en modell säljaren kanske inte väljer, ≈28 % av gångerna fel — och omgången har ett kostnadstak
 * (cost/ledger.ts). Specsökningen körs numera i bakgrunden från det att modellen är bekräftad, medan säljaren svarar på frågorna, granskar
 * skicket och prisförslaget; granskningen av måtten ligger sist i flödet, så ingen väntar på den.)
 */
const factsInFlight = new Map<string, { model: string; promise: Promise<ProductFacts | null> }>();

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
// Typvakt och inte bara ett villkor: ett grundat svar ÄR ett `needs_selection`, och den som frågat
// ska kunna läsa dess kandidater och källor utan att fråga om samma sak en gång till.
function settled(call: SellerCall): call is Extract<SellerCall, { kind: "needs_selection" }> {
  return call.kind === "needs_selection" && call.candidates.length > 0 && call.sources.length > 0;
}

/**
 * Pågående identifieringar, per jobb — så att en säljare som hinner före (skriver modellnamnet själv) kan stoppa ett betalt anrop som
 * ingen längre väntar på i stället för att låta det löpa ut och kosta.
 */
const pagaendeIdentifiering = new Map<string, AbortController>();

/** Avbryt jobbets pågående identifiering, om det finns en. Anropet stänger sin ström; det som hunnit kosta är redan bokfört. */
export function avbrytIdentifiering(jobId: string): boolean {
  const ac = pagaendeIdentifiering.get(jobId);
  if (!ac) return false;
  ac.abort();
  return true;
}

/** Minsta antal sökfrågor ett (nytt) identifieringsförsök måste kunna få för att vara värt att starta. Under det: inget betalt anrop. */
export const MIN_IDENTIFY_QUERIES = 3;

/** Ett ärligt tomt svar: inga kandidater, ett besked, och varför. Det enda som visas när forskningen inte gav något. */
function arligtTomt(result: IdentityResult, note: string | null, runSummary?: ResearchRunSummary | null): Extract<SellerCall, { kind: "needs_selection" }> {
  return {
    kind: "needs_selection",
    candidates: [],
    sources: [],
    researchText: "",
    engine: "gemini3",
    exactMatch: false,
    note,
    runSummary: runSummary ?? undefined,
    result,
  };
}

/** Forskningens svar som appens eget: kandidater, källor, underlag till fas 2. */
function sellerCallFranForskning(out: IdentifyOk): Extract<SellerCall, { kind: "needs_selection" }> {
  const candidates = toModelCandidates(out);
  return {
    kind: "needs_selection",
    candidates,
    sources: toSourceRefs(out.sources),
    researchText: out.researchText,
    engine: "gemini3",
    exactMatch: out.exactMatch,
    note: candidates.length === 0 ? noteForEmptyResearch(out.uncertaintyNote) : null,
    runSummary: out.summary,
    result: candidates.length > 0 ? "candidates" : "no_match",
  };
}

/**
 * Produktforskningens identifiering (server/src/research): alla bildrutor i full kvalitet, en stark modell som får tänka, söka och
 * öppna produktsidor, och ett strukturerat svar med evidens per kandidat.
 *
 * ANROPET FÅR TID ATT BLI KLART, inte en säljarklocka: säljaren väntar inte på det — skicket, frågorna och prisskärmen går att göra
 * medan det pågår, och kandidaterna visas när de finns. Det som BEGRÄNSAR det är (1) kostnadsbudgeten: söktaket kommer ur jobbets
 * kostnadsbok (cost/ledger.ts) och är det som håller omgången under sitt tak, och (2) en livslängd som skydd mot ett anrop som hänger sig
 * (IDENTIFY_DEADLINE_MS, research/deadline.ts) — inte en timer att tävla mot.
 *
 * Svarar med vad beslutsregeln (identifieringsval.ts) säger: forskningens eget svar — även när det är tomt — eller ett ärligt
 * besked utan kandidater. ALDRIG den gamla generatorn som reserv. `null` bara när forskningen är avstängd med LOOPA_RESEARCH_ENGINE=legacy.
 */
async function identifieraMedForskning(
  jobId: string,
  brand: string,
  images: CapturedImage[],
  dir: string,
  excludeModels: string[] = [],
  alreadySuggested: string[] = [],
): Promise<SellerCall | null> {
  if (!researchEnabled()) return null;
  const label = jobId.slice(0, 8);
  const deadline = new Deadline(IDENTIFY_DEADLINE_MS);
  const abort = new AbortController();
  pagaendeIdentifiering.set(jobId, abort);
  try {
    // Söktaket ur kostnadsboken. Ett försök som budgeten inte rymmer startas inte: inget betalt arbete utan utrymme.
    const allowance = await allowanceFor(jobId, "identify");
    if (allowance.searchQueries < MIN_IDENTIFY_QUERIES) {
      console.warn(`[identify] ${label} budgeten rymmer ${allowance.searchQueries} sökfrågor (minst ${MIN_IDENTIFY_QUERIES} krävs) — inget nytt försök`);
      return arligtTomt("unavailable", "Kostnadstaket för den här omgången är nått, så modellsökningen görs inte om. Skriv modellnamnet själv, eller starta en ny analys.", null);
    }
    const researchImages = await prepareImages(images, dir);
    const prepareMs = deadline.elapsed();
    const out = await identifyFurniture(
      { brand, images: researchImages, excludeModels, alreadySuggested, label, prepareMs, maxSearchQueries: allowance.searchQueries },
      { deadline, signal: abort.signal },
    );
    const beslut = beslutaEfterForskning(out);
    if (out.kind !== "ok") {
      console.warn(`[identify] ${label} forskningen gav inget svar (${out.failKind ?? "okänt"}): ${out.reason} → ärligt besked, ingen generator`);
      if (beslut.use === "none") return arligtTomt(beslut.result, beslut.note, out.summary);
      return arligtTomt("unavailable", null, out.summary);
    }
    const call = sellerCallFranForskning(out);
    console.info(
      `[identify] ${label} forskning: kandidater=${call.candidates.length} exakt=${out.exactMatch}` +
        ` modell=${out.trace.model} sökfrågor=${out.summary.searchQueries}/${allowance.searchQueries} sidor=${out.summary.fetchedPages}` +
        ` källor=${out.sources.length} cost${out.summary.costIsLowerBound ? "≥" : "≈"}$${out.summary.costUsd} ms=${deadline.elapsed()}/${deadline.totalMs}`,
    );
    return call;
  } catch (err) {
    // Ett oväntat fel i forskningens egen kod. Inte heller det fylls igen av den gamla generatorn.
    console.warn(`[identify] ${label} forskningen kastade — ${err instanceof Error ? err.message : String(err)}`);
    return arligtTomt("unavailable", null);
  } finally {
    if (pagaendeIdentifiering.get(jobId) === abort) pagaendeIdentifiering.delete(jobId);
    deadline.dispose();
  }
}

/**
 * Forskningen först; generatorn bara när beslutsregeln säger det. Samma signatur som generatorns egen
 * kandidatsökning, så att omvalsrundan och förstaomgången kan använda den utan att veta skillnaden.
 */
async function sokKandidater(
  jobId: string,
  brand: string,
  images: CapturedImage[],
  dir: string,
  excludeModels: string[] = [],
  alreadySuggested: string[] = [],
): Promise<SellerCall> {
  const nytt = await identifieraMedForskning(jobId, brand, images, dir, excludeModels, alreadySuggested);
  if (nytt) return nytt;
  // Kandidatläget "evidens": generatorn fyller inte upp listan med liknande modeller, och det är det
  // som gäller för varje identifiering härifrån — även när forskningen är avstängd med
  // LOOPA_RESEARCH_ENGINE=legacy. En lista som är kortare än fyra är ett ärligt svar.
  return callSellerGenerate(brand, images, dir, undefined, undefined, excludeModels, alreadySuggested, { candidateMode: "evidence" });
}

/**
 * Den första omgångens sökning — och BARA den, när den gav något att visa.
 *
 * HÄR LÅG FLÖDETS DYRASTE VÄNTAN. Funktionen gjorde tidigare två anrop i serie och lämnade ifrån sig
 * det bättre: kom det första tillbaka ogrundat — vilket det gör i 38 fall av 60 — stod säljaren kvar
 * på "Letar upp modellen…" i ytterligare en hel sökning innan skärmen ens fick veta att det fanns
 * fyra kandidater. Mätt i den koden: 9,9 s i median mot 3,6 s för de körningar som grundade direkt.
 *
 * Och de kandidaterna VAR redan färdiga. Omförsöket görs inte för att få bättre förslag utan för att
 * få KÄLLOR — det som fas 2 ärver när dess egen sökning kommer tillbaka tom. Generatorns egen mätning
 * på samma Mio-matgrupp, sex körningar: fyra ogrundade svar bar alla fyra KANDIDAT-rader med samma
 * toppkandidat som de grundade körningarna gav. Förslagen är alltså inte det som saknas.
 *
 * Alltså: ett anrop, och sedan visas det som finns. Omförsöket lever kvar oförändrat men flyttat ur
 * väntan — se `grundaIBakgrunden`. Bara när det första anropet gav NOLL kandidater finns det inget
 * att visa, och då är omförsöket fortfarande säljarens enda väg framåt och görs här.
 *
 * FÖRSÖKEN KÖRS ALLTJÄMT I SERIE, aldrig bredvid varandra. Att överlappa dem gjorde väntan kortare på
 * papperet men lät två grundade sökningar på samma nyckel gå samtidigt — och den grundade sökningen
 * är känslig nog att det slog ut kandidaterna helt. Latens får inte köpas med den här sökningens
 * träffsäkerhet; den köps här med ORDNINGEN i stället.
 *
 * PRODUKTFORSKNINGENS SVAR ÄR AVGÖRANDE. Ett svar från forskningen — även ett med färre än fyra eller
 * noll kandidater — omprövas aldrig av generatorn: noll kandidater är ett belagt "inget bilderna
 * stöder", och generatorn fyller i det läget gärna upp med fyra gissningar ur märkets nuvarande sortiment.
 * Omförsöket nedan gäller bara generatorns egna svar.
 */
async function searchCandidates(jobId: string, brand: string, images: CapturedImage[], dir: string): Promise<SellerCall> {
  const call = await sokKandidater(jobId, brand, images, dir, [], []);
  if (call.kind === "needs_selection" && call.engine === "gemini3") return call;
  // Kandidater, grundade eller ej: det räcker för att fylla skärmen, och resten görs i bakgrunden.
  if (!barren(call)) return call;
  console.info(`[identify] ${jobId.slice(0, 8)} inga kandidater på första försöket — försöker igen`);
  const second = await callSellerGenerate(brand, images, dir, undefined, undefined, [], [], { candidateMode: "evidence" });
  return barren(second) ? call : second;
}

/**
 * Grundningen som inte längre får kosta säljaren en väntan.
 *
 * Kandidaterna står redan på skärmen när det här börjar. Sökningen görs om av ett enda skäl — att få
 * källor — och de används till två saker: fas 2:s reservunderlag (`identityResearch`) och
 * bildhämtningens uppslag. Bilderna startar därför HÄR och inte tidigare, precis som förut: de
 * hämtades aldrig innan det andra försöket landat, så deras tidpunkt är oförändrad. Väljarskärmen
 * ritar skimrande platshållare under tiden och läser `imageUrl: undefined` som "fler är på väg".
 *
 * DEN VISADE LISTAN RÖRS ALDRIG. Ett omförsök som svarar med fyra andra namn får inte byta ut
 * förslagen under fingret på någon som redan läser dem — och att den ogrundade listan duger är just
 * vad mätningen ovan säger. Bara källorna tas emot.
 */
function grundaIBakgrunden(
  jobId: string,
  brand: string,
  images: CapturedImage[],
  dir: string,
  visad: { candidates: ModelCandidate[]; sources: SourceRef[] },
): void {
  void (async () => {
    // Registret först, och utan att vänta på något: se publiceraRegisterbilder.
    await publiceraRegisterbilder(jobId, visad.candidates).catch(() => {});
    // Har säljaren redan valt är fas 2 igång och har läst sitt underlag; en sökning till hade varit
    // ett bränt anrop. Bilderna hämtas ändå — sidorna bär mått som annonsen fortfarande vill ha.
    const innan = getJobSync(jobId) ?? (await getJob(jobId));
    let sources = visad.sources;
    if (innan?.identityStatus === "needs_selection") {
      const extra = await callSellerGenerate(brand, images, dir);
      if (settled(extra)) {
        const job = getJobSync(jobId) ?? (await getJob(jobId));
        // Bara om det fortfarande är DEN HÄR listan som står på skärmen. Ett omval under tiden har
        // egna kandidater och egna källor, och de två hör inte ihop.
        if (job && sameList(job.candidates ?? [], visad.candidates)) {
          job.identityResearch = { researchText: extra.researchText, sources: extra.sources };
          await persist(job);
          sources = extra.sources;
        }
        console.info(`[identify] ${jobId.slice(0, 8)} grundning i bakgrunden gav ${extra.sources.length} källor`);
      } else {
        console.info(`[identify] ${jobId.slice(0, 8)} grundning i bakgrunden gav inga källor`);
      }
    }
    attachCandidateImages(jobId, visad.candidates, sources);
  })().catch((err) => {
    console.warn(`[identify] ${jobId.slice(0, 8)} bakgrundsgrundningen föll — ${err instanceof Error ? err.message : String(err)}`);
    attachCandidateImages(jobId, visad.candidates, visad.sources);
  });
}

/** Samma lista, i samma ordning? Avgör om en sen bildhämtning fortfarande hör till det som visas. */
const sameList = (a: ModelCandidate[], b: ModelCandidate[]) =>
  a.length === b.length && a.every((c, i) => c.model === b[i]?.model);

/**
 * Skriver in en kandidatlista med bilder — men bara i den lista bilderna faktiskt hör till.
 *
 * Hämtningen tar upp till åtta sekunder, och säljaren kan hinna trycka "hitta nya" under tiden. Utan
 * jämförelsen hade den gamla omgången skrivit tillbaka sina fyra avfärdade förslag ovanpå de nya —
 * långt efter att skärmen bytt innehåll.
 *
 * Skrivs ÄVEN när säljaren redan hunnit välja: hämtningen bär också sidans mått, och de är som mest
 * värda EFTER valet, när annonsen ska fyllas.
 */
async function skrivKandidatbilder(
  jobId: string,
  candidates: ModelCandidate[],
  withImages: ModelCandidate[],
): Promise<void> {
  const fresh = getJobSync(jobId) ?? (await getJob(jobId));
  if (!fresh) return;
  if (fresh.identityStatus !== "needs_selection" && fresh.identityStatus !== "resolved") return;
  if (!sameList(fresh.candidates ?? [], candidates)) return;
  // En bild som redan finns på jobbet (till exempel ur Googles bildsök, se applyExternalImages) raderas aldrig av en jakt som blev utan: jaktens slutskrivning bär `null` för
  // allt den inte hittade, och den skrivs ofta SIST.
  fresh.candidates = withImages.map((c) => {
    const prev = (fresh.candidates ?? []).find((p) => p.model === c.model);
    // Ett appjobb (Googles bildsök): bilden bestäms av applyExternalImages och registret, aldrig av jaktens egna fynd, och jaktens "ingen bild" (null) är inget besked förrän appen sagt sitt.
    if (fresh.externalIdentify && prev) return { ...c, imageUrl: prev.imageUrl, imageSource: prev.imageUrl ? prev.imageSource ?? c.imageSource : c.imageSource, undertyp: prev.undertyp };
    // Och en bild som kom ur Googles bildsök (appen) ersätts inte av jaktens: den är redan fotokontrollerad, och jakten kan komma med en miljöbild med soffan i förgrunden.
    const behall = !!prev?.imageUrl && (!c.imageUrl || /^https:\/\/www\.google\.com\/search\?udm=2/.test(prev.imageSource ?? ""));
    return behall ? { ...c, imageUrl: prev!.imageUrl, imageSource: prev!.imageSource ?? c.imageSource } : c;
  });
  // Den valda kandidaten är den enda vars sida annonsen ska byggas på — flytta över den hit så
  // fas 2 slipper leta i listan.
  const chosen = fresh.selected && fresh.candidates.find((c) => c.model === fresh.selected!.model);
  if (chosen) fresh.selected = { ...fresh.selected!, pageSpecs: chosen.pageSpecs, imageSource: chosen.imageSource };
  await persist(fresh);
}

/**
 * REGISTRETS BILDER, FRAMME DIREKT — före allt som kostar ett nätanrop.
 *
 * En modell någon letat upp förut har sin miniatyr på disk, och uppslaget är en filkontroll: några
 * millisekunder. Jakten i candidateImages gör redan det uppslaget först, men den STARTAR inte förrän
 * grundningen i bakgrunden kommit tillbaka — ett generatoranrop på 6-9 sekunder. Följden var att en
 * bild som låg färdig skrevs ut tio sekunder efter att skärmen ritats, och säljaren såg skimmer hela
 * tiden för en bild vi redan ägde.
 *
 * Kandidater utan träff lämnas orörda: `imageUrl` förblir `undefined`, alltså "letar fortfarande",
 * och jakten fyller i dem när den får börja.
 */
async function publiceraRegisterbilder(jobId: string, candidates: ModelCandidate[]): Promise<void> {
  const träffar = await Promise.all(
    candidates.map((c) => registreradKandidatbild(c.brand, c.model, typfamilj(c.productType)).catch(() => null)),
  );
  if (!träffar.some(Boolean)) return;
  await skrivKandidatbilder(
    jobId,
    candidates,
    candidates.map((c, i) => (träffar[i] ? { ...c, imageUrl: träffar[i] } : c)),
  );
}

/**
 * Produktbilderna hämtas EFTER att kandidaterna sparats, aldrig före.
 *
 * Väljarskärmen ska dyka upp exakt lika snabbt som förut — bilderna är en förbättring av den, inte
 * ett villkor för den. En kandidat vars bild aldrig landar är fortfarande fullt valbar.
 */
function attachCandidateImages(jobId: string, candidates: ModelCandidate[], sources: SourceRef[], external = false): void {
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
  const publish = (withImages: ModelCandidate[]) => skrivKandidatbilder(jobId, candidates, withImages);

  // `external`: appjobb. Jakten körs för sidornas mått, men dess bilder används aldrig (skrivKandidatbilder) och den rör inte registret (resolveCandidateImages, `register`).
  void resolveCandidateImages(candidates, sources, publish, undefined, undefined, !external)
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
 * Körs parallellt med skickbedömningen så fort bilderna finns. Besiktningen behöver inte modellen och identifieringen behöver inte
 * betyget — de två spåren delar bara bildrutorna, så att kedja dem hade lagt tiderna ovanpå varandra i stället för bredvid. Klienten visar
 * det som blir klart först (skicket före modellen, eller tvärtom); se pipeline/tasks.ts.
 *
 * Säljaren väljer modellen. Identifieringen föreslår — med den säkerhet den faktiskt har, "stark", "trolig" eller "möjlig" — och sparar
 * underlaget (källor, observationer) som fas 2 ärver. Ingenting av fas 2 startar före valet: ingen förvärmning på en gissad modell.
 */
export function runIdentify(jobId: string, brand: string, images: CapturedImage[]): Promise<void> {
  return withCostScope({ jobId, stage: "identify" }, () => runIdentifyInner(jobId, brand, images));
}

async function runIdentifyInner(jobId: string, brand: string, images: CapturedImage[]): Promise<void> {
  const dir = jobDir(jobId);
  const startedAt = Date.now();
  await setTask(jobId, "identify", "running", { restart: true });

  /** ETT anrop, och sedan visas det som finns. Se `searchCandidates`. */
  const call = await searchCandidates(jobId, brand, images, dir);
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return;

  /**
   * Säljaren hann före: de skrev modellnamnet själva (eller avbröt) medan sökningen pågick, och identiteten är avgjord. Ett sent svar får
   * aldrig skriva över den — varken kandidater eller status — hur väl det än svarade.
   */
  if (job.identityStatus !== "identifying") {
    console.info(`[identify] ${jobId.slice(0, 8)} svaret kom efter att identiteten avgjorts (${job.identityStatus}) — kastas`);
    await setTask(jobId, "identify", "cancelled", { note: "Säljaren hann före." });
    return;
  }

  if (call.kind === "needs_selection") {
    job.identityStatus = "needs_selection";
    job.candidates = call.candidates;
    // Hur det slutade — skärmen skiljer på "bilderna räckte inte", "tiden/budgeten räckte inte" och "tjänsten var nere" när listan är tom.
    job.identityResult = call.result ?? (call.candidates.length > 0 ? "candidates" : "no_match");
    // Raden under väljaren när listan är tom: ett ärligt besked i stället för ett tyst "inga modeller".
    job.identityError = call.note ?? null;
    // Kvittot på körningen — tid per steg, sökfrågor, försök, kostnad.
    job.identityTrace = call.runSummary ?? null;
    // Sparas för fas 2: de sidor identifieringen läst är specsökningens startpunkt.
    job.identityResearch = { researchText: call.researchText, sources: call.sources };
    console.info(
      `[identify] ${jobId.slice(0, 8)} needs_selection candidates=${call.candidates.length}` +
        ` motor=${call.engine ?? "generator"} exakt=${call.exactMatch ?? "-"} sources=${call.sources.length} ms=${Date.now() - startedAt}`,
    );
    await persist(job);
    const failed = job.identityResult === "timeout" || job.identityResult === "unavailable";
    await setTask(jobId, "identify", failed ? "failed" : "completed", { note: failed ? job.identityError : null });

    // Skärmen har sitt innehåll i och med raden ovan. Bilderna och källorna är förbättringar av den; ingenting av det väntas in.
    if (call.candidates.length === 0) return;
    // Forskningens svar grundas inte om i bakgrunden: dess källor är redan riktiga adresser, och en
    // generatorsökning till hade bara kostat ett anrop för att ersätta dem med sämre.
    if (call.engine === "gemini3" || settled(call)) attachCandidateImages(jobId, call.candidates, call.sources);
    else grundaIBakgrunden(jobId, brand, images, dir, call);
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
    await persist(job);
    await setTask(jobId, "identify", "completed");
    // Också gissningen ska få sin bild — och framför allt sitt besked: utan en hämtning blev `imageUrl` stående som `undefined`, "letar fortfarande".
    if (job.candidates.length > 0) attachCandidateImages(jobId, job.candidates, r?.sources ?? []);
    return;
  } else {
    job.identityStatus = "unavailable";
    job.identityError = call.reason;
    console.warn(`[identify] ${jobId.slice(0, 8)} unavailable — ${call.reason}`);
    await setTask(jobId, "identify", "failed", { note: call.reason });
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

  /**
   * Ett nytt försök är betalt arbete (sökfrågor à 0,15 SEK) och måste rymmas i omgångens budget. Rymmer den det inte svarar vi nej med en
   * förklaring i stället för att starta något — säljaren kan skriva modellnamnet själv, eller starta en ny analys (en ny omgång, en ny budget).
   */
  const allowance = await allowanceFor(jobId, "identify");
  if (allowance.searchQueries < MIN_IDENTIFY_QUERIES) {
    return { error: "Kostnadstaket för den här omgången är nått, så fler modellförslag söks inte fram. Skriv modellnamnet själv, eller starta en ny analys." };
  }

  job.rejectedCandidates = rejected;
  job.candidates = [];
  job.candidateRound = (job.candidateRound ?? 0) + 1;
  job.identityStatus = "identifying";
  job.identityError = null;
  job.identityResult = undefined;
  await persist(job);
  await setTask(jobId, "identify", "running", { restart: true });

  void withCostScope({ jobId, stage: "identify" }, () => runCandidateRound(jobId, brand, images, rejected)).catch((err) => {
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
  /** Satt när omgången gjordes av produktforskningen. Då styr den förvärmningen och loopen nedan. */
  engine?: "gemini3";
  exactMatch?: boolean;
  runSummary?: ResearchRunSummary | null;
  /** Hur forskningens runda slutade (bara när den gjordes av forskningen). */
  result?: IdentityResult;
};

/** Vad en lista bär med sig om vem som gjorde den. */
type ListMeta = { engine?: "gemini3"; exactMatch?: boolean; result?: IdentityResult };

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
  /**
   * Anropas i det ögonblick platserna är fyllda, medan omgången kan ha sökningar kvar.
   *
   * Loopen nedan söker vidare av TVÅ skäl, och bara det ena har med förslagen att göra: platserna är
   * inte fyllda, eller ingen sökning har kommit tillbaka grundad. Det andra skälet angår fas 2:s
   * underlag — inte de fyra namn som ska stå på skärmen — men väntan drabbade ändå säljaren: en
   * fylld lista kunde stå och hållas tillbaka genom ytterligare två sökningar på 6-9 sekunder var
   * medan skärmen visade "vi letar". Och bakom listan står bildhämtningen, som inte får börja förrän
   * kandidaterna finns.
   *
   * Listan som lämnas här ÄR den slutliga: `CANDIDATES_PER_ROUND` är ett tak, så en fylld lista kan
   * inte växa, och de återstående sökningarna rör bara `research`. Den som visar den behöver alltså
   * inte förbereda sig på att byta ut den under fingret på någon som läser.
   */
  onFilled?: (candidates: ModelCandidate[], sources: SourceRef[], meta: ListMeta) => void,
): Promise<CandidateRound> {
  const rejectedNames = rejected.map(fullName).filter(Boolean);
  const candidates: ModelCandidate[] = [];
  const sources: SourceRef[] = [];
  let research: CandidateRound["research"] = null;
  let error: string | null = null;
  let searches = 0;
  /** Har den fyllda listan redan lämnats ut? Den lämnas en gång, aldrig om. */
  let anmalda = false;
  let engine: CandidateRound["engine"];
  let exactMatch: boolean | undefined;
  let runSummary: ResearchRunSummary | null = null;
  let result: IdentityResult | undefined;

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
    // Platserna är fyllda: visa dem nu, inte när grundningen nedan är klar.
    if (candidates.length >= CANDIDATES_PER_ROUND && !anmalda) {
      anmalda = true;
      onFilled?.([...candidates], [...sources], { engine: call.engine, exactMatch: call.exactMatch });
    }
    /**
     * Forskningens svar avgör rundan. En runda är ETT forskningsanrop — med sin egen eskalering inuti —
     * och inte upp till tre generatorsökningar som ska fylla fyra platser. Färre än fyra, eller noll,
     * är ett ärligt svar: att söka om tills listan är full var just det som skapade fyra gissningar.
     */
    if (call.engine === "gemini3") {
      engine = "gemini3";
      exactMatch = call.exactMatch === true;
      runSummary = call.runSummary ?? null;
      result = call.result;
      if (candidates.length === 0 && call.note) error = call.note;
      if (!research && call.sources.length > 0) research = { researchText: call.researchText, sources: call.sources };
      break;
    }
    // Fas 2 ärver EN sökning, aldrig tre hopklistrade: den första grundade. Text om fyra andra
    // modeller hade gett annonsen mått som hör till någon annan möbel.
    if (!research && call.sources.length > 0) research = { researchText: call.researchText, sources: call.sources };
  }

  return { candidates, sources, research, error, searches, engine, exactMatch, runSummary, result };
}

/**
 * Själva omvalssökningen. Skriver alltid tillbaka ett `needs_selection` — även när den blev tom.
 *
 * LISTAN VISAS SÅ FORT DEN ÄR FYLLD, inte när omgången är slut. De två sammanföll förut, och det var
 * hela problemet med "hitta nya": omgången söker vidare efter en GRUNDAD sökning även när de fyra
 * platserna redan är tagna, och de extra sökningarna kostar 6-9 sekunder var. Under dem stod jobbet
 * kvar i `identifying`, skärmen sa "vi letar", och bildhämtningen — som inte kan börja förrän
 * kandidaterna är skrivna — hade inte ens startat. Nu delas de: förslagen och deras bilder går ut på
 * den första fyllda sökningen, och underlaget till fas 2 skrivs på när det kommer.
 */
async function runCandidateRound(
  jobId: string,
  brand: string,
  images: CapturedImage[],
  rejected: ModelCandidate[],
): Promise<void> {
  const startedAt = Date.now();
  const dir = jobDir(jobId);
  const runda = getJobSync(jobId)?.candidateRound ?? 1;
  /** Den lista som visats, om den visats. Håller isär "redan uppe" från "kom med slutresultatet". */
  let uppe: ModelCandidate[] | null = null;

  /**
   * Skriv fram listan och sätt igång allt som hänger på den.
   *
   * Körs en gång per omgång: antingen från `onFilled` mitt i sökandet, eller på slutresultatet när
   * platserna aldrig blev fyllda. Returnerar jobbet den skrev, eller null när den inte fick skriva.
   */
  const visa = async (
    found: ModelCandidate[],
    sources: SourceRef[],
    research: CandidateRound["research"],
    error: string | null,
    meta: ListMeta = {},
    runSummary: ResearchRunSummary | null = null,
  ) => {
    const job = getJobSync(jobId) ?? (await getJob(jobId));
    if (!job) return null;
    // Säljaren kan ha skrivit namnet själv medan sökningen pågick. Då är identiteten avgjord, och en
    // lista som landar efteråt får inte välta den.
    if (job.identityStatus !== "identifying") return null;

    job.candidates = found;
    job.identityStatus = "needs_selection";
    job.identityResult = found.length > 0 ? "candidates" : (meta.result ?? "no_match");
    // Underlaget byts bara mot ett som faktiskt bär något: en tom omgång får inte kasta de källor den
    // första gav, för det är dem fas 2 ärver när dess egen sökning kommer tillbaka tom.
    if (found.length > 0 && research) job.identityResearch = research;
    // Att inte hitta fler modeller är inget fel — det är ett svar, och skärmen säger det med sin egen
    // text. Bara en fallen generator är värd en varningsrad, och bara när den lämnade skärmen tom:
    // med fyra förslag uppe är en ursäkt för en sökning som föll däremellan bara brus.
    if (found.length === 0 && error) job.identityError = error;
    if (runSummary) job.identityTrace = runSummary;
    await persist(job);
    uppe = found;

    if (found.length > 0) attachCandidateImages(jobId, found, sources);
    return job;
  };

  const round = await collectNewCandidates(
    rejected,
    (rejectedNames, listedNames) => sokKandidater(jobId, brand, images, dir, rejectedNames, listedNames),
    /**
     * Avbryt mellan sökningarna om säljaren hunnit avgöra identiteten själv. Saknas jobbet i minnet
     * är det inget besked om att valet är gjort — då fortsätter omgången.
     *
     * `needs_selection` räknas som "fortfarande önskad" sedan listan börjat visas tidigt: det läget
     * är numera VÅRT eget avtryck, inte ett besked om att någon annan tagit över. Det som säger att
     * ingen väntar längre är `resolved` — och en ny omgång, som skriver om statusen till
     * `identifying` och vars lista `visa` ovan vägrar välta.
     */
    () => {
      const status = getJobSync(jobId)?.identityStatus ?? "identifying";
      return status === "identifying" || (uppe !== null && status === "needs_selection");
    },
    // Fyllda platser: ut med dem direkt. Se doc-kommentaren på parametern.
    (found, sources, meta) => {
      void visa(found, sources, null, null, meta).catch(() => {});
    },
  );
  const found = round.candidates;

  /**
   * Listan stod redan uppe: då återstår bara underlaget.
   *
   * `visa` får inte köras om — den skulle skriva samma fyra namn en gång till och starta om både
   * bildhämtningen och förvärmningen för en lista som inte ändrat sig.
   */
  if (uppe) {
    const job = getJobSync(jobId) ?? (await getJob(jobId));
    // Bara om det fortfarande är DEN HÄR listan som står på skärmen. Ett nytt "hitta nya" under
    // tiden har egna kandidater, och det underlaget hör inte till dem.
    if (job && sameList(job.candidates ?? [], uppe) && (round.research || round.runSummary)) {
      if (round.research) job.identityResearch = round.research;
      if (round.runSummary) job.identityTrace = round.runSummary;
      await persist(job);
    }
  } else {
    await visa(found, round.sources, round.research, round.error, { engine: round.engine, exactMatch: round.exactMatch, result: round.result }, round.runSummary ?? null);
  }

  console.info(
    `[identify] ${jobId.slice(0, 8)} omval=${runda} nya=${found.length}` +
      ` sökningar=${round.searches} avfärdade=${rejected.length} ms=${Date.now() - startedAt}` +
      `${uppe ? ` (visad efter sökning 1 av ${round.searches})` : ""}`,
  );
}

/**
 * Rader utifrån (sidskörd, måttminne) som inte får fylla ett mått forskningen HÅLLIT TILLBAKA.
 *
 * Ett mått kan vara tillbakahållet för att utförandena skiljer sig och säljaren inte valt, eller för att
 * uppgifterna motsade varandra. Sidskörden läser en enda produktsida — ofta ett annat utförande — och hade
 * fyllt precis det hålet med ett tal som inte gäller säljarens möbel.
 */
export function utanTillbakahallna(result: Pick<GeneratedListing, "factCheck"> | { factCheck?: undefined }, rows: ListingAttribute[]): ListingAttribute[] {
  const held = new Set((result.factCheck?.heldBack ?? []).map((h) => h.type));
  if (held.size === 0) return rows;
  return rows.filter((r) => {
    const k = classifyAttribute(r);
    return !(k.kind === "dimension" && k.type && held.has(k.type));
  });
}

/**
 * Fas 2: säljaren har valt. Bygg annonsen på den modellen, och prissätt.
 *
 * Priset ligger sist med flit. Prismotorn söker på modellnamnet och drar av för skadorna, så den
 * behöver BÅDA de andra spåren klara — det är den enda punkt i flödet där de möts.
 */
export function finalizeWithModel(jobId: string, resolution: Resolution): Promise<void> {
  return withCostScope({ jobId, stage: "listing" }, () => finalizeWithModelInner(jobId, resolution));
}

async function finalizeWithModelInner(jobId: string, resolution: Resolution): Promise<void> {
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return;
  // Säljarens val gäller. Pågår identifieringen fortfarande (ett handskrivet namn medan den söker) stoppas det betalda anropet: ingen väntar på dess svar.
  if (avbrytIdentifiering(jobId)) await setTask(jobId, "identify", "cancelled", { note: "Säljaren bekräftade modellen." });
  else if (job.tasks?.identify?.status === "running") await setTask(jobId, "identify", "cancelled", { note: "Säljaren bekräftade modellen." });
  await setTask(jobId, "specs", "running", { restart: true });
  const images = job.images ?? job.result?.images ?? [];
  const dir = jobDir(jobId);
  const startedAt = Date.now();

  const model =
    resolution.kind === "seller_selected" ? resolution.selected.model : resolution.kind === "manual" ? resolution.manualModel : "";
  const brand = job.identity?.brand ?? (resolution.kind === "seller_selected" ? resolution.selected.brand : null);
  job.identity = { brand, model };
  job.selected = resolution.kind === "seller_selected" ? resolution.selected : null;
  job.identityStatus = "resolved";
  /**
   * Är det en stol? Avgörs HÄR, för det är här svaret först finns och redan behövs.
   *
   * Frågan om ANTAL stolar ställs i väntan som börjar i nästa andetag (se DisclosuresGate i
   * klienten), alltså långt innan prismotorn hunnit säga vilken möbeltyp den filtrerade på. Den
   * valda kandidatens `productType` finns däremot nu, och för ett handskrivet modellnamn får
   * strängen tala — samma två källor som prisvägen läser, i den ordning de blir tillgängliga.
   */
  job.chairLike = kanVaraStol({ brand, model }, null, job.selected?.productType ?? null);
  // Bar kandidaten säljaren valde redan sin produktbild är omslaget klart här, utan en enda hämtning
  // till — det är samma bild de nyss pekade på. Annars hämtas ett omslag längre ned.
  job.productImage = job.selected?.imageUrl
    ? { url: job.selected.imageUrl, sourceUrl: job.selected.imageSource ?? null }
    : null;
  await persist(job);

  /**
   * Variantlistan hämtas HÄR, i bakgrunden.
   *
   * Frågan ställs för säljaren först efter pälsdjur och lukt (se VariantGate i klienten), men
   * hämtningen måste börja nu för att svaret ska ligga färdigt när de kommer dit. Den kör bredvid
   * annonsen och priset, precis som allt annat i den här funktionen, och faller den tyst blir det
   * ingen fråga alls.
   *
   * Hoppas över vid ett omval: då har säljaren redan svarat, och listan ska inte hämtas på nytt.
   */
  // Väntar vi på AI-lägets svar (expectExternalSpecs) avgör DET varianten ur bilderna: ingen gissad variantlista att fråga säljaren om (variantOptions står redan som tom).
  if (job.variantChosen == null && !job.externalFacts?.specPending) {
    // Möbeltypen följer med. Utan den blev frågan ställd om hela serien: "Nordviken stol" gav val
    // mellan matbord, barstol och bänk. Se pipeline/varianter.ts.
    const typ = job.selected?.productType ?? null;
    const variantLista = withCostScope({ jobId, stage: "variants" }, () => hamtaVarianter(brand, model, typ));
    void variantLista
      .then(async (varianter) => {
        const fresh = getJobSync(jobId) ?? (await getJob(jobId));
        if (!fresh || fresh.variantChosen != null) return;
        // Forskningens egna utföranden (grundade i källor, med skilda mått) går före minnesbaserade gissningar.
        if (fresh.productFacts?.variants?.length) {
          // Variantgrinden väntar på att listan blir satt: ge den forskningens egna alternativ i stället för att låta den vänta ut tidsgränsen.
          if (fresh.productFacts.variants.length >= 2 && fresh.variantOptions === undefined) {
            fresh.variantOptions = fresh.productFacts.variants.map((v) => v.label);
            await persist(fresh);
          }
          return;
        }
        fresh.variantOptions = varianter;
        await persist(fresh);
        console.info(`[varianter] ${jobId.slice(0, 8)} ${varianter.length} varianter för "${model}"`);
      })
      .catch((err) => console.warn(`[varianter] ${jobId.slice(0, 8)} föll:`, err instanceof Error ? err.message : err));
  }

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
    const attributes = mergeSpecs(listing.result.attributes, utanTillbakahallna(listing.result as { factCheck?: GeneratedListing["factCheck"] }, specs));
    return attributes === listing.result.attributes ? listing : { ...listing, result: { ...listing.result, attributes } };
  };

  /**
   * Fakta jobbet redan bär om DEN HÄR modellen — vid ett variantval. Då filtrerar vi dem i stället för
   * att söka om: omsökningen tog 103–108 s och tappade alla mått (se annons.ts, byggAnnonsFranFakta).
   * Gäller bara samma modell; ett omval av en annan modell börjar om.
   */
  const storedFacts = job.productFacts && slugKey(job.productFacts.identity.model) === slugKey(model) ? job.productFacts : null;
  let latestFacts: { facts: ProductFacts; trace: ResearchRunSummary | null } | null = null;
  // En funktion och inte variabeln: TypeScript ser inte tilldelningen i generateOnce-återanropet.
  const getFacts = (): { facts: ProductFacts; trace: ResearchRunSummary | null } | null => latestFacts;

  /**
   * ETT specsanrop per modell och jobb.
   *
   * Pågår redan en specsökning för den här modellen och det här jobbet — ett variantval medan den första löper — väntar vi in den i
   * stället för att starta en andra bredvid: två parallella sökningar kostade dubbelt och den som blev klar sist skrev över den andra.
   * Dess fakta bär alla utföranden, så variantvalet filtreras ur dem.
   */
  const generateOnce = () => {
    const identity = { brand, model };
    const fresh = () => byggAnnons(identity, images, dir, resolution, prior);
    const viaFacts = (facts: ProductFacts) => byggAnnonsFranFakta(identity, images, dir, resolution, facts, prior).then((c) => c ?? fresh());
    const running = factsInFlight.get(jobId);
    const call: Promise<SellerCall> = storedFacts
      ? viaFacts(storedFacts)
      : running && running.model === model
        ? running.promise.then((f) => (f ? viaFacts(f) : fresh()))
        : fresh();
    const mine = call.then(
      (c) => (c.kind === "ok" ? (c.productFacts ?? null) : null),
      () => null,
    );
    factsInFlight.set(jobId, { model, promise: mine });
    void mine.finally(() => {
      if (factsInFlight.get(jobId)?.promise === mine) factsInFlight.delete(jobId);
    });
    return call.then((c) => {
      if (c.kind === "ok" && c.productFacts) latestFacts = { facts: c.productFacts, trace: c.specTrace ?? null };
      return c.kind === "ok"
        ? c.listing
        : {
            status: "unavailable" as const,
            unavailableReason: c.kind === "unavailable" ? c.reason : "Oväntat kandidatsvar i fas 2.",
            result: null,
            latencyMs: Date.now() - startedAt,
          };
    });
  };

  // Uppskattade mått räknas inte som fynd. Annonsen bär dem alltid numera, och läste villkoret dem
  // som mått hade omförsöket — det som faktiskt hämtar hem de riktiga måtten — aldrig kört igen.
  // Måttminnet räknas inte heller: det är en mätning av modellen, men det är fortfarande ingen källa,
  // och ett minne som stoppade omförsöken hade gjort att vi slutade leta efter tillverkarens egna tal.
  const eget = (a: ListingAttribute) => !a.estimated && !a.fromSellers;
  const hasDimensions = (l: Awaited<ReturnType<typeof generateOnce>>) =>
    // Mått som väntar på säljarens val av utförande ÄR funna — att leta om efter dem vore ett betalt anrop för ingenting.
    !!l.result?.factCheck?.heldBack.some((h) => h.reason === "variant") ||
    !!l.result?.attributes.some((a) => eget(a) && (a.kind === "dimension" || /(mått|bredd|djup|höjd|längd|diameter|sitthöjd|sitsdjup)/i.test(a.label)));

  /**
   * Ett andra specsanrop när det första inte gav några mått — men bara om omgångens budget rymmer ett helt anrop till. Förut gjordes upp
   * till tre försök i en väggklocka på 55 s utan att någon räknade vad de kostade; ett specsanrop kostar sökfrågor à 0,15 SEK, och taket
   * för hela omgången är 2,00 SEK (cost/ledger.ts). Utan utrymme levereras det som finns, markerat som ofullständigt.
   */
  const RETRY_MIN_REMAINING_SEK = 0.7;

  /**
   * Publicera annonsen på jobbet, märkt med om ett försök till kan komma. Klienten slutar polla först när den ser `improving: false`,
   * annars fastnar skärmen på det första svaret medan ett bättre skrivs in bakom den.
   */
  const publish = async (listing: Awaited<ReturnType<typeof generateOnce>>, improving: boolean) => {
    const job = getJobSync(jobId) ?? (await getJob(jobId));
    if (!job) return;
    // Säljaren kan ha bytt modell medan det här byggdes: då hör annonsen till en identitet som inte längre gäller, och får inte skriva över den nya.
    if (job.identity && slugKey(job.identity.model ?? "") !== slugKey(model)) {
      console.info(`[identify] ${jobId.slice(0, 8)} annonsen för "${model}" kom efter att modellen bytts till "${job.identity.model}" — kastas`);
      return;
    }
    job.identity = { brand, model };
    const marked = behallSaljarensRattelser({ ...listing, improving }, job.result?.listing ?? job.pendingListing);
    // Fakta om ALLA varianter följer med jobbet, så att ett variantval kan filtrera i stället för att söka om.
    if (latestFacts) {
      job.productFacts = latestFacts.facts;
      job.specTrace = latestFacts.trace;
    }
    // Hittade forskningen utföranden med olika mått är DET variantfrågan, med forskningens egna ord —
    // inte minnesbaserade gissningar. Gäller bara om säljaren ännu inte valt.
    const options = marked.result?.factCheck?.options ?? [];
    if (job.variantChosen == null && marked.result?.factCheck?.ambiguous && options.length >= 2) {
      job.variantOptions = options;
    }
    if (job.result) job.result.listing = marked;
    else job.pendingListing = marked;
    /**
     * ETT ANNONSHÄRLETT JOBB BLIR KLART HÄR, och ingen annanstans: köparens jobb har ingen besiktning (`skipGrading`), och det är besiktningen
     * som anropar `completeJob` för ett säljarjobb. Först vid `improving: false` — dessförinnan kan ett omförsök fortfarande fylla i måtten.
     */
    // Samma gäller testläget identifyOnly (prototypen): ingen besiktning, så annonsen/måtten är det som gör jobbet klart.
    if ((job.adDerived || (job.externalIdentify && job.tasks?.condition?.status === "cancelled")) && !improving) {
      job.progress = { stage: "done", message: "Analysen är klar." };
    }
    await persist(job);
  };

  /**
   * Vad säljare av samma modell mätt upp. Läses EN gång per fas 2 — minnet ligger i processen och
   * ändras inte under de sekunder annonsen byggs.
   *
   * Aldrig före en källa: sidskörden läggs in först, och `mergeSpecs` släpper bara in minnet där
   * ingen källa svarat. Där en uppskattning står tar minnet över — det är en mätning av modellen,
   * inte en tabell över möbeltypen. Se mattminne.ts.
   */
  const minnet = await mattminnetsRader(brand, model).catch(() => [] as ListingAttribute[]);
  if (minnet.length > 0) {
    console.info(`[identify] ${jobId.slice(0, 8)} måttminnet har ${minnet.map((m) => m.label).join("/")} för "${model}"`);
  }

  const listingPromise = (async () => {
    // Sidskörden och måttminnet kommer utan `kind`. Varje rad som lämnar servern ska veta vad den är
    // (mått, material, uppgift), så att klienten inte gissar av en etikett.
    const withKindsOn = <T extends { result: { attributes: ListingAttribute[] } | null }>(listing: T): T =>
      listing.result ? { ...listing, result: { ...listing.result, attributes: withKinds(listing.result.attributes) } } : listing;
    const enrich = async <T extends { result: { attributes: ListingAttribute[] } | null }>(listing: T) =>
      withKindsOn(withPageSpecs(withPageSpecs(listing, await freshPageSpecs()), minnet));

    let best = await enrich(await generateOnce());
    const cost = await costOf(jobId);
    const retry = !hasDimensions(best) && !!cost && canSpend(cost, RETRY_MIN_REMAINING_SEK);
    if (!hasDimensions(best) && !retry) {
      await markIncomplete(jobId, cost && budgetStatus(cost) !== "within" ? "Kostnadstaket för omgången rymde inget nytt försök att hitta måtten." : "Inga mått hittades.");
    }
    await publish(best, retry);
    // `ms` är SÄLJARENS väntan: från trycket på modellen till att annonsen ligger på jobbet.
    console.info(
      `[identify] ${jobId.slice(0, 8)} väg=${resolution.kind} listing=${best.status} mått=${hasDimensions(best)}` +
        ` medskickade_källor=${prior?.sources.length ?? 0} källor=${best.result?.sources?.length ?? 0} ms=${Date.now() - startedAt}`,
    );

    if (retry) {
      console.info(`[identify] ${jobId.slice(0, 8)} inga mått — ett försök till (budgeten rymmer det)`);
      const next = await enrich(await generateOnce());
      // Bara belagda attribut räknas. De uppskattade måtten följer med varje försök och säger inget om
      // vilket av dem som fick veta mest — de hade bara gjort jämförelsen till en fråga om möbeltyp.
      const count = (l: typeof best) => l.result?.attributes.filter(eget).length ?? 0;
      if (hasDimensions(next) || count(next) > count(best)) best = next;
      if (!hasDimensions(best)) await markIncomplete(jobId, "Inga mått hittades.");
    }
    // Sista ordet, alltid skrivet: `improving: true` ska aldrig stå kvar på jobbet med ingen som tar bort det. Skörden läses om en
    // sista gång — sidan kan ha landat medan det sista försöket kördes.
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
  const pricePromise = withCostScope({ jobId, stage: "price" }, async () => {
    await setTask(jobId, "price", "running", { restart: true });
    // Priset behöver skadelistan. Skickbedömningen kör i sitt eget spår och kan mycket väl vara klar.
    const ready = await waitForCondition(jobId);
    if (!ready?.result) {
      // Ingen besiktning i det här jobbet (testläget identifyOnly): priset hoppas över, det har inte "fallit".
      const skipped = ((getJobSync(jobId) ?? (await getJob(jobId)))?.tasks?.condition?.status ?? "") === "cancelled";
      await setTask(jobId, "price", skipped ? "cancelled" : "failed", { note: skipped ? "Pris hoppades över: jobbet har ingen besiktning." : "Skicket blev inte klart." });
      return null;
    }
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
        undefined,
        // Samma möbeltyp som `chairLike` ovan avgjordes på. Utan den kunde prisvägen svara nej på
        // stolsfrågan efter att den här funktionen redan svarat ja — och då frågas säljaren om
        // antalet stolar utan att styckpriset någonsin räknats fram.
        job.selected?.productType ?? null,
      ));
    const target = getJobSync(jobId) ?? (await getJob(jobId));
    if (target?.result) {
      target.result.price = price;
      target.result.identity = { brand, model };
      await persist(target);
    }
    // Säljaren kan redan ha svarat hur många stolar det är — svaret ges i väntan medan det här
    // löper. Gäller det priset räknas bunten in nu; annars gör svaret det när det kommer in.
    await synkaStolpris(jobId);
    console.info(`[identify] ${jobId.slice(0, 8)} price=${price?.status ?? "none"} spekulerat=${speculated ? "ja" : "nej"} ms=${Date.now() - startedAt}`);
    // "Inga tillräckligt lika annonser" är ett svar, inte ett fel: prismotorn gjorde sitt jobb. Bara en motor som inte gick att nå är en fallen uppgift.
    const priceAnswered = price?.status === "ok" || price?.status === "no_data";
    await setTask(jobId, "price", priceAnswered ? "completed" : "failed", { note: price?.status === "ok" ? null : price?.status === "no_data" ? "Inga tillräckligt lika annonser." : "Priset kunde inte hämtas." });
    return price;
  });

  // Publicera annonsen så fort DEN är klar — säljaren ska inte vänta in priset för att se
  // specifikationerna.
  const listing = await listingPromise;
  console.info(`[identify] ${jobId.slice(0, 8)} listing=${listing.status} ms=${Date.now() - startedAt}`);
  const listingOk = listing.status === "ok" && !!listing.result;
  // Forskningen levererade när kortet har mått. Ett kort utan (forskningen föll, eller budgeten rymde inget nytt försök) finns kvar och går att komplettera,
  // men uppgiften säger sanningen: den föll.
  const researched = listingOk && hasDimensions(listing);
  await setTask(jobId, "specs", researched ? "completed" : "failed", { note: researched ? null : listingOk ? "Inga mått hittades." : listing.unavailableReason ?? "Annonsen blev inte klar." });
  if (!listingOk) await markIncomplete(jobId, listing.unavailableReason ?? "Annonsen blev inte klar.");

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
  /**
   * MÖBELNS FÄRG, och varför den prövas HÄR och inte när bilden först hämtades.
   *
   * Kandidaternas bilder letas upp under identifieringen, innan annonsen finns — och färgen står i
   * annonsens attribut. Den vägen är alltså färgblind med nödvändighet, och resultatet syntes: rätt
   * modell, fel variant. NORDVIKEN finns i svart och i vitlaserad ek, och omslaget blev den som råkade
   * ligga först bland källorna.
   *
   * Nu finns färgen, och bilden hämtas om om den inte är BEKRÄFTAD i rätt färg — alltså både när
   * adressen namnger en annan färg och när den inte säger något alls.
   *
   * Det andra fallet var först undantaget, med argumentet att en tyst adress inte är fel adress. Det
   * argumentet håller inte, och IKEA Jules visade varför: annonsen sa "rosa", omslaget var en svart
   * museibild från 1998, och adressen nämnde ingen färg — så inget hände. Skillnaden mot förut är att
   * omhämtningen nu frågar sökmotorn efter FÄRGEN (se searchTargets). Den letar alltså inte om bland
   * samma träffar, den ställer en annan fråga.
   *
   * DEN GAMLA BILDEN BEHÅLLS OM DEN NYA UTEBLIR. Omprövningen får kosta tid, aldrig en bild.
   */
  const farg = fargForAnnons({
    attribut: listing.result?.attributes ?? null,
    titel: listing.result?.listing?.title ?? null,
    variant: job.selected?.variant ?? null,
  });
  const gammal = job.productImage ?? null;
  const bekraftadFarg = !!gammal && !!farg && fargerI(gammal.sourceUrl ?? "").has(farg);
  const provaOm = !!gammal && !!farg && !bekraftadFarg;
  if (provaOm) {
    console.info(`[omslag] ${jobId.slice(0, 8)} omslaget är inte bekräftat ${farg} — söker om med färgen`);
  }
  /**
   * Sidhämtningen görs numera också för SPECIFIKATIONERNAS skull, inte bara omslagets.
   *
   * Den hoppades tidigare över så fort kandidaten redan bar en bild — och det är precis de fallen där
   * annonsen ändå står utan mått eller material: sökningen grundade, struktureringen lät MÅTT-raderna
   * falla, och sidorna som faktiskt skriver ut dem var redan hämtade och kastade. Mätt på 138 sparade
   * annonser saknade 37 mått och 57 material.
   *
   * Kostar inget som säljaren märker: annonsen är redan publicerad här, hämtningen är HTTP och ingen
   * modell, och det som hittas skrivs in i den annons som ligger på skärmen — samma väg som ett sent
   * omförsök tar. Läses ur sidans egen HTML, aldrig gissat: se harvestSpecs.
   */
  const saknarSpecar =
    !listing.result?.attributes.some((a) => eget(a) && (a.kind === "dimension" || /(mått|bredd|djup|höjd|längd|diameter)/i.test(a.label))) ||
    !listing.result?.attributes.some((a) => a.kind === "material" || /(material|klädsel|stomme|träslag)/i.test(a.label));

  /** Sant när hämtningen görs BARA för specarnas skull: omslaget är redan satt och bekräftat. */
  const baraSpecar = !!gammal && !provaOm && saknarSpecar;

  void (gammal && !provaOm && !saknarSpecar
    ? Promise.resolve({ image: gammal as ProductImage, specs: [] as ListingAttribute[] })
    : resolveProductPage(
        { brand, model },
        [
          ...(listing.result?.sources ?? []),
          // Sidor specsökningen såg med en produktbild av just den här modellen. De går genom samma
          // kontroll som alla andra (modellnamnet måste synas), men de är det som finns att gå på för
          // en utgången modell vars tillverkarsida är borta.
          ...((getFacts()?.facts.productPages ?? []).map((url) => ({ title: model, url, qualityTier: 2 as const }))),
        ],
        farg,
      )
        // Utebliven ny bild får inte kosta den gamla. Se resonemanget ovan. Och en hämtning som
        // gjordes för MÅTTENS skull får inte byta ut ett omslag som redan är valt och bekräftat —
        // den sidan är vald efter vad den skriver, inte efter vad den visar.
        .then((r) => (baraSpecar || !r.image ? { image: gammal, specs: r.specs } : r))
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
        current.result.attributes = mergeSpecs(current.result.attributes, utanTillbakahallna(current.result, specs));
      }
      // Manualvägen bygger sin annons utan att passera slingan ovan, och ett mått ur minnet är
      // fortfarande bättre än den uppskattning som annars står kvar. Efter sidskörden: sidan först.
      if (minnet.length > 0 && current?.result) {
        current.result.attributes = mergeSpecs(current.result.attributes, utanTillbakahallna(current.result, minnet));
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
    const behallen = behallSaljarensRattelser(listing, afterListing.result?.listing ?? afterListing.pendingListing);
    if (afterListing.result) afterListing.result.listing = behallen;
    else afterListing.pendingListing = behallen;
    await persist(afterListing);
  }

  // Priset är redan inskrivet av sitt eget spår ovan. Väntan här är på att fas 2 ska vara slut, inte
  // på något som ska publiceras: den sista skrivningen finns för att annonsen kan ha landat i
  // `pendingListing` innan skickresultatet fanns, och ska flyttas in när det gör det.
  await pricePromise;
  const target = getJobSync(jobId) ?? (await getJob(jobId));
  if (!target?.result) return;
  target.result.identity = { brand, model };
  target.result.listing = behallSaljarensRattelser(listing, target.result.listing);
  await persist(target);
  console.info(`[identify] ${jobId.slice(0, 8)} fas2 klar total_ms=${Date.now() - startedAt}`);
}

/**
 * Säljarens rättade rader, burna över till en annons som pipelinen skriver om.
 *
 * Måttsteget visas så fort första annonsen finns, men pipelinen fortsätter efter det: ett omförsök
 * som hittar bättre mått, och den sista skrivningen när besiktningen blir klar, ersätter annonsen
 * HELT. Utan det här försvann en rättelse säljaren gjort i måttsteget tyst några sekunder senare —
 * värre än att aldrig ha fått rätta, för säljaren tror att det är gjort.
 *
 * Raden matchas på nyckel eller etikett och byts på sin plats; en rättad rad som den nya annonsen
 * saknar läggs sist. Säljarens värde går alltid före generatorns, också när generatorn fått en källa.
 */
export function behallSaljarensRattelser<T extends { result: GeneratedListing | null }>(
  ny: T,
  nu: ListingResult | null | undefined,
): T {
  const kvar = nu?.result?.attributes.filter((a) => a.sellerEdited) ?? [];
  if (!ny.result || kvar.length === 0) return ny;
  const samma = (a: ListingAttribute, b: ListingAttribute) =>
    a.key === b.key || a.label.trim().toLowerCase() === b.label.trim().toLowerCase();
  const attributes = ny.result.attributes.map((a) => {
    const i = kvar.findIndex((r) => samma(a, r));
    return i < 0 ? a : kvar.splice(i, 1)[0];
  });
  return { ...ny, result: { ...ny.result, attributes: [...attributes, ...kvar] } };
}

async function waitForCondition(jobId: string) {
  const until = Date.now() + CONDITION_WAIT_MS;
  while (Date.now() < until) {
    const job = getJobSync(jobId) ?? (await getJob(jobId));
    if (!job) return null;
    if (job.progress.stage === "error") return null;
    // En avbruten besiktning (jobbet kördes utan, skipGrading) levererar aldrig något: vänta inte ut tidsgränsen på det.
    if (!job.result && job.tasks?.condition?.status === "cancelled") return null;
    if (job.result && !job.result.reviewPending) return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * PROTOTYP — identifieringen kom utifrån (appens webbvy mot Googles AI-läge). Se externalIdentify.ts.
 *
 * Översätter svaret till kandidater på jobbet, så att väljarskärmen och resten av flödet fungerar oförändrat. Svaret ersätter ALDRIG ett val säljaren redan gjort, och
 * mått och material som följer med används först när säljaren väljer modellen — då genom den vanliga verifieringen (annons.ts).
 */
export async function applyExternalIdentification(
  jobId: string,
  answer: string,
  links: string[],
  opts: { specsPending?: boolean; imagesPending?: boolean } = {},
): Promise<{ ok: true; candidates: number; costUsd: number; items: Array<{ model: string; productType: string | null; undertyp: "barstol" | null }> } | { error: string }> {
  const job = await getJob(jobId);
  if (!job?.externalIdentify) return { error: "Jobbet väntar inte på en extern identifiering." };
  if (job.identityStatus !== "identifying") return { error: "Identiteten är redan avgjord." };
  const brand = job.identity?.brand?.trim() || "";
  let structured;
  try {
    structured = await withCostScope({ jobId, stage: "identify" }, () => structureExternalAnswer(answer, links, brand));
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    console.warn(`[identify] ${jobId.slice(0, 8)} AI-lägets svar gick inte att föra över: ${note}`);
    await failExternalIdentification(jobId, note, "Svaret från AI-läget gick inte att tolka. Skriv modellnamnet själv eller försök igen.");
    return { error: note };
  }
  const cleanLinks = cleanExternalLinks(links);
  const sources: SourceRef[] = cleanLinks.map((url) => ({ title: new URL(url).hostname.replace(/^www\./, ""), url }));
  const id = (structured.spec.identity ?? {}) as { variant?: unknown; category?: unknown; discontinued?: unknown };
  /**
   * Möbeltypen MÅSTE finnas på kandidaterna: utan den är sidtypsregeln och bildkontrollen avstängda. Svarets egna ord räcker ofta inte, så saknas den läses den ur säljarens
   * omslagsbild (ett anrop, se typFranFoto) — säljarens foto är den enda källa som alltid finns.
   */
  // Fotot går före svarets ord: det är säljarens verkliga möbel. Är typen redan läst (webben frågade efter den innan frågan till AI-läget) kostar det inget; annars läses den nu.
  let category: string | null = job.furnitureType ?? null;
  if (!category) category = (await furnitureTypeOf(jobId)).type;
  if (!category && typeof id.category === "string" && id.category.trim()) category = id.category.trim();
  const level = (c: "high" | "medium" | "low") => (c === "high" ? "strong" : c === "medium" ? "likely" : "possible");
  const mk = (model: string, confidence: "strong" | "likely" | "possible", evidence: string, detail: string | null, sourceUrl: string | null): ModelCandidate => ({
    brand,
    model,
    variant: typeof id.variant === "string" && model === structured.model ? id.variant : null,
    productType: category,
    confidence,
    distinguishingDetail: detail,
    evidence: [evidence],
    sourceUrl,
    productPages: [],
  });
  // Förslag 1 faller tillbaka på första länken (svarets källista handlar om det); ett alternativ får aldrig en orelaterad länk: dess referensbilder hämtas därifrån.
  const candidates: ModelCandidate[] = [
    mk(structured.model, level(structured.confidence), structured.confidenceReason || "Pekades ut av Googles AI-läge utifrån bilderna.", structured.confidenceReason?.slice(0, 160) ?? null, pickModelPage(cleanLinks, structured.model, brand) ?? cleanLinks[0] ?? null),
    ...structured.alternatives.map((a) => mk(a.model, level(a.confidence), a.why || "Nämndes som alternativ av Googles AI-läge.", a.why?.slice(0, 160) ?? null, a.sourceUrl ?? pickModelPage(cleanLinks, a.model, brand))),
  ];
  // Undertypen varje kandidat menar (en NORDVIKEN-BARSTOL är inte NORDVIKEN-matstolen), ur kandidatens egna ord. Går in i bildsökningen och bildkontrollen.
  for (const c of candidates) c.undertyp = undertypForKandidat(answer, c.model, [c.distinguishingDetail, ...(c.evidence ?? [])], c.sourceUrl);
  // Registrets bilder FÖRST, och redan innan korten sparas: en modell som någon sett förut (och vars bild klarat alla kontroller) har bilden framme när skärmen ritas, och appen behöver inte söka den.
  await Promise.all(
    candidates.map(async (c) => {
      const hit = await registreradKandidatbild(c.brand, c.model, registerTyp(c, answer)).catch(() => null);
      if (hit) {
        c.imageUrl = hit;
        c.imageSource = "register";
      }
    }),
  );
  // KEDJAN, STEG A (src/referensbild.ts): produktlänken AI-läget gav för modellen, om den är en riktig produktsida. Gratis och snabb (~2–6 s), körs för alla som saknar registerbild innan korten sparas, så att
  // appen bara behöver söka bilder (steg C, SerpApi) för de modeller A inte klarade. Laddningsskärmen väntar ändå på bilderna. Steget har ett tak; en kandidat som inte hann är inte klar och går vidare.
  if (referensKedjaPa()) {
    const saknar = candidates.filter((c) => !c.imageUrl);
    if (saknar.length > 0) {
      const traffar = await withCostScope({ jobId, stage: "identify" }, () => losProduktsidor(jobId, saknar.map((c) => tillRefKandidat(c, answer)), Number(process.env.LOOPA_REFERENS_A_MS ?? 20_000) || 20_000)).catch(() => new Map<string, { url: string; source: string }>());
      for (const c of saknar) {
        const t = traffar.get(c.model);
        if (t) {
          c.imageUrl = t.url;
          c.imageSource = t.source;
        }
      }
      await registreraMedUnderlag(jobId, answer, saknar.filter((c) => c.imageUrl)).catch(() => undefined);
      console.info(`[bild] ${jobId.slice(0, 8)} steg A (produktlänkar): bild åt ${saknar.filter((c) => c.imageUrl).map((c) => c.model).join(", ") || "ingen"}`);
    }
  }
  const behovBild = candidates.filter((c) => !c.imageUrl);
  const fresh = (await getJob(jobId)) ?? job;
  if (fresh.identityStatus !== "identifying") return { error: "Identiteten hann avgöras." };
  fresh.identityStatus = "needs_selection";
  fresh.candidates = candidates;
  fresh.identityResult = "candidates";
  fresh.identityError = null;
  fresh.identityResearch = { researchText: `IDENTIFIERING (Googles AI-läge)
${answer.slice(0, 6000)}`, sources };
  // `specPending` (äldre vägen): appen frågade efter mått och material för förslag 1 medan säljaren tittade på korten. Nu frågas det först efter valet (expectExternalSpecs).
  fresh.externalFacts = { model: structured.model, spec: structured.spec, links: cleanLinks, at: Date.now(), ...(opts.specsPending ? { specPending: true } : {}) };
  // Appens bildsökning är på väg: väljarskärmen får inte sluta vänta på bilder för att serverns egen bildjakt gav upp (applyExternalImages släpper flaggan).
  // Bara om någon kandidat saknar registerbild: har alla en är det inget att vänta på, och appen behöver inte söka (items nedan är bara de som saknar bild).
  if (opts.imagesPending && behovBild.length > 0) fresh.externalImagesPending = true;
  await persist(fresh);
  await setTask(jobId, "identify", "completed", { note: null });
  console.info(
    `[identify] ${jobId.slice(0, 8)} extern identifiering: ${candidates.map((c) => `${c.model}${c.undertyp ? `[${c.undertyp}]` : ""}(${c.confidence})${c.imageUrl ? "*" : ""}`).join(", ")} länkar=${cleanLinks.length} ≈$${structured.costUsd.toFixed(4)} (* = bild ur registret)`,
  );
  attachCandidateImages(jobId, candidates, sources, true);
  return {
    ok: true,
    candidates: candidates.length,
    costUsd: structured.costUsd,
    items: behovBild.map((c) => ({ model: c.model, productType: c.productType ?? null, undertyp: c.undertyp ?? null })),
  };
}

/** Det kedjan i referensbild.ts behöver veta om en kandidat, med AI-lägets beskrivning av just den modellen ur identifieringssvaret. */
const tillRefKandidat = (c: ModelCandidate, svar: string): RefKandidat => ({
  brand: c.brand,
  model: c.model,
  productType: c.productType ?? null,
  undertyp: c.undertyp ?? null,
  sourceUrl: c.sourceUrl ?? null,
  beskrivning: beskrivningUr(svar, c.model).beskrivning || c.evidence?.[0] || c.distinguishingDetail || null,
});

/**
 * Skriver bilderna till registret, men bara de som valts MED underlag: AI-lägets beskrivning av modellen eller säljarens foto. En bild som valts utan någotdera (omslag och beskrivning saknades) är
 * en gissning på namnet, och registret delas av alla säljare. Se registerTyp för nyckeln.
 */
async function registreraMedUnderlag(jobId: string, svar: string, kandidater: ModelCandidate[]): Promise<void> {
  const harFoto = !!(await saljarbild(jobId).catch(() => null));
  const med = kandidater.filter((c) => c.imageUrl && (harFoto || !!beskrivningUr(svar, c.model).beskrivning));
  if (med.length) await registreraKandidatbilder(med.map((c) => ({ brand: c.brand, model: c.model, typ: registerTyp(c, svar), url: c.imageUrl! })));
}

// Registrets nyckel för appens bilder (egen namnrymd "g:", med undertyp och modellens generation) byggs av registerTyp i referensbild.ts.

/**
 * Möbeltypen ur säljarens omslagsbild, för frågan till AI-läget ("vilka Sits fåtöljer kan det vara?") och för kandidaterna. Läses en gång per jobb och sparas.
 * Null när typen inte går att avgöra (annan möbel, ingen nyckel, nätfel): frågan ställs då utan typ.
 */
export async function furnitureTypeOf(jobId: string): Promise<{ type: string | null }> {
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job) return { type: null };
  if (job.furnitureType !== undefined) return { type: job.furnitureType };
  // Omslagsbilden, annars den skarpaste (flest bytes): samma val som appen gör för frågan till AI-läget. Sökvägen ligger under jobbets originals-mapp.
  const abs = (p: string) => path.join(jobDir(jobId), p.startsWith("originals/") ? "" : "originals", p);
  const images = job.images ?? [];
  const bySize = (await Promise.all(images.map(async (i) => ({ i, size: (await stat(abs(i.path)).catch(() => null))?.size ?? 0 })))).sort((a, b) => b.size - a.size)[0]?.i;
  const cover = images.find((i) => i.role === "cover") ?? bySize;
  const type = cover ? await withCostScope({ jobId, stage: "identify" }, () => typFranFoto(abs(cover.path))) : null;
  const fresh = getJobSync(jobId) ?? (await getJob(jobId));
  if (fresh) {
    fresh.furnitureType = type;
    await persist(fresh);
  }
  console.info(`[identify] ${jobId.slice(0, 8)} möbeltyp ur fotot: ${type ?? "okänd"}`);
  return { type };
}

/**
 * Säljaren har valt modell i appen: AI-läget ska nu avgöra vilken EXAKT variant det är (ur bilderna) och ange mått, material och nypris för just den. Frågan ställs av appen
 * och svaret kommer till applyExternalSpecs, men annonsen börjar byggas redan i samma andetag som valet — därför sätts väntan HÄR, före finalizeWithModel, så att specsteget
 * (byggAnnons) hittar `specPending` och väntar in svaret i stället för att göra en egen betald sökning. Förut frågades det för förslag 1 direkt, innan säljaren valt något.
 *
 * Varianten avgörs av AI-läget, så variantlistan (en gissad lista som säljaren annars får välja ur) hoppas över: variantOptions står som tom, och ingen fråga ställs.
 * Returnerar false när jobbet inte är ett appjobb (då gör servern som förut).
 */
export async function expectExternalSpecs(jobId: string, model: string): Promise<boolean> {
  const job = getJobSync(jobId) ?? (await getJob(jobId));
  if (!job?.externalIdentify) return false;
  job.externalFacts = { model, spec: {}, links: job.externalFacts?.links ?? [], at: Date.now(), specPending: true };
  if (job.variantChosen == null) job.variantOptions = [];
  await persist(job);
  return true;
}

/**
 * Svaret från AI-läget (variant, mått, material, nypris för modellen säljaren valde) kom. Översätts och läggs in på jobbet; specsteget, som väntar, går vidare.
 * `failed`: frågan gav inget svar — specen förblir tom, och specsteget går då Loopas vanliga väg (se annons.ts: en tom spec ersätter aldrig egen sökning).
 */
export async function applyExternalSpecs(
  jobId: string,
  input: ({ answer: string; links: string[] } | { failed: string }) & { model?: string },
): Promise<{ ok: boolean; facts?: boolean; costUsd?: number }> {
  const job = await getJob(jobId);
  const ext = job?.externalFacts;
  if (!job || !ext) return { ok: false };
  // Ett sent svar på en TIDIGARE fråga (säljaren hann byta modell): det hör inte till modellen vi nu väntar på och får varken fylla i specen eller släppa väntan.
  if (input.model && slugKey(input.model) !== slugKey(ext.model)) {
    console.warn(`[identify] ${jobId.slice(0, 8)} måttsvar för "${input.model}" ignorerat: väntar på "${ext.model}"`);
    return { ok: false };
  }
  const done = async (spec: Record<string, unknown> | null) => {
    const fresh = (await getJob(jobId)) ?? job;
    if (!fresh.externalFacts) return;
    fresh.externalFacts = { ...fresh.externalFacts, ...(spec ? { spec } : {}), specPending: false };
    await persist(fresh);
  };
  if ("failed" in input) {
    console.warn(`[identify] ${jobId.slice(0, 8)} måttfrågan gav inget svar: ${input.failed.slice(0, 120)}`);
    await done(null);
    return { ok: true, facts: false };
  }
  const brand = job.identity?.brand?.trim() || "";
  try {
    const r = await withCostScope({ jobId, stage: "specs" }, () => structureExternalSpecs(input.answer, input.links, brand, ext.model));
    const merged = mergeExternalSpec(ext.spec, r.spec);
    await done(merged);
    console.info(`[identify] ${jobId.slice(0, 8)} externa mått för ${ext.model}: ${(Array.isArray(merged.dimensions) ? merged.dimensions.length : 0)} mått, ${(Array.isArray(merged.materials) ? merged.materials.length : 0)} material ≈$${r.costUsd.toFixed(4)}`);
    return { ok: true, facts: specHasFacts(merged), costUsd: r.costUsd };
  } catch (err) {
    console.warn(`[identify] ${jobId.slice(0, 8)} måttsvaret gick inte att föra över: ${err instanceof Error ? err.message : err}`);
    await done(null);
    return { ok: true, facts: false };
  }
}

/**
 * Referensbilder ur Googles bildsök (appens webbvy) kom: en lista rader (miniatyradress, sidtitel, storlek) per modell. Se externalImages.ts.
 *
 * Per kandidat: de bästa raderna (pickImageRows) hämtas hem parallellt, var och en prövas av fotokontrollen (candidateType.ts) parallellt, och den första i svarets ordning som är
 * ett foto av rätt typ blir kortets bild. En kandidat som redan har en bild behåller den — det som kom först var också kontrollerat. Ingen bild som klarar kontrollen = ingen ändring.
 */
export function applyExternalImages(
  jobId: string,
  groups: Array<{ model: string; rows: unknown }>,
  /** `final`: appen skickar inga fler rader (annars väntar den med ett andra försök för de modeller som blev utan bild, och väljarskärmen får vänta vidare). */
  opts: { final?: boolean } = {},
): Promise<{ ok: boolean; set: string[]; none: string[] }> {
  // Bildvalen (C) och steg B anropar Gemini; i jobbets kostnadsbok hamnar de bara om de körs i jobbets scope. Anropet kommer från en HTTP-väg, utan ett.
  return withCostScope({ jobId, stage: "identify" }, () => applyExternalImagesInner(jobId, groups, opts));
}

async function applyExternalImagesInner(
  jobId: string,
  groups: Array<{ model: string; rows: unknown }>,
  opts: { final?: boolean },
): Promise<{ ok: boolean; set: string[]; none: string[] }> {
  const job = (getJobSync(jobId) ?? (await getJob(jobId))) ?? null;
  if (!job?.candidates?.length) return { ok: false, set: [], none: [] };
  // Bildsökningen är klar (också när den gav noll rader eller föll: appen skickar då tom lista): väljarskärmen får sluta vänta. Se externalImagesPending.
  const releasePending = async () => {
    const f = getJobSync(jobId) ?? (await getJob(jobId));
    if (f?.externalImagesPending) {
      f.externalImagesPending = false;
      await persist(f);
    }
  };
  const brand = job.identity?.brand?.trim() || "";
  // AI-lägets identifieringssvar (lagras på jobbet): beskrivningen av varje modell ur det följer med till bildvalet.
  const svarText = job.identityResearch?.researchText ?? "";
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9åäö]+/g, "");
  const picked = await Promise.all(
    job.candidates.map(async (c): Promise<{ model: string; url: string | null } | null> => {
      const group = groups.find((g) => key(g.model) === key(c.model));
      if (!group || c.imageUrl) return null;
      const fam = typfamilj(c.productType);
      const undertyp = c.undertyp ?? null;
      const rows = pickReferenceRows(group.rows, c.model, brand, c.productType ?? null, undertyp);
      // KEDJAN, STEG C: rader med sajt och sida (SerpApi). Reglerna ovan har redan gallrat (märket i titel/adress, ingen prisjämförare); här väljer ETT jämförande anrop den bästa bland högst fem, eller ingen.
      // Andrahandsannonser ingår inte: deras foton är sällan ett bra referensfoto, och B tar de modeller som blir utan. Rader utan sajtuppgift (skalets) går den gamla vägen nedan.
      const harSajt = (group.rows as Array<{ source?: unknown; page?: unknown }> | undefined)?.some((r) => typeof r?.page === "string" || typeof r?.source === "string") === true;
      if (referensKedjaPa() && harSajt) {
        const rad = new Map((group.rows as Array<{ src: string; alt?: string; source?: string; page?: string }>).map((r) => [r.src, r]));
        // Upp till valMax() (förval 8) bilder efter att dubbletter tagits bort: samma Instagram-bild tre gånger hade tagit tre av fem platser, och rätt PREBEN-bild låg på plats nio (2026-11-12).
        const tillVal = unikaKallor(rows.filter((r) => !r.marketplace), (r) => ({ sida: rad.get(r.src)?.page, titel: rad.get(r.src)?.alt, kalla: rad.get(r.src)?.source })).slice(0, valMax());
        console.info(`[bild] ${jobId.slice(0, 8)} ${c.model}: steg C — ${(group.rows as unknown[]).length} träffar, ${rows.length} klarade reglerna, ${tillVal.length} går till valet (andrahandsannonser undantagna)`);
        const vinnare = await valjBland(
          { brand, model: c.model, ord: typOrd(c), beskrivning: beskrivningUr(svarText, c.model).beskrivning || c.evidence?.[0] || c.distinguishingDetail || null, jobId },
          tillVal.map((r) => ({ src: r.src, titel: rad.get(r.src)?.alt ?? "", kalla: rad.get(r.src)?.source, referer: null })),
        ).catch(() => null);
        return { model: c.model, url: vinnare?.lokal ?? null };
      }
      // Varje rad hämtas och bedöms PARALLELLT, med ALLA kontroller i ett anrop (typ, katalogfoto, undertyp): bilden är kortets enda bevis för vilken möbel modellen är.
      const bedomda = rows.map(async (r): Promise<{ url: string | null; check: ReferenceCheck }> => {
        const url = await lokalKandidatbild(r.src, null).catch(() => null);
        if (!url) return { url: null, check: { local: false, marketplace: r.marketplace, typ: null, katalog: null, undertyp: null } };
        if (!fam) return { url, check: { local: true, marketplace: r.marketplace, typ: true, katalog: null, undertyp: null } };
        const b = await bedomReferensbild(url, fam, undertyp).catch(() => ({ typ: null, katalog: null, undertyp: null }));
        return { url, check: { local: true, marketplace: r.marketplace, ...b } };
      });
      // Första godkända katalogfotot i rangordningen vinner så snart dess svar finns (valjReferensbild); finns inget, reserven. Ingen bild hellre än fel bild.
      const i = await valjReferensbild(bedomda.map((p) => p.then((x) => x.check)));
      return { model: c.model, url: i >= 0 ? (await bedomda[i]).url : null };
    }),
  );
  let fresh = getJobSync(jobId) ?? (await getJob(jobId));
  if (!fresh?.candidates) return { ok: false, set: [], none: [] };
  const set: string[] = [];
  const none: string[] = [];
  for (const p of picked) {
    if (!p) continue;
    const c = fresh.candidates.find((x) => x.model === p.model);
    if (!c || c.imageUrl) continue;
    if (p.url) {
      c.imageUrl = p.url;
      c.imageSource = "https://www.google.com/search?udm=2&q=" + encodeURIComponent(`${brand} ${c.model} ${c.undertyp ?? c.productType ?? ""}`.trim());
      set.push(c.model);
    } else none.push(c.model);
  }
  // KEDJAN, STEG B (SIST): appens slutliga lista är inne (`final`) och några modeller saknar fortfarande bild. Bara dem frågar vi Gemini med webbsök om (≈0,3 kr per modell, sökavgiften dominerar, därför sist).
  // Också när appens bildsökning föll och den skickade en tom lista: då saknar alla bild och B är det som återstår. C:s bilder sparas först, så att ett fel i B aldrig tar dem. Registret får B:s bilder som de andras.
  if (opts.final && referensKedjaPa()) {
    const saknas = fresh.candidates.filter((c) => !c.imageUrl);
    if (saknas.length > 0) {
      if (set.length) await persist(fresh);
      const viaB = await losFranSokningar(jobId, saknas.map((c) => tillRefKandidat(c, svarText))).catch(() => new Map<string, { url: string; source: string }>());
      fresh = getJobSync(jobId) ?? (await getJob(jobId)) ?? fresh;
      for (const [model, t] of viaB) {
        const c = fresh.candidates?.find((x) => x.model === model);
        if (!c || c.imageUrl) continue;
        c.imageUrl = t.url;
        c.imageSource = t.source;
        set.push(model);
        const i = none.indexOf(model);
        if (i >= 0) none.splice(i, 1);
      }
      console.info(`[bild] ${jobId.slice(0, 8)} steg B (Gemini med webbsök): bild åt ${[...viaB.keys()].join(", ") || "ingen"}; frågade för ${saknas.map((c) => c.model).join(", ")}`);
    }
  }
  if (!fresh.candidates) return { ok: false, set: [], none: [] };
  // Sista listan: det som fortfarande saknar bild får sitt besked ("ingen bild", null). Förut stod det kvar som "letar", och väljarskärmen väntade på en bild som ingen längre sökte efter.
  const nullade = opts.final ? fresh.candidates.filter((c) => c.imageUrl === undefined).map((c) => { c.imageUrl = null; return c.model; }) : [];
  if (set.length || nullade.length) {
    await persist(fresh);
    // Registret skrivs bara av bilder som klarat ALLA kontroller och valts med underlag (beskrivning eller säljarens foto), under appens egna nycklar (registerTyp).
    await registreraMedUnderlag(jobId, svarText, fresh.candidates.filter((c) => set.includes(c.model) && c.imageUrl));
  }
  if (opts.final || none.length === 0) await releasePending();
  console.info(`[bild] ${jobId.slice(0, 8)} Googles bildsök: bild åt ${set.join(", ") || "ingen"}${none.length ? `; ingen godkänd bild åt ${none.join(", ")}` : ""}`);
  return { ok: true, set, none };
}

/** Webbvyn kom inte fram till något svar (captcha som aldrig löstes, sidan ändrad, nätet): ett ärligt tomt val, aldrig en väntan utan slut. */
export async function failExternalIdentification(jobId: string, reason: string, message = "Googles AI-läge gav inget svar. Skriv modellnamnet själv eller försök igen."): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job?.externalIdentify || job.identityStatus !== "identifying") return false;
  job.identityStatus = "needs_selection";
  job.candidates = [];
  job.identityResult = "unavailable";
  job.identityError = message;
  await persist(job);
  await setTask(jobId, "identify", "failed", { note: reason.slice(0, 200) });
  return true;
}
