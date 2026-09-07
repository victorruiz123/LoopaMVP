// ─── Tradera-mejlen: tolkningen ─────────────────────────────────────────────
//
// Breven nedan är ANTAGANDEN om hur Traderas mejl ser ut — vi har ännu inte sparat ett skarpt. De
// låser tolkarens beteende på de drag vi är säkra på (annonslänken, ordvalen "såld"/"fråga"/"bud")
// och ska bytas mot kopierade brev så snart bevakaren läst sina första. Ett mejl som inte känns
// igen ska bli `ovrigt`, aldrig `sald`: fel möbel såld är dyrare än en missad notis.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, isFromTradera, parseTraderaMail, stripHtml } from "../server/src/integrations/tradera/mail.js";
import { matchJob } from "../server/src/integrations/tradera/mailwatch.js";
import type { ConditionJob } from "../server/src/types.js";

const URL = "https://www.tradera.com/item/302537/747607260/madison-3-sits-soffa";

function mail(subject: string, text: string, html: string | null = null) {
  return parseTraderaMail({
    messageId: "<abc@tradera.com>",
    subject,
    from: "Tradera <noreply@tradera.com>",
    text,
    html,
    date: "2026-09-07T10:00:00.000Z",
  });
}

test("avsändaren känns igen på domänen, inte på visningsnamnet", () => {
  assert.equal(isFromTradera("Tradera <noreply@tradera.com>"), true);
  assert.equal(isFromTradera("no-reply@mail.tradera.com"), true);
  assert.equal(isFromTradera("Isac <isac@example.com>"), false);
});

test("Köp Nu-mejlet blir en försäljning med annons-id, rubrik och belopp", () => {
  const m = mail(
    'Grattis! Din vara "Madison 3-sits soffa" är såld',
    `Hej!\nKöparen scoyard har köpt din vara för 4 500 kr.\nSe annonsen: ${URL}\nHälsningar Tradera`,
  );
  assert.equal(m.kind, "sald");
  assert.equal(m.itemId, 747607260);
  assert.equal(m.title, "Madison 3-sits soffa");
  assert.equal(m.amountSek, 4500);
  assert.equal(m.alias, "scoyard");
  assert.equal(m.url, URL);
});

test("en auktion som slutade utan bud är INTE såld", () => {
  const m = mail('Din auktion "Madison 3-sits soffa" avslutades utan bud', `Ingen la ett bud. Lägg upp den igen: ${URL}`);
  assert.equal(m.kind, "ovrigt");
  assert.equal(m.itemId, 747607260);
});

test("frågemejlet bär frågan i utdraget", () => {
  const m = mail(
    "Du har fått en fråga om din annons Madison 3-sits soffa",
    `Hej!\nAnvändaren kalle_k har ställt en fråga:\n\nFråga:\nGår den att dela på för transport? Har en trång trappa.\n\nSvara här: ${URL}\nTradera`,
  );
  assert.equal(m.kind, "fraga");
  assert.equal(m.itemId, 747607260);
  assert.match(m.excerpt, /Går den att dela på för transport\? Har en trång trappa\./);
  assert.equal(m.amountSek, null);
});

test("nytt bud är bud, och html räcker när texten saknas", () => {
  const html = `<html><body><p>Nytt bud på <b>Madison 3-sits soffa</b>: 550 kr.</p><p><a href="${URL}">Se annonsen</a></p></body></html>`;
  const m = mail("Nytt bud på din annons", "", html);
  assert.equal(m.kind, "bud");
  assert.equal(m.itemId, 747607260);
  assert.equal(m.amountSek, 550);
});

test("ett annons-id går att hitta utan länk, på nummerraden", () => {
  const m = mail("Din vara är såld", "Annonsnummer: 747607260\nBetalning mottagen.");
  assert.equal(m.kind, "sald");
  assert.equal(m.itemId, 747607260);
});

test("kvitton och kampanjer blir övrigt", () => {
  assert.equal(classify("Ditt kvitto från Tradera", "Tack för att du använder Tradera."), "ovrigt");
  assert.equal(classify("Höstens bästa fynd", "Fynda soffor och bord."), "ovrigt");
});

test("stripHtml ger läsbara rader", () => {
  assert.equal(stripHtml("<p>Hej</p><p>Fr&aring;ga:<br>Finns den kvar?</p>"), "Hej\nFr&aring;ga:\nFinns den kvar?");
});

function job(id: string, itemId: number | null, title: string, status: "published" | "error" = "published"): ConditionJob {
  return {
    id,
    tradera: itemId === null ? null : { status, requestId: null, itemId, url: null, error: null, startedAt: "", publishedAt: null },
    result: { listing: { status: "ok", unavailableReason: null, result: { listing: { title } } } },
  } as unknown as ConditionJob;
}

test("matchningen går på annons-id först och på rubrik bara när den är entydig", () => {
  const jobs = [job("a", 747607260, "Madison 3-sits soffa"), job("b", 111111111, "Fåtölj"), job("c", 222222222, "Fåtölj")];
  assert.equal(matchJob({ itemId: 747607260, title: "Något annat" }, jobs)?.id, "a");
  assert.equal(matchJob({ itemId: null, title: "madison 3-sits soffa" }, jobs)?.id, "a");
  assert.equal(matchJob({ itemId: null, title: "Fåtölj" }, jobs), null);
  assert.equal(matchJob({ itemId: 999, title: null }, jobs), null);
});
