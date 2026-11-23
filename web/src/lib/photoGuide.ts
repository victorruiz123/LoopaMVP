/**
 * Bildguidens regler: vilka steg som finns, vad som räknas som en bild, och i vilken ordning bilderna går iväg.
 *
 * Ren logik, utan DOM och utan React, så att reglerna går att testa utan en webbläsare (tests/photoGuide.test.ts).
 * Skärmen (components/PhotoCaptureFlow.tsx) äger bara det som ritas; ALLT som är en regel står här.
 *
 * VARFÖR FOTON I STÄLLET FÖR FILM. Bildrutor ur en film väljs av en heuristik som inte vet vad bilden visar,
 * och blev ofta suddiga, mörka eller sneda. Här VET vi vad varje bild ska visa: säljaren ombeds ställa sig på
 * ett bestämt ställe och trycka av, så etiketten är något vi frågat efter — och den följer med bilden hela
 * vägen in i besiktningen (se server/src/pipeline/inspect.ts, describeImages).
 *
 * MINST FEM, OCH DET ÄR KÄRNAN: omslag, framifrån, vänster, baksida, höger. Ovanifrån och närbild är valfria,
 * och i slutet går det att lägga till fler (upp till MAX_PHOTOS). Varje steg går att hoppa över — kravet
 * prövas först när säljaren går vidare, inte vid varje steg. Ett formulär som stoppar en vid första
 * "hoppa över" hade gjort guiden till något man tvingas igenom.
 */

import { OMSLAGSSTATION, PHOTO_STATIONS, type PhotoStation } from "./photoStations";

/**
 * Minsta antal bilder. Servern har samma siffra (GUIDE_MIN_PHOTOS i server/src/config.ts) och avvisar
 * en uppladdning under den — de två ska vara lika, men servern är den som har sista ordet.
 */
export const MIN_PHOTOS = 5;

/** Taket. Servern kapar vid samma siffra (MAX_IMAGES_PER_JOB) — guiden ska aldrig be om en bild som tyst kastas. */
export const MAX_PHOTOS = 10;

export interface GuideStep extends PhotoStation {
  /** Ingår i kärnan på fem. Valfria steg är ovanifrån och närbild. */
  core: boolean;
  /**
   * Kort namn för stegraden och översikten, där sju steg delar en telefonbredd (≈47 px var). `label` är det som
   * skickas till servern och är för långt: "Omslagsbild" bröts mitt i ordet. Högst åtta tecken.
   */
  short: string;
}

const SHORT: Record<string, string> = {
  cover: "Omslag",
  front: "Framsida",
  left: "Vänster",
  back: "Baksida",
  right: "Höger",
  top: "Ovan",
  closeup: "Närbild",
};

/**
 * Texterna är skrivna för vilken möbel som helst: guiden ritar en soffa (GuideScene), men säljaren kan sälja
 * en stol eller ett bord, och "armstöd" säger då ingenting. "Sett framifrån" i sidorna är med flit: att gå åt
 * SITT vänster från framsidan ger möbelns vänstra sida sedd framifrån, vilket är vad etiketten betyder —
 * utan förklaringen läser hälften "vänster" som möbelns egen vänster.
 */
const COPY: Record<string, { title: string; instruction: string }> = {
  cover: {
    title: OMSLAGSSTATION.title,
    instruction: OMSLAGSSTATION.instruction,
  },
  front: {
    title: "Rakt framifrån",
    instruction: "Stå mitt framför möbeln och backa tills hela den syns, med golvet under.",
  },
  left: {
    title: "Vänster sida",
    instruction: "Sett framifrån: gå ett kvarts varv åt vänster. Hela sidan och benen ska synas.",
  },
  back: {
    title: "Baksidan",
    instruction: "Fortsätt runt. Står möbeln mot en vägg, ta det du kommer åt eller hoppa över.",
  },
  right: {
    title: "Höger sida",
    instruction: "Sett framifrån: sista sidan, mitt emot den du nyss tog. Hela sidan och benen ska synas.",
  },
  top: {
    title: "Ovanifrån",
    instruction: "Luta telefonen ner mot sits eller skiva. Nedsuttet tyg och repor i ytor syns bäst uppifrån.",
  },
  closeup: {
    title: "Närbild på skador",
    instruction:
      "Gå nära det du själv skulle peka på: fläckar, repor, sprickor, nedsuttet tyg. Finns inget att visa, hoppa över.",
  },
};

const NOT_CORE = new Set(["top", "closeup"]);

/** Stegen i den ordning guiden går dem: omslaget först, sedan varvet, sedan de två valfria. */
export const GUIDE_STEPS: GuideStep[] = [OMSLAGSSTATION, ...PHOTO_STATIONS].map((s) => ({
  ...s,
  ...(COPY[s.id] ?? {}),
  core: !NOT_CORE.has(s.id),
  short: SHORT[s.id] ?? s.label,
  // Det som visas som "valfri" i PhotoGuide: samma sak som att inte vara kärna.
  required: !NOT_CORE.has(s.id),
}));

/**
 * En extra bild, lagd till i slutet. Står utanför stegtabellen: den har inget "ställe" att stå på, och
 * räknas bara mot taket. Etiketten matchas på servern (imageRoles.ts) för att hålla den utanför
 * modellidentifieringen — den visar en detalj, inte möbelns form.
 */
export const EXTRA_STEP: GuideStep = {
  ...PHOTO_STATIONS.find((s) => s.id === "closeup")!,
  id: "extra",
  label: "Extra bild",
  title: "Extra bild",
  instruction: "Fotografera en skada eller detalj du vill visa. Gå nära och se till att ytan syns skarpt.",
  required: false,
  core: false,
  short: "Extra",
};

export type ShotOrigin = "camera" | "upload";

export interface GuideShot {
  id: string;
  dataUrl: string;
  /** Vilket steg bilden hör till. Null för en extra bild. */
  stepId: string | null;
  /** Det som skickas till servern som `viewLabel`. */
  viewLabel: string | null;
  origin: ShotOrigin;
}

let counter = 0;
export const newShotId = (): string => `p${++counter}`;

export function makeShot(dataUrl: string, step: GuideStep | null, origin: ShotOrigin): GuideShot {
  return { id: newShotId(), dataUrl, stepId: step?.id ?? null, viewLabel: step ? step.label : EXTRA_STEP.label, origin };
}

export const stepIndex = (id: string): number => GUIDE_STEPS.findIndex((s) => s.id === id);

/** Bilden som hör till ett steg, om det finns en. */
export function shotFor(shots: GuideShot[], stepId: string): GuideShot | undefined {
  return shots.find((s) => s.stepId === stepId);
}

/** Stegen och deras bilder som `PhotoGuide` visar i stegraden: stegets id → bildens data-URL. */
export function takenByStep(shots: GuideShot[]): Record<string, string> {
  return Object.fromEntries(shots.flatMap((s) => (s.stepId ? [[s.stepId, s.dataUrl]] : [])));
}

/** Går en bild till? Antingen ersätter den en som redan finns i steget, eller så ryms den under taket. */
export function canPlace(shots: GuideShot[], stepId: string | null): boolean {
  if (stepId !== null && shotFor(shots, stepId)) return true;
  return shots.length < MAX_PHOTOS;
}

/**
 * Lägger en bild i ett steg. Finns det redan en där ERSÄTTS den — ett omtag är inte en andra bild, och ett
 * suddigt försök ska inte ligga kvar och räknas. Ryms den inte (taket) returneras listan oförändrad.
 */
export function placeShot(shots: GuideShot[], shot: GuideShot): GuideShot[] {
  if (!canPlace(shots, shot.stepId)) return shots;
  if (shot.stepId !== null && shotFor(shots, shot.stepId)) {
    return shots.map((s) => (s.stepId === shot.stepId ? shot : s));
  }
  return [...shots, shot];
}

export const removeShot = (shots: GuideShot[], id: string): GuideShot[] => shots.filter((s) => s.id !== id);

/** Olika bilder, den första av varje. Samma foto fem gånger är inte fem bilder av möbeln. */
export function distinctShots(shots: GuideShot[]): GuideShot[] {
  const seen = new Set<string>();
  return shots.filter((s) => (seen.has(s.dataUrl) ? false : (seen.add(s.dataUrl), true)));
}

export const photoCount = (shots: GuideShot[]): number => distinctShots(shots).length;
export const remainingToMin = (shots: GuideShot[]): number => Math.max(0, MIN_PHOTOS - photoCount(shots));
export const canSubmit = (shots: GuideShot[]): boolean => photoCount(shots) >= MIN_PHOTOS;

/** Kärnstegen som saknar bild, i guidens ordning. Det är de besiktningen inte kommer att kunna uttala sig om. */
export function missingCore(shots: GuideShot[]): GuideStep[] {
  return GUIDE_STEPS.filter((s) => s.core && !shotFor(shots, s.id));
}

/** Första kärnsteget utan bild — dit "Ta {steg}" i granskningen hoppar. Null när alla är tagna. */
export const firstMissingCore = (shots: GuideShot[]): GuideStep | null => missingCore(shots)[0] ?? null;

/**
 * Nästa steg utan bild efter `fromId`, eller null när inget finns längre fram — då är guiden slut och
 * granskningen tar vid. Går bara FRAMÅT: att hoppa tillbaka till ett steg man hoppat över är ett val, via
 * stegraden eller granskningen, inte något guiden gör åt en.
 */
export function nextOpenStep(shots: GuideShot[], fromId: string): GuideStep | null {
  const from = stepIndex(fromId);
  for (let i = from + 1; i < GUIDE_STEPS.length; i++) {
    if (!shotFor(shots, GUIDE_STEPS[i].id)) return GUIDE_STEPS[i];
  }
  return null;
}

/** Är det här det sista steget i guiden? Då leder "Hoppa över" och en tagen bild rakt till granskningen. */
export const isLastStep = (id: string): boolean => stepIndex(id) === GUIDE_STEPS.length - 1;

/**
 * Bilderna i den ordning de skickas: omslaget först, sedan stegen i guidens ordning, sedan de extra i den
 * ordning de togs. Servern lägger ändå omslaget först (prepareUploads), men en klient ska inte förlita sig på
 * det — och ordningen är det modellen ser ("Bild 0: omslagsbild, Bild 1: foto (Framifrån) …").
 */
export function orderForUpload(shots: GuideShot[]): GuideShot[] {
  const extras = shots.filter((s) => s.stepId === null);
  const staged = shots
    .filter((s) => s.stepId !== null)
    .sort((a, b) => stepIndex(a.stepId!) - stepIndex(b.stepId!));
  return distinctShots([...staged, ...extras]);
}

/** Det som skickas till servern. `role: "cover"` sitter bara på omslagsbilden. */
export interface UploadShot {
  dataUrl: string;
  viewLabel: string | null;
  source: "manual";
  role?: "cover";
}

export function toPayload(shots: GuideShot[]): UploadShot[] {
  return orderForUpload(shots).map((s) => ({
    dataUrl: s.dataUrl,
    viewLabel: s.viewLabel,
    source: "manual" as const,
    ...(s.stepId === "cover" ? { role: "cover" as const } : {}),
  }));
}

/** "Saknas: framifrån, baksidan" — stegen som en mening, för varningen i granskningen. */
export const stepLabels = (steps: GuideStep[]): string[] => steps.map((s) => s.label.toLowerCase());
