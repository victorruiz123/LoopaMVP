// ─── Glömt lösenord ──────────────────────────────────────────────────────────
//
// Mejlet skickas av servern, inte av Supabase (server/src/losenord.ts). Tre saker måste hålla:
//
// SVARET AVSLÖJAR INTE OM KONTOT FINNS. Okänd adress och känd adress ger samma 200.
// LÄNKEN ÄR VÅR, med koden efter # — inte Supabases verify-länk.
// TAKET HÅLLER. Samma adress får inte bli en spamkanon.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-nyckel";
process.env.LOOPA_PUBLIC_URL = "https://loopa.test";
// En stängd port: ett brev som faktiskt försöker gå iväg faller direkt.
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
process.env.SMTP_USER = "test@exempel.se";
process.env.SMTP_PASS = "hemligt";

const { handleLosenord, nollstallTaket, brevet } = await import("../server/src/losenord.js");

const anrop: Array<{ url: string; body: any }> = [];
let svar: { status: number; body: unknown } = { status: 404, body: {} };
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  anrop.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
  return new Response(JSON.stringify(svar.body), { status: svar.status });
}) as typeof fetch;

beforeEach(() => {
  nollstallTaket();
  anrop.length = 0;
});

function post(kropp: unknown, ip = "1.2.3.4"): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const res = new PassThrough() as unknown as ServerResponse & PassThrough;
    let status = 0;
    (res as any).writeHead = (s: number) => ((status = s), res);
    (res as any).end = (b: string) => resolve({ status, body: JSON.parse(b || "{}") });
    const req = { method: "POST", headers: { "x-forwarded-for": ip }, socket: {} } as unknown as IncomingMessage;
    void handleLosenord(["aterstall"], req, res, async () => kropp);
  });
}

test("okänd adress: 200 och inget mejl", async () => {
  svar = { status: 404, body: { msg: "User not found" } };
  const r = await post({ email: "Ingen@Exempel.se" });
  assert.equal(r.status, 200);
  assert.equal(anrop.length, 1);
  assert.equal(anrop[0].url, "https://supabase.test/auth/v1/admin/generate_link");
  assert.deepEqual(anrop[0].body, { type: "recovery", email: "ingen@exempel.se" });
});

test("känd adress: koden hämtas och ett brev försöker gå iväg (här till en stängd port, därför 502)", async () => {
  svar = { status: 200, body: { properties: { hashed_token: "abc123" } } };
  const r = await post({ email: "anna@exempel.se" });
  assert.equal(r.status, 502);
  assert.equal(anrop.length, 1);
});

test("länken i brevet är vår, med koden efter #", () => {
  const b = brevet("https://loopa.test/#aterstall=abc123");
  assert.match(b.text, /https:\/\/loopa\.test\/#aterstall=abc123/);
  assert.match(b.subject, /lösenord/i);
});

test("ogiltig adress avvisas utan att Supabase tillfrågas", async () => {
  const r = await post({ email: "inte-en-adress" });
  assert.equal(r.status, 400);
  assert.equal(anrop.length, 0);
});

test("taket: tredje försöket samma timme går igenom, det fjärde inte", async () => {
  svar = { status: 404, body: {} };
  for (let i = 0; i < 3; i += 1) assert.equal((await post({ email: "b@exempel.se" })).status, 200);
  assert.equal((await post({ email: "b@exempel.se" })).status, 429);
  // En annan adress från en annan IP påverkas inte.
  assert.equal((await post({ email: "c@exempel.se" }, "5.6.7.8")).status, 200);
});
