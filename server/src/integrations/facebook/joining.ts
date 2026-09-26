/**
 * Medlemsansökningarna: Gå med-knappen, frågorna och vakten som tittar till väntande ansökningar.
 *
 * DEN ENDA RIKTIGA SKRIVNINGEN SOM INTE GÅR GENOM TORRKÖRNINGEN. En ansökan är inte en annons — den
 * går att ta tillbaka, den syns bara för gruppens administratörer, och utan den finns ingen kanal.
 * Den är därför styrd av en egen brytare (FACEBOOK_AUTO_JOIN, av som förval), panelens pausknapp,
 * dagsgränsen och pausen mellan skrivningar.
 *
 * FRÅGOR BESVARAS BARA SANNINGSENLIGT. Kan en fråga inte besvaras ur operatörsprofilen skickas
 * INGENTING — dialogen stängs, frågorna sparas på gruppen och gruppen blir QUESTIONS_REQUIRED. Ett
 * halvfyllt formulär är inte ett svar.
 *
 * VERIFIERAT 2026-09-23 (systerprojektet, samma konto): tre riktiga klick på "Gå med i grupp" i
 * offentliga grupper gick igenom direkt utan dialog och gav "Har gått med". Dialog-vägen (frågor,
 * väntande godkännande) är byggd på Facebooks dokumenterade ytkonventioner och är inte observerad
 * live än — den stannar hellre med NEEDS_MANUAL_ACTION än gissar.
 */

import type { Locator, Page } from "playwright";
import { facebookAutoJoin, facebookEnabled, facebookLimits } from "./config.js";
import { FacebookInterrupt } from "./checkpoint.js";
import { applySnapshot, inspectGroup, rescore } from "./discovery.js";
import { applyMembership, autoJoinActive, computeJoinEligibility, NON_JOINABLE, shouldRecheckMembership } from "./membership.js";
import { allAnswerable, answerAll, type Answer, type RawQuestion } from "./questions.js";
import { adsStatusAllowsPosting } from "./rules.js";
import { compareGroups } from "./ranking.js";
import { FB, TEXT } from "./selectors.js";
import { assertNoInterrupt, bodyText, goto, isRealFacebook, recordInterrupt, screenshot, withFacebookBrowser } from "./session.js";
import { allGroups, getGroup, lastWriteAt, logEvent, putGroup, readSettings, recordWrite, writesSince } from "./store.js";
import type { FacebookGroup, MembershipQuestion, MembershipStatus, OperatorProfile } from "./types.js";

export interface JoinOutcome {
  status: MembershipStatus;
  detail: string;
  /** Sant när Gå med faktiskt trycktes — det som bokförs som en skrivning. */
  clicked: boolean;
  questions: Answer[];
  screenshot: string | null;
}

/**
 * Klickar Gå med och läser utfallet. Kastar FacebookInterrupt vid avbrott. Anropas ALDRIG för en
 * grupp i NON_JOINABLE — det är anroparens ansvar (se `runAutoJoin`).
 */
export async function joinGroup(page: Page, group: FacebookGroup, profile: OperatorProfile): Promise<JoinOutcome> {
  await goto(page, group.canonicalUrl, `gå med ${group.id}`);
  const header = await page.locator(FB.main).first().innerText().catch(() => "");
  if (TEXT.member.test(header)) return { status: "MEMBER", detail: "Redan medlem — upptäckt innan något klick.", clicked: false, questions: [], screenshot: null };
  if (TEXT.pending.test(header)) return { status: "PENDING_APPROVAL", detail: "En ansökan väntar redan — inget nytt klick.", clicked: false, questions: [], screenshot: null };

  const joinBtn = page.locator(FB.joinButton).first();
  if ((await joinBtn.count()) === 0) {
    const shot = await screenshot(page, `ingen_gamed_${group.id}`);
    if (TEXT.joinBlocked.test(header)) return { status: "JOIN_BLOCKED", detail: "Facebook säger att gruppen inte tar emot nya medlemmar.", clicked: false, questions: [], screenshot: shot };
    return { status: "JOIN_BLOCKED", detail: "Ingen Gå med-knapp på gruppsidan.", clicked: false, questions: [], screenshot: shot };
  }

  await joinBtn.click();
  await page.waitForTimeout(2_500);
  await assertNoInterrupt(page, `gå med ${group.id} (efter klick)`);

  // Snabbspåret, verifierat live: offentliga grupper går igenom direkt utan dialog.
  const afterClick = await page.locator(FB.main).first().innerText().catch(() => "");
  if (TEXT.member.test(afterClick)) {
    return { status: "MEMBER", detail: "Gick med direkt, inga medlemsfrågor.", clicked: true, questions: [], screenshot: await screenshot(page, `medlem_${group.id}`) };
  }

  const dialog = page.locator(FB.membershipDialog).first();
  const hasDialog = (await dialog.count()) > 0 && (await dialog.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false));
  if (!hasDialog) {
    await page.waitForTimeout(2_000);
    const settled = await page.locator(FB.main).first().innerText().catch(() => "");
    if (TEXT.member.test(settled)) return { status: "MEMBER", detail: "Gick med (efter en kort fördröjning).", clicked: true, questions: [], screenshot: await screenshot(page, `medlem_${group.id}`) };
    if (TEXT.pending.test(settled) || TEXT.pending.test(await bodyText(page))) {
      return { status: "PENDING_APPROVAL", detail: "Ansökan skickad, väntar på administratörens godkännande.", clicked: true, questions: [], screenshot: await screenshot(page, `vantar_${group.id}`) };
    }
    return { status: "NEEDS_MANUAL_ACTION", detail: "Gå med trycktes men utfallet gick inte att läsa.", clicked: true, questions: [], screenshot: await screenshot(page, `oklart_${group.id}`) };
  }

  const dialogText = (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ");
  if (TEXT.pending.test(dialogText)) {
    await closeDialog(page);
    return { status: "PENDING_APPROVAL", detail: "Ansökan skickad, väntar på godkännande (bekräftat i dialog).", clicked: true, questions: [], screenshot: null };
  }

  // Frågorna. Läses som de står; svaren kommer bara ur profilen.
  const raw = await extractQuestions(dialog);
  if (raw.length === 0) raw.push({ text: dialogText.slice(0, 300) || "Bekräfta gruppens regler", kind: "agree_rules" });
  const rulesOk = !!group.rulesLastCheckedAt && adsStatusAllowsPosting(group.adsStatus);
  const answers = answerAll(raw, profile, rulesOk);
  if (!allAnswerable(answers)) {
    const shot = await screenshot(page, `fragor_${group.id}`);
    await closeDialog(page);
    return {
      status: "QUESTIONS_REQUIRED",
      detail: `${answers.filter((a) => !a.answerable).length} medlemsfråga/or kunde inte besvaras sanningsenligt ur operatörsprofilen. Ingenting skickades.`,
      clicked: true,
      questions: answers,
      screenshot: shot,
    };
  }

  await fillAnswers(dialog, raw, answers);
  const submit = page.locator(FB.dialogSubmit).first();
  if ((await submit.count()) === 0) {
    const shot = await screenshot(page, `ingen_skicka_${group.id}`);
    await closeDialog(page);
    return { status: "NEEDS_MANUAL_ACTION", detail: "Frågorna fylldes i men ingen Skicka-knapp hittades. Ingenting skickades.", clicked: true, questions: answers, screenshot: shot };
  }
  await submit.click();
  await page.waitForTimeout(2_500);
  await assertNoInterrupt(page, `gå med ${group.id} (efter svar)`);

  // Flerstegsdialoger: "Nästa" kan visa fler frågor.
  if ((await page.locator(FB.membershipDialog).count()) > 0) {
    const more = await extractQuestions(page.locator(FB.membershipDialog).first());
    if (more.length > 0) {
      const moreAnswers = answerAll(more, profile, rulesOk);
      if (!allAnswerable(moreAnswers)) {
        const shot = await screenshot(page, `fragor2_${group.id}`);
        await closeDialog(page);
        return { status: "QUESTIONS_REQUIRED", detail: "Ytterligare medlemsfrågor kunde inte besvaras sanningsenligt. Andra steget skickades inte.", clicked: true, questions: [...answers, ...moreAnswers], screenshot: shot };
      }
      await fillAnswers(page.locator(FB.membershipDialog).first(), more, moreAnswers);
      const submit2 = page.locator(FB.dialogSubmit).first();
      if ((await submit2.count()) > 0) {
        await submit2.click();
        await page.waitForTimeout(2_500);
      }
      answers.push(...moreAnswers);
    }
  }

  const finalHeader = await page.locator(FB.main).first().innerText().catch(() => "");
  if (TEXT.member.test(finalHeader)) return { status: "MEMBER", detail: "Gick med efter att ha svarat på medlemsfrågorna.", clicked: true, questions: answers, screenshot: await screenshot(page, `medlem_${group.id}`) };
  if (TEXT.pending.test(finalHeader) || TEXT.pending.test(await bodyText(page))) {
    return { status: "PENDING_APPROVAL", detail: "Frågorna besvarade och skickade, väntar på godkännande.", clicked: true, questions: answers, screenshot: await screenshot(page, `vantar_${group.id}`) };
  }
  return { status: "NEEDS_MANUAL_ACTION", detail: "Svaren skickades men medlemskapets läge gick inte att läsa.", clicked: true, questions: answers, screenshot: await screenshot(page, `oklart_${group.id}`) };
}

async function closeDialog(page: Page): Promise<void> {
  const close = page.locator(FB.dialogClose).first();
  if ((await close.count()) > 0) await close.click().catch(() => undefined);
  else await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(500);
}

/** Frågorna som de står i dialogen. `slot` är platsen bland sin sort, så svaret hamnar i rätt fält. */
async function extractQuestions(dialog: Locator): Promise<RawQuestion[]> {
  const out: RawQuestion[] = [];
  const radioGroups = dialog.locator(FB.questionRadioGroup);
  for (let i = 0; i < (await radioGroups.count()); i++) {
    const g = radioGroups.nth(i);
    const label = (await g.getAttribute("aria-label")) ?? (await nearestHeading(g));
    const options = await g.locator('[role="radio"]').evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim()).filter(Boolean));
    if (label) out.push({ text: label, kind: "choice", options, slot: i });
  }
  const textboxes = dialog.locator(FB.questionTextbox);
  for (let i = 0; i < (await textboxes.count()); i++) {
    const t = textboxes.nth(i);
    const label = (await t.getAttribute("aria-label")) ?? (await t.getAttribute("aria-placeholder")) ?? (await nearestHeading(t));
    if (label) out.push({ text: label, kind: "text", slot: i });
  }
  const checkboxes = dialog.locator(FB.questionCheckbox);
  for (let i = 0; i < (await checkboxes.count()); i++) {
    const c = checkboxes.nth(i);
    const label = (await c.getAttribute("aria-label")) ?? (await nearestHeading(c));
    if (label) out.push({ text: label, kind: "agree_rules", slot: i });
  }
  return out;
}

async function nearestHeading(el: Locator): Promise<string | null> {
  return el
    .evaluate((node) => {
      let cur: HTMLElement | null = node.parentElement;
      for (let i = 0; i < 4 && cur; i++) {
        const heading = cur.querySelector('h1,h2,h3,label,span[dir="auto"]');
        const text = heading?.textContent?.trim();
        if (text && text.length > 3 && text.length < 200) return text;
        cur = cur.parentElement;
      }
      return null;
    })
    .catch(() => null);
}

async function fillAnswers(dialog: Locator, raw: RawQuestion[], answers: Answer[]): Promise<void> {
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i];
    const a = answers[i];
    if (!a?.answer) continue;
    const slot = q.slot ?? 0;
    if (q.kind === "choice") {
      const grupp = dialog.locator(FB.questionRadioGroup).nth(slot);
      const scope = (await grupp.count()) > 0 ? grupp : dialog;
      const opt = scope.locator('[role="radio"]').filter({ hasText: a.answer }).first();
      if ((await opt.count()) > 0) await opt.click().catch(() => undefined);
    } else if (q.kind === "agree_rules") {
      const cb = dialog.locator(FB.questionCheckbox).nth(slot);
      if ((await cb.count()) > 0 && (await cb.getAttribute("aria-checked")) !== "true") await cb.click().catch(() => undefined);
    } else {
      const tb = dialog.locator(FB.questionTextbox).nth(slot);
      if ((await tb.count()) > 0) {
        await tb.click().catch(() => undefined);
        await tb.fill("").catch(() => undefined);
        await dialog.page().keyboard.insertText(a.answer);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Körningarna
// ---------------------------------------------------------------------------

export interface JoinRunResult {
  attempted: Array<{ groupId: string; name: string; before: MembershipStatus; after: MembershipStatus; detail: string; questions: Answer[] }>;
  skipped: string[];
  stoppedBy: string | null;
}

/**
 * Går med i de bästa grupperna som får ansökas till, inom gränserna.
 *
 * `groupIds` pekar ut grupper uttryckligen (panelen, CLI:t) och kringgår då pausknappen och
 * FACEBOOK_AUTO_JOIN — men ALDRIG idempotensen, dagsgränsen eller regelkravet. `max` är taket för
 * den här körningen.
 */
export async function runAutoJoin(opts: { max?: number; groupIds?: string[] } = {}): Promise<JoinRunResult> {
  const limits = facebookLimits();
  const settings = await readSettings();
  const explicit = !!opts.groupIds?.length;
  const result: JoinRunResult = { attempted: [], skipped: [], stoppedBy: null };

  if (!explicit && !autoJoinActive(facebookAutoJoin() && facebookEnabled(), settings)) {
    result.stoppedBy = "Automatiska ansökningar är av (FACEBOOK_AUTO_JOIN eller pausknappen).";
    return result;
  }

  const sinceMidnight = new Date();
  sinceMidnight.setHours(0, 0, 0, 0);
  const alreadyToday = await writesSince("join", sinceMidnight);
  let budget = Math.max(0, Math.min(opts.max ?? limits.maxJoinsPerDay, limits.maxJoinsPerDay - alreadyToday));
  if (budget === 0) {
    result.stoppedBy = `Dagsgränsen ${limits.maxJoinsPerDay} ansökningar är nådd.`;
    return result;
  }

  const groups = await allGroups();
  const candidates = (explicit ? groups.filter((g) => opts.groupIds!.includes(g.id)) : groups)
    .filter((g) => !NON_JOINABLE.includes(g.membershipStatus))
    .filter((g) => explicit || computeJoinEligibility(g, limits).eligible)
    .filter((g) => !!g.rulesLastCheckedAt)
    .sort(compareGroups);

  for (const g of (explicit ? groups.filter((x) => opts.groupIds!.includes(x.id)) : []).filter((x) => !candidates.includes(x))) {
    result.skipped.push(`${g.id}: ${NON_JOINABLE.includes(g.membershipStatus) ? `medlemskapet är ${g.membershipStatus}` : !g.rulesLastCheckedAt ? "reglerna är inte lästa — validera först" : computeJoinEligibility(g, limits).reasons.join("; ")}`);
  }
  if (candidates.length === 0) return result;

  await withFacebookBrowser("join", async ({ page }) => {
    for (const candidate of candidates) {
      if (budget <= 0) break;
      const last = await lastWriteAt();
      if (last && Date.now() - Date.parse(last) < limits.minSecondsBetweenWrites * 1000) {
        await page.waitForTimeout(limits.minSecondsBetweenWrites * 1000 - (Date.now() - Date.parse(last)));
      }
      const before = (await getGroup(candidate.id)) ?? candidate;
      try {
        // Läs sidan först: kontot kan redan vara medlem, reglerna kan ha ändrats sedan valideringen.
        const snap = await inspectGroup(page, before.canonicalUrl);
        if (!snap.exists) {
          result.skipped.push(`${before.id}: gruppsidan är inte tillgänglig`);
          continue;
        }
        let group = await applySnapshot(before, snap);
        if (NON_JOINABLE.includes(group.membershipStatus) || group.adsStatus === "PROHIBITED") {
          await putGroup(group);
          result.skipped.push(`${group.id}: ${group.membershipStatus}${group.adsStatus === "PROHIBITED" ? ", regler PROHIBITED" : ""} efter färsk läsning`);
          continue;
        }

        const outcome = await joinGroup(page, group, settings.operatorProfile);
        const askedAt = new Date().toISOString();
        const questions: MembershipQuestion[] = outcome.questions.map((q) => ({ ...q, askedAt }));
        if (outcome.clicked) {
          group = applyMembership(group, "JOIN_REQUESTED", "Gå med trycktes.", { at: askedAt, countAttempt: true });
          if (isRealFacebook()) await recordWrite("join", group.id);
          budget -= 1;
        }
        group = applyMembership(group, outcome.status, outcome.detail, { at: askedAt, screenshot: outcome.screenshot });
        // Behörigheterna följer läget: en ny medlem i en tillåtande grupp ska bli postbar i samma skrivning.
        group = rescore({ ...group, questions: [...group.questions, ...questions].slice(-20) });
        const saved = await putGroup(group);
        result.attempted.push({ groupId: saved.id, name: saved.name, before: before.membershipStatus, after: saved.membershipStatus, detail: outcome.detail, questions: outcome.questions });
        await logEvent({
          worker: "join",
          level: outcome.status === "MEMBER" || outcome.status === "PENDING_APPROVAL" ? "ok" : "warning",
          action: outcome.clicked ? "GÅ MED" : "GÅ MED (inget klick)",
          target: saved.id,
          detail: `${saved.name}: ${before.membershipStatus} -> ${saved.membershipStatus}. ${outcome.detail}`,
        });
      } catch (err) {
        if (err instanceof FacebookInterrupt) {
          await recordInterrupt(err, { worker: "join", groupId: before.id }, `gå med ${before.canonicalUrl}`);
          const current = (await getGroup(before.id)) ?? before;
          try {
            await putGroup(applyMembership(current, "NEEDS_MANUAL_ACTION", err.message, { screenshot: err.screenshot }));
          } catch {
            // Övergången kan vara otillåten från ett slutläge; åtgärdsposten finns ändå.
          }
          result.stoppedBy = err.message;
          break;
        }
        await logEvent({ worker: "join", level: "error", action: "GÅ MED FÖLL", target: before.id, detail: err instanceof Error ? err.message : String(err) });
        result.skipped.push(`${before.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  return result;
}

export interface RecheckResult {
  checked: Array<{ groupId: string; before: MembershipStatus; after: MembershipStatus }>;
  stoppedBy: string | null;
}

/**
 * Vakten: tittar till JOIN_REQUESTED och PENDING_APPROVAL. Godkänd -> MEMBER, och distributionen
 * slås på automatiskt om reglerna tillåter (refreshEligibility inne i applySnapshot/rescore). En
 * ansökan som försvunnit och lämnat Gå med-knappen kvar räknas som avslagen.
 */
export async function recheckMemberships(opts: { force?: boolean; groupIds?: string[] } = {}): Promise<RecheckResult> {
  const limits = facebookLimits();
  const groups = await allGroups();
  const due = groups.filter((g) => (opts.groupIds ? opts.groupIds.includes(g.id) : opts.force ? ["JOIN_REQUESTED", "PENDING_APPROVAL"].includes(g.membershipStatus) : shouldRecheckMembership(g, limits.membershipCheckMinutes)));
  const result: RecheckResult = { checked: [], stoppedBy: null };
  if (due.length === 0) return result;

  await withFacebookBrowser("membership-watch", async ({ page }) => {
    for (const before of due) {
      try {
        const snap = await inspectGroup(page, before.canonicalUrl);
        const current = (await getGroup(before.id)) ?? before;
        let next = current;
        if (!snap.exists) {
          next = { ...current, membershipLastCheckedAt: new Date().toISOString(), membershipDetail: "Gruppsidan är inte tillgänglig." };
        } else {
          // En väntande ansökan som försvunnit och lämnat Gå med-knappen kvar är avslagen, inte "inte medlem".
          const rejected = ["JOIN_REQUESTED", "PENDING_APPROVAL"].includes(current.membershipStatus) && snap.membership === "NOT_MEMBER";
          next = await applySnapshot(current, rejected ? { ...snap, membership: null } : snap);
          if (rejected) {
            next = rescore(applyMembership(next, "JOIN_REJECTED", "Ansökan finns inte längre och Gå med-knappen är tillbaka — troligen avslagen."));
          }
        }
        await putGroup(next);
        result.checked.push({ groupId: next.id, before: before.membershipStatus, after: next.membershipStatus });
        if (before.membershipStatus !== next.membershipStatus) {
          await logEvent({ worker: "membership-watch", level: next.membershipStatus === "MEMBER" ? "ok" : "info", action: "MEDLEMSKAP", target: next.id, detail: `${next.name}: ${before.membershipStatus} -> ${next.membershipStatus}.${next.membershipStatus === "MEMBER" ? (next.enabledForDistribution ? " Distribution påslagen." : ` Distribution av: ${next.postReasons.join("; ")}`) : ""}` });
        }
        await page.waitForTimeout(1000 + Math.floor(Math.random() * 1000));
      } catch (err) {
        if (err instanceof FacebookInterrupt) {
          await recordInterrupt(err, { worker: "membership-watch", groupId: before.id }, `kontroll ${before.canonicalUrl}`);
          result.stoppedBy = err.message;
          break;
        }
        await logEvent({ worker: "membership-watch", level: "warning", action: "KONTROLL FÖLL", target: before.id, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  return result;
}
