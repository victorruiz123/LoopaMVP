// ─── admin.ts + bildkakans roll: vem som får se andras annonser ───────────
//
// Adminpanelen är den enda vägen i systemet där en inloggad ser någon annans besiktning. Två saker
// måste därför hålla, och de testas här därför att ingenting annat fångar när de brister.
//
// VEM. Rollen sitter på adressen Supabase bekräftat. En admin som tappas för att en env-variabel
// skrevs över, eller en adress som blir admin för att jämförelsen är skiftlägeskänslig, är båda fel
// som syns först i drift.
//
// KAKAN. Panelens miniatyrer hämtas av <img>, som bara har bildkakan att legitimera sig med — så
// rollen följer med i kakan. Den är signerad; går flaggan att skriva om för hand är hela
// ägarskapskontrollen en upplysning i stället för en spärr.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";

process.env.MEDIA_COOKIE_SECRET = "test-hemlighet-for-bildkakan";

const { isAdminEmail, signedUpInWindow, signupWindowStart } = await import("../server/src/admin.js");
const { identityFromRequest, issueMediaCookie } = await import("../server/src/identity.js");

const ADMIN = "victor@ruiz.se";

function request(cookie: string, method = "GET"): IncomingMessage {
  return { headers: { cookie }, method } as unknown as IncomingMessage;
}

/** Kakvärdet ur Set-Cookie-huvudet — det är det webbläsaren skickar tillbaka. */
function cookieValue(setCookie: string): string {
  return setCookie.split(";")[0];
}

test("adminlistan i koden gäller oavsett miljö", () => {
  assert.equal(isAdminEmail(ADMIN), true);
  assert.equal(isAdminEmail("nagon.annan@example.com"), false);
  assert.equal(isAdminEmail(null), false);
  assert.equal(isAdminEmail(""), false);
});

test("adressen jämförs utan skiftläge och utan omgivande blanktecken", () => {
  assert.equal(isAdminEmail("Victor@Ruiz.se"), true);
  assert.equal(isAdminEmail("  victor@ruiz.se  "), true);
});

test("ADMIN_EMAILS lägger till, den ersätter inte den inbyggda", () => {
  process.env.ADMIN_EMAILS = "ny.admin@example.com";
  try {
    assert.equal(isAdminEmail("ny.admin@example.com"), true);
    assert.equal(isAdminEmail(ADMIN), true);
  } finally {
    delete process.env.ADMIN_EMAILS;
  }
});

test("bildkakan bär rollen, så <img> i panelen får hämta andras bildrutor", async () => {
  const admin = await identityFromRequest(request(cookieValue(issueMediaCookie("user-1", false, true))));
  assert.equal(admin?.id, "user-1");
  assert.equal(admin?.isAdmin, true);

  const seller = await identityFromRequest(request(cookieValue(issueMediaCookie("user-2", false))));
  assert.equal(seller?.isAdmin, false);
});

test("en påskriven adminflagga avvisas — kakan är signerad", async () => {
  const value = cookieValue(issueMediaCookie("user-2", false));
  const [payload, signature] = [value.slice(0, value.lastIndexOf(".")), value.slice(value.lastIndexOf(".") + 1)];
  const forged = `${payload.slice(0, -1)}a.${signature}`;
  assert.equal(await identityFromRequest(request(forged)), null);
});

test("kakor utfärdade före adminpanelen gäller vidare, som vanliga användare", async () => {
  // Formatet var `userId.expires` utan roll. De lever ett dygn och ska inte falla när servern
  // uppdateras mitt i någons session.
  const payload = `user-3.${Date.now() + 60_000}`;
  const signature = createHmac("sha256", process.env.MEDIA_COOKIE_SECRET as string)
    .update(payload)
    .digest("base64url");
  const identity = await identityFromRequest(request(`loopa_media=${payload}.${signature}`));
  assert.equal(identity?.id, "user-3");
  assert.equal(identity?.isAdmin, false);
});

test("kakan legitimerar bara läsning — inte ens en admins", async () => {
  const value = cookieValue(issueMediaCookie("user-1", false, true));
  assert.equal(await identityFromRequest(request(value, "POST")), null);
});

// ─── fönstret: vem som räknas som ny ────────────────────────────────────────
//
// Panelen visar konton som registrerade sig idag eller igår. Gränsen går vid ett dygnsskifte i lokal
// tid och inte 48 timmar bakåt — testas därför att skillnaden syns först vid gårdagens tidiga timmar,
// när ett rullande timfönster hade tappat konton som fortfarande är nya.

const at = (iso: string) => ({ signedUpAt: iso });

test("fönstret börjar vid lokal midnatt i går", () => {
  const now = new Date(2026, 7, 29, 14, 30);
  const start = signupWindowStart(now);
  assert.equal(start.getDate(), 28);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
});

test("idag och igår räknas som nya, dagen dessförinnan inte", () => {
  const now = new Date(2026, 7, 29, 14, 30);
  assert.equal(signedUpInWindow(at(new Date(2026, 7, 29, 9, 0).toISOString()), now), true);
  assert.equal(signedUpInWindow(at(new Date(2026, 7, 28, 0, 0).toISOString()), now), true);
  assert.equal(signedUpInWindow(at(new Date(2026, 7, 27, 23, 59).toISOString()), now), false);
});

test("gårdagsmorgonens konto är kvar hela dagen efter", () => {
  // Det ett rullande 48-timmarsfönster hade tappat: registrerat 07:00 igår, avläst 14:30 idag.
  const now = new Date(2026, 7, 29, 14, 30);
  assert.equal(signedUpInWindow(at(new Date(2026, 7, 28, 7, 0).toISOString()), now), true);
});

test("ett konto utan känt datum kan inte påstås vara nytt", () => {
  assert.equal(signedUpInWindow({ signedUpAt: null }, new Date()), false);
  assert.equal(signedUpInWindow(at("inte-ett-datum"), new Date()), false);
});
