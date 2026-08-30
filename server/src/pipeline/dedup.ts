import type { Damage, DamageType, EvidenceMark } from "../types.js";

const IOU_MERGE_THRESHOLD = 0.25;
/** Två OLIKA typer i samma familj måste överlappa tydligare än två av samma typ för att vara samma märke. */
const IOU_CROSS_TYPE_THRESHOLD = 0.4;
/** Hur mycket av den kortare etikettens ord som måste återfinnas i den längre. */
const LABEL_SIMILARITY_THRESHOLD = 0.5;

/**
 * Skadetyper modellen använder om vartannat för SAMMA fysiska märke.
 *
 * Ett skavmärke på ett vitmålat ben heter `scuff` i en bildruta och `worn_material` i nästa, och
 * exakt typmatchning gjorde då två fynd av ett. Familjerna är avsiktligt smala: de samlar bara typer
 * som beskriver samma sorts avvikelse på samma sorts yta. En `scratch` och en `stain` hamnar aldrig
 * i samma familj, hur nära varandra de än sitter.
 */
const TYPE_FAMILY: Partial<Record<DamageType, string>> = {
  scratch: "ytavskav",
  scuff: "ytavskav",
  abrasion: "ytavskav",
  worn_material: "ytavskav",
  general_wear: "ytavskav",
  stain: "färgavvikelse",
  discoloration: "färgavvikelse",
  fading: "färgavvikelse",
  chip: "materialförlust",
  peeling_flaking: "materialförlust",
  rust: "korrosion",
  corrosion: "korrosion",
  pilling: "fiberslitage",
  fraying: "fiberslitage",
  compressed_upholstery: "stoppning",
  sagging: "stoppning",
};

/** Typer som säger något konkret om skadan. `general_wear`/`other` gör det inte och får aldrig bli primär. */
const VAGUE_TYPES = new Set<DamageType>(["general_wear", "other"]);

function familyOf(type: DamageType): string {
  return TYPE_FAMILY[type] ?? type;
}

/**
 * Lägesord, grupperade i AXLAR. Två etiketter som anger olika värden på samma axel beskriver två
 * skilda ställen — "vänster framben" och "höger framben" är inte samma ben, och får aldrig slås ihop
 * hur lika resten av orden än är. Det här är spärren som gör att den luddiga matchningen nedan kan
 * vara generös utan att kollapsa skilda skador till en.
 *
 * `zon` är härledd, inte skriven: mitten av en yta är inte dess kant, så ett fynd i "mitten" slås
 * aldrig ihop med ett som sitter vid en kant, ett hörn eller en ände.
 */
const AXES: Array<{ axis: string; values: Array<{ value: string; cues: string[] }> }> = [
  { axis: "sida", values: [
    { value: "vänster", cues: ["vänst"] },
    { value: "höger", cues: ["höger", "högr"] },
  ] },
  { axis: "djup", values: [
    { value: "fram", cues: ["fram", "främ"] },
    { value: "bak", cues: ["bak"] },
  ] },
  { axis: "höjd", values: [
    { value: "upp", cues: ["över", "övre", "ovan", "topp", "högst"] },
    { value: "ner", cues: ["nedre", "ned", "ner", "under", "botten", "golv"] },
  ] },
  { axis: "zon", values: [
    { value: "mitt", cues: ["mitt", "central"] },
    { value: "kant", cues: ["kant", "hörn", "änd"] },
  ] },
];

const ALL_CUES = AXES.flatMap((a) => a.values.flatMap((v) => v.cues));

/**
 * Ord som inte pekar ut något: fyllnadsord, och de generiska ytorden som blir kvar när ett lägesord
 * lyfts ur en sammansättning ("ovansida" -> "sida"). De skiljer inte två skador åt, och att låta dem
 * räknas som innehåll gjorde "utsidan" och "ovansidan" till samma ställe.
 */
const EMPTY_TOKENS = new Set([
  "av", "och", "den", "det", "som", "med", "mot", "vid", "invid", "intill", "nära", "strax", "precis",
  "längs", "runt", "omkring", "där", "hela", "lite", "sida", "kant", "del", "parti", "yta", "ytan",
  "område", "ställe", "punkt",
]);

/**
 * Bestämd form och genitiv bort: "sitsens", "sitsen" och "sits" är samma ord. Grovt med flit — det
 * ska tåla att modellen skriver samma del olika i två bildrutor, inte vara språkriktigt.
 *
 * "ben" är undantaget som måste stå här: `framben` slutar på -en utan att vara bestämd form, och
 * avstympat till "framb" gick benet inte längre att matcha mot "vänstra benet".
 */
function stem(token: string): string {
  if (token.length >= 5 && token.endsWith("ben")) return token;
  for (const suffix of ["ens", "ets", "erna", "arna", "orna", "en", "et", "er", "ar", "or", "na", "s"]) {
    if (token.length - suffix.length >= 3 && token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

/** Lägesorden skalas av i ändarna av ordet: "överkanten" -> "kant" -> tomt, "framben" -> "ben". */
function stripCues(token: string): string {
  let t = token;
  let changed = true;
  while (changed && t.length > 0) {
    changed = false;
    for (const cue of ALL_CUES) {
      if (t === cue) return "";
      if (t.startsWith(cue)) {
        t = t.slice(cue.length);
        changed = true;
      } else if (t.endsWith(cue)) {
        t = t.slice(0, -cue.length);
        changed = true;
      }
    }
  }
  return t;
}

/**
 * Orden som de står, bara gemener. OBÖJDA — lägesorden känns igen på det oböjda ordet ("höger", inte
 * stammen "hög", som är toppen på något helt annat), och stammen tas där den behövs i stället.
 */
function tokenize(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-zà-öø-ÿ0-9]+/i)
    .filter((t) => t.length >= 2);
}

function hasCue(tokens: string[], cues: string[]): boolean {
  return tokens.some((t) => cues.some((c) => t.includes(c)));
}

/** Axelvärden en etikett faktiskt uttalar sig om. Axlar den är tyst om står inte i vägen för en sammanslagning. */
function positionsOf(tokens: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const { axis, values } of AXES) {
    const hits = values.filter((v) => hasCue(tokens, v.cues));
    // Både "övre" och "nedre" i samma etikett ("från överkant till nederkant") säger ingenting
    // avgörande om läget — då är axeln tyst i stället för motsägelsefull.
    if (hits.length === 1) found.set(axis, hits[0].value);
  }
  return found;
}

/** Två lägen som uttryckligen motsäger varandra på någon axel. */
function positionsConflict(a: string[], b: string[]): boolean {
  const pa = positionsOf(a);
  const pb = positionsOf(b);
  for (const [axis, value] of pa) {
    const other = pb.get(axis);
    if (other && other !== value) return true;
  }
  return false;
}

/**
 * Ord som bär betydelse när lägesorden räknats bort — det är dessa som ska likna varandra. Lägesorden
 * hanteras för sig, av axlarna: de avgör om två lägen MOTSÄGER varandra, vilket ordlikhet inte kan.
 */
function contentTokens(tokens: string[]): string[] {
  return tokens
    // Lägesordet lyfts UR sammansättningen i stället för att kasta hela ordet: "framben" är ett ben,
    // och att stryka det som "fram" gjorde delen namnlös och omöjlig att matcha mot "vänstra benet".
    // Stammen tas mellan de två avskalningarna, eftersom det som blir kvar ("kanten" ur "överkanten")
    // är böjt och annars inte känns igen som ett lägesord.
    .map((t) => stripCues(stem(stripCues(t))))
    .filter((t) => t.length >= 3 && !EMPTY_TOKENS.has(t));
}

/**
 * Andel av den KORTARE ordmängden som återfinns i den längre, med sammansättningar räknade som
 * träff: "sitsram" och "sitsens ram" är samma del, och exakt strängmatchning såg dem som två.
 */
function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const hits = short.filter((t) => long.some((o) => sameWord(t, o)));
  return hits.length / short.length;
}

/** "ben" i "stolsben", "ram" i "sitsram": sammansättningar är samma del sagd på ett annat sätt. */
function sameWord(a: string, b: string): boolean {
  return a === b || (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b));
}

/**
 * Kan de två fynden ÖVER HUVUD TAGET vara samma fysiska skada?
 *
 * Svarar bara på det grova: samma skadefamilj, och inga lägesord som motsäger varandra. Används av
 * granskningen i verify.ts, som har modellens egen dom om att två utsnitt visar samma märke — då är
 * det den domen som ska väga, och den här spärren finns bara för att den aldrig ska kunna slå ihop
 * vänster ben med höger.
 */
export function plausiblySameDamage(a: Damage, b: Damage): boolean {
  if (familyOf(a.type) !== familyOf(b.type)) return false;
  const ta = tokenize(`${a.part} ${a.semanticLocation}`);
  const tb = tokenize(`${b.part} ${b.semanticLocation}`);
  return !positionsConflict(ta, tb);
}

/** Samma fråga, men på vårt eget underlag: här krävs dessutom att orden faktiskt pekar på samma ställe. */
function canMerge(a: Damage, b: Damage): boolean {
  if (!plausiblySameDamage(a, b)) return false;

  const partA = contentTokens(tokenize(a.part));
  const partB = contentTokens(tokenize(b.part));
  if (similarity(partA, partB) < LABEL_SIMILARITY_THRESHOLD) return false;

  // Ett läge som bara upprepar delens egna ord ("sitsens ovansida" på delen "sitsen") säger ingenting
  // utöver delen, och ska inte räknas som något att likna.
  const locA = distinctiveLocation(a, partA);
  const locB = distinctiveLocation(b, partB);
  if (locA.length > 0 && locB.length > 0) return similarity(locA, locB) >= LABEL_SIMILARITY_THRESHOLD;

  // Minst en av dem säger inget eget om läget utöver lägesorden ("nedre delen nära golvet"). Då är
  // lägesorden allt vi har: antingen är båda tysta — och då finns det ingenting som skiljer fynden
  // åt — eller så måste de peka åt SAMMA håll på minst en axel. "sitsens ovansida" och "främre högra
  // hörnet" motsäger inte varandra, men de pekar inte heller åt samma håll, och att slå ihop dem hade
  // gjort en repa på sitsytan och ett skav i hörnet till samma skada.
  const posA = positionsOf(tokenize(`${a.part} ${a.semanticLocation}`));
  const posB = positionsOf(tokenize(`${b.part} ${b.semanticLocation}`));
  if (posA.size === 0 && posB.size === 0) return true;
  return [...posA].some(([axis, value]) => posB.get(axis) === value);
}

function distinctiveLocation(d: Damage, partTokens: string[]): string[] {
  return contentTokens(tokenize(d.semanticLocation)).filter((t) => !partTokens.some((p) => sameWord(p, t)));
}

/**
 * Local safety net, run AFTER the main Gemini call — which is already explicitly instructed to
 * consolidate the same physical defect across views into one entry. This catches whatever slips through.
 *
 * Pass 1 — same image, overlapping box (IoU) within one damage family: the case where Gemini reports
 * one spot twice within a single photo, sometimes under two names for the same mark.
 *
 * Pass 2 — same family, across images, when part and location point at the same place. Matchningen är
 * LUDDIG med flit: modellen skriver "sitsens ram" i en bildruta och "sitsens sarg" i nästa, och en
 * nyckel på exakta strängar såg då två skador där det fanns en. Spärren mot att gå för långt är
 * lägesorden — vänster/höger, fram/bak, över/under, mitten/kant — som aldrig får motsäga varandra.
 * Bounding boxes are never IoU-compared ACROSS different images — they don't share a coordinate system.
 *
 * Varje sammanslagning betyder att skadan får bevis i FLER bildrutor: bevisen slås ihop, och kortet
 * kan märka ut samma skada i var och en av dem.
 */
export function dedupeDamages(damages: Damage[]): Damage[] {
  const afterIou = mergeByIouWithinImage(damages);
  return mergeByPlace(afterIou);
}

function mergeByIouWithinImage(damages: Damage[]): Damage[] {
  const groups = new Map<string, Damage[]>();
  for (const d of damages) {
    const primaryImageId = d.evidence[0]?.imageId ?? `__no_evidence_${d.id}`;
    const key = `${primaryImageId}::${familyOf(d.type)}`;
    const group = groups.get(key);
    if (group) group.push(d);
    else groups.set(key, [d]);
  }

  const result: Damage[] = [];
  for (const group of groups.values()) {
    result.push(...clusterBy(group, (a, b) => {
      const threshold = a.type === b.type ? IOU_MERGE_THRESHOLD : IOU_CROSS_TYPE_THRESHOLD;
      return boxIou(a.evidence[0]?.mark, b.evidence[0]?.mark) >= threshold;
    }));
  }
  return result;
}

function mergeByPlace(damages: Damage[]): Damage[] {
  return clusterBy(damages, (a, b) => !sharesPrimaryImage(a, b) && canMerge(a, b));
}

/**
 * Två fynd vars huvudbevis ligger i SAMMA bildruta hör hemma i pass 1, inte här.
 *
 * Pass 1 jämför deras rutor och kan därför se om de pekar på samma ställe. Pass 2 har bara orden, och
 * två märken på samma del i samma bildruta heter nästan alltid samma sak — "skav på vänster framben"
 * två gånger. Utan den här spärren slogs de ihop, och just de fallen är de som gör att flera likadana
 * skador bredvid varandra blir en enda på kortet.
 *
 * Kvar står det indirekta fallet: A och C i samma bildruta kan hamna i samma kluster via ett B i en
 * annan bildruta som liknar båda. Det kräver att modellen gett alla tre samma ord, och då finns det
 * inget i texten som skiljer dem åt.
 */
function sharesPrimaryImage(a: Damage, b: Damage): boolean {
  const ia = a.evidence[0]?.imageId;
  const ib = b.evidence[0]?.imageId;
  return ia !== undefined && ia === ib;
}

/** Union-find över ett predikat: allt som hänger ihop parvis blir en skada med allas bevis. */
function clusterBy(group: Damage[], sameDamage: (a: Damage, b: Damage) => boolean): Damage[] {
  if (group.length <= 1) return group;

  const parent = group.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      if (sameDamage(group[i], group[j])) union(i, j);
    }
  }

  const clusters = new Map<number, Damage[]>();
  group.forEach((d, i) => {
    const root = find(i);
    const list = clusters.get(root) ?? [];
    list.push(d);
    clusters.set(root, list);
  });

  return [...clusters.values()].map((cluster) => (cluster.length === 1 ? cluster[0] : mergeDamageGroup(cluster)));
}

function boxIou(a: EvidenceMark | undefined, b: EvidenceMark | undefined): number {
  if (!a || !b || a.kind !== "box" || b.kind !== "box") return 0;
  const aw = a.w ?? 0;
  const ah = a.h ?? 0;
  const bw = b.w ?? 0;
  const bh = b.h ?? 0;
  const ax1 = a.x + aw;
  const ay1 = a.y + ah;
  const bx1 = b.x + bw;
  const by1 = b.y + bh;

  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(ax1, bx1);
  const iy1 = Math.min(ay1, by1);
  const interW = Math.max(0, ix1 - ix0);
  const interH = Math.max(0, iy1 - iy0);
  const interArea = interW * interH;
  if (interArea <= 0) return 0;

  const unionArea = aw * ah + bw * bh - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
}

const SEVERITY_DESC: Record<string, number> = { S4: 4, S3: 3, S2: 2, S1: 1 };

/**
 * Slår ihop en grupp fynd till EN skada med allas bevis.
 *
 * Primär blir den allvarligaste. Vid lika allvarlighet vinner den med en KONKRET typ: en grupp där
 * `general_wear` och `scuff` beskriver samma märke ska heta skrapmärke på kortet, inte "allmänt
 * slitage" — säljaren ska kunna se efter på möbeln vad anmärkningen gäller.
 */
export function mergeDamageGroup(group: Damage[]): Damage {
  const primary = [...group].sort((a, b) => {
    const bySeverity = SEVERITY_DESC[b.severity] - SEVERITY_DESC[a.severity];
    if (bySeverity !== 0) return bySeverity;
    const byVagueness = Number(VAGUE_TYPES.has(a.type)) - Number(VAGUE_TYPES.has(b.type));
    if (byVagueness !== 0) return byVagueness;
    return b.confidence - a.confidence;
  })[0];

  const seenImages = new Set<string>();
  const evidence = group
    .flatMap((d) => d.evidence)
    .filter((e) => {
      const key = `${e.imageId}:${e.mark.x.toFixed(3)}:${e.mark.y.toFixed(3)}`;
      if (seenImages.has(key)) return false;
      seenImages.add(key);
      return true;
    });

  return {
    ...primary,
    confidence: Math.round(group.reduce((sum, d) => sum + d.confidence, 0) / group.length),
    evidence,
  };
}
