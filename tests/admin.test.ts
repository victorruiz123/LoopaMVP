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

const { isAdminEmail, jamforSenastRegistrerad } = await import("../server/src/admin.js");
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

// ─── ordningen: alla konton, nyast först ────────────────────────────────────
//
// Panelen visade förut BARA konton från idag och igår. Fönstret är borta — listan är hela katalogen,
// och det enda som styr vad man ser först är sorteringen. Den testas därför att den nu bär det
// fönstret var till för: den som är ny ska stå överst utan att någon annan göms.

const at = (iso: string) => ({ signedUpAt: iso });

test("nyast först", () => {
  const igar = at(new Date(2026, 7, 28, 7, 0).toISOString());
  const idag = at(new Date(2026, 7, 29, 9, 0).toISOString());
  const ifjol = at(new Date(2025, 0, 3, 12, 0).toISOString());
  const sorterat = [ifjol, idag, igar].sort(jamforSenastRegistrerad);
  assert.deepEqual(sorterat, [idag, igar, ifjol]);
});

test("ett gammalt konto göms inte längre — det står bara längre ned", () => {
  // Regressionen som ändringen finns för: kontot registrerades i fjol och fanns inte i panelen alls.
  const ifjol = at(new Date(2025, 0, 3, 12, 0).toISOString());
  const idag = at(new Date(2026, 7, 29, 9, 0).toISOString());
  const lista = [idag, ifjol].sort(jamforSenastRegistrerad);
  assert.equal(lista.length, 2);
  assert.equal(lista[1], ifjol);
});

test("okänt registreringsdatum sist — okänt är inte samma sak som gammalt", () => {
  const utanDatum = { signedUpAt: null };
  const ifjol = at(new Date(2025, 0, 3, 12, 0).toISOString());
  assert.deepEqual([utanDatum, ifjol].sort(jamforSenastRegistrerad), [ifjol, utanDatum]);
  assert.deepEqual([ifjol, utanDatum].sort(jamforSenastRegistrerad), [ifjol, utanDatum]);
  // Två odaterade jämför lika: ordningen dem emellan är inte något vi påstår.
  assert.equal(jamforSenastRegistrerad({ signedUpAt: null }, { signedUpAt: null }), 0);
});
