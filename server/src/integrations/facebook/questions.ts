/**
 * Medlemsfrågorna: svar bara på det som är SANT och KONFIGURERAT.
 *
 * HÅRD REGEL: hitta aldrig på. Bostadsort, ålder, bakgrund, jobb, företagsrelation, motiv — ingenting
 * skrivs som inte står i operatörsprofilen (admin -> Facebook -> Operatörsprofil), eller följer direkt
 * av något appen faktiskt läst (gruppens regler). Allt annat blir `answerable: false`, frågan sparas på
 * gruppen så admin ser den, och gruppen blir QUESTIONS_REQUIRED. En människa svarar en gång, för hand.
 *
 * Ren modul. Testerna prövar att ett tomt fält aldrig blir ett svar.
 */

import type { MembershipQuestion, OperatorProfile } from "./types.js";

export interface RawQuestion {
  text: string;
  kind: MembershipQuestion["kind"];
  options?: string[];
  /** Vilket i ordningen av sin sort (textruta nr 2, radiogrupp nr 1 …) — så svaret hamnar i rätt fält. */
  slot?: number;
}

export type Answer = Omit<MembershipQuestion, "askedAt">;

const YES_WORDS = ["ja", "yes", "jag godkänner", "i agree", "jag accepterar", "i accept", "godkänn"];

function yesOption(options: string[] | undefined): string | null {
  if (!options) return null;
  return options.find((o) => YES_WORDS.some((y) => o.toLowerCase().trim() === y || o.toLowerCase().includes(y))) ?? null;
}

function noOption(options: string[] | undefined): string | null {
  return options?.find((o) => /^(nej|no)$/i.test(o.trim())) ?? null;
}

function svar(q: RawQuestion, answer: string | null, basis: string): Answer {
  return { text: q.text, kind: q.kind, options: q.options, answer, answerable: answer !== null, basis };
}

/**
 * "Bor du i Stockholm?" / "Var bor du?" / "Vilken kommun?"
 *
 * Ja/nej-frågan besvaras BARA när profilens stad är satt, och svaret är "Nej" när orten inte stämmer —
 * en bredare region får aldrig skriva över en uttrycklig stad. Fritextfrågan svaras med exakt den
 * konfigurerade staden, inget mer.
 */
function bostad(q: RawQuestion, profile: OperatorProfile): Answer | null {
  const city = profile.city.trim();
  const region = profile.region.trim();
  const asked = q.text.match(/bor\s+(du\s+)?(i|p[åa])\s+([\p{L}\s-]{2,40}?)\s*[?!.]?$/iu)?.[3]?.trim();
  const yesNo = /^(bor\s+du|do\s+you\s+live|are\s+you\s+(based|located)|är\s+du\s+(boende|bosatt))/i.test(q.text.trim());
  if (yesNo && asked) {
    if (!city && !region) return null;
    const hay = `${city} ${region}`.toLowerCase();
    const matches = hay.includes(asked.toLowerCase()) || (city && asked.toLowerCase().includes(city.toLowerCase()));
    const basis = `Operatörsprofilens ort "${city || region}" ${matches ? "stämmer med" : "stämmer inte med"} "${asked}"`;
    if (q.kind === "choice") {
      const pick = matches ? yesOption(q.options) : noOption(q.options);
      return pick ? svar(q, pick, basis) : svar(q, null, `${basis} — inget passande svarsalternativ`);
    }
    return svar(q, matches ? "Ja" : "Nej", basis);
  }
  if (/var\s+bor\s+du|vilken\s+(kommun|stadsdel|omr[åa]de|stad|ort)|where\s+(do\s+you\s+live|are\s+you\s+(from|based))|bostadsort/i.test(q.text)) {
    if (!city) return null;
    return svar(q, city, `Operatörsprofilens stad: "${city}"`);
  }
  return null;
}

/** "Varför vill du gå med?" -> den konfigurerade, sanna anledningen. */
function anledning(q: RawQuestion, profile: OperatorProfile): Answer | null {
  if (!/varf[öo]r\s+vill\s+du\s+(g[åa]\s+med|bli\s+medlem)|why\s+(do\s+you\s+want\s+to\s+)?join|ber[äa]tta\s+(kort\s+)?om\s+dig|tell\s+us\s+about\s+yourself|syfte/i.test(q.text)) return null;
  const reason = profile.defaultJoinReason.trim();
  if (!reason) return null;
  return svar(q, reason, "Operatörsprofilens konfigurerade anledning");
}

/** "Vad är du intresserad av?" / "Vad kommer du posta?" -> konfigurerade intressen. */
function intressen(q: RawQuestion, profile: OperatorProfile): Answer | null {
  if (!/intresse|kommer\s+du\s+(att\s+)?posta|what\s+are\s+you\s+interested\s+in|what\s+will\s+you\s+post|vad\s+letar\s+du/i.test(q.text)) return null;
  const interests = profile.interests.trim();
  if (!interests) return null;
  return svar(q, interests, "Operatörsprofilens konfigurerade intressen");
}

/** "Vad heter du?" -> det konfigurerade visningsnamnet. */
function namn(q: RawQuestion, profile: OperatorProfile): Answer | null {
  if (!/vad\s+heter\s+du|ditt\s+namn|your\s+name/i.test(q.text)) return null;
  const name = profile.displayName.trim();
  if (!name) return null;
  return svar(q, name, "Operatörsprofilens visningsnamn");
}

/**
 * "Godkänner du gruppens regler?" — ja BARA när appen faktiskt läst reglerna och de inte förbjuder det
 * vi tänker göra. Utan läst regeltext kan ingen sanningsenligt godkänna dem.
 */
function regler(q: RawQuestion, rulesReadAndOk: boolean): Answer | null {
  const isAgreement =
    q.kind === "agree_rules" ||
    /godk[äa]nner\s+du\s+(gruppens\s+)?regler|jag\s+godk[äa]nner|g[åa]r\s+(jag|du)\s+med\s+p[åa]|accepterar\s+(du\s+)?reglerna|agree\s+to\s+the\s+(group\s+)?rules|do\s+you\s+agree|l[äa]st\s+(och\s+)?f[öo]rst[åa]tt\s+reglerna/i.test(q.text);
  if (!isAgreement) return null;
  if (!rulesReadAndOk) {
    return svar(q, null, "Gruppens regler är inte lästa av appen, eller strider mot avsedd användning — kan inte godkännas sanningsenligt utan en människa");
  }
  return svar(q, yesOption(q.options) ?? "Ja", "Gruppens regler är lästa av appen och strider inte mot avsedd användning");
}

/**
 * Företags- och säljfrågor besvaras aldrig med en lögn. Finns en konfigurerad företagsrelation skrivs
 * den ut som den är; finns ingen kan frågan inte besvaras — vi påstår varken att vi är eller inte är
 * ett företag utan en konfigurerad uppgift.
 */
function foretag(q: RawQuestion, profile: OperatorProfile): Answer | null {
  if (!/f[öo]retag|business|company|s[äa]ljer\s+du|are\s+you\s+selling|commercial|n[äa]ringsidkare|yrkesm[äa]ssig/i.test(q.text)) return null;
  const affiliation = profile.businessAffiliation.trim();
  if (!affiliation) return null;
  return svar(q, affiliation, "Operatörsprofilens företagsrelation, utskriven som den är");
}

const ANSWERERS: Array<(q: RawQuestion, profile: OperatorProfile, rulesReadAndOk: boolean) => Answer | null> = [
  (q, p) => bostad(q, p),
  (q, p) => foretag(q, p),
  (q, p) => anledning(q, p),
  (q, p) => intressen(q, p),
  (q, p) => namn(q, p),
  (q, _p, ok) => regler(q, ok),
];

export function answerQuestion(q: RawQuestion, profile: OperatorProfile, rulesReadAndOk: boolean): Answer {
  for (const fn of ANSWERERS) {
    const r = fn(q, profile, rulesReadAndOk);
    if (r) return r;
  }
  return svar(q, null, "Ingen konfigurerad uppgift i operatörsprofilen besvarar frågan sanningsenligt");
}

export function answerAll(questions: RawQuestion[], profile: OperatorProfile, rulesReadAndOk: boolean): Answer[] {
  return questions.map((q) => answerQuestion(q, profile, rulesReadAndOk));
}

/** Sant när VARJE fråga fick ett svar. Annars skickas ingenting — ett halvfyllt formulär är inget svar. */
export function allAnswerable(answers: Answer[]): boolean {
  return answers.length > 0 && answers.every((a) => a.answerable);
}
