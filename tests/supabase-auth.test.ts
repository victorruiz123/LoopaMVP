// ─── "Ogiltig token" och "Supabase gick inte att fråga" är olika saker ──────────────────────────────────────────────────────────────
//
// Förut gav båda null och grinden svarade 401. Klienten städar bort sessionen på 401, så ett hickande Supabase (eller en kall cache efter en serveromstart) loggade ut säljaren
// mitt i uppladdningen. Nu: ogiltig token → null → 401. Onåbart (nät, timeout, 5xx, 429) → AuthUnavailableError → 503, och sessionen rörs inte.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { AuthUnavailableError, userFromRequest } from "../server/src/supabaseAuth.js";
import { identityFromRequest, issueMediaCookie } from "../server/src/identity.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CONDITION_SERVICE_KEY;
});

let n = 0;
const req = (headers: Record<string, string>, method = "POST") => ({ method, headers }) as unknown as IncomingMessage;
/** En ny token per test: svaren cachas per token, och ett cachat svar hade dolt det som prövas. */
const bearer = (extra: Record<string, string> = {}, method = "POST") => req({ authorization: `Bearer tok-${++n}`, ...extra }, method);
const supabaseSays = (status: number, body: unknown = {}) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
};

test("Supabase bekräftar token: användaren, och svaret cachas så att pollningen inte blir en rundtur per anrop", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ id: "u1", email: "a@b.se" }), { status: 200 });
  }) as typeof fetch;
  const r = bearer();
  assert.deepEqual(await userFromRequest(r), { id: "u1", email: "a@b.se" });
  assert.deepEqual(await userFromRequest(r), { id: "u1", email: "a@b.se" });
  assert.equal(calls, 1);
});

test("Supabase säger nej (401, 403, 400): token är ogiltig — null, alltså 401 i grinden", async () => {
  for (const status of [400, 401, 403]) {
    supabaseSays(status, { msg: "invalid JWT" });
    assert.equal(await userFromRequest(bearer()), null, `HTTP ${status}`);
  }
});

test("Supabase är tillfälligt otillgängligt (503, 502, 429): AuthUnavailableError — inte ett nej om token", async () => {
  for (const status of [429, 500, 502, 503]) {
    supabaseSays(status);
    await assert.rejects(userFromRequest(bearer()), (e: unknown) => e instanceof AuthUnavailableError && e.reason === `HTTP ${status}`, `HTTP ${status}`);
  }
});

test("nätfel och timeout är också 'otillgängligt'", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(userFromRequest(bearer()), (e: unknown) => e instanceof AuthUnavailableError && e.reason === "nätverksfel");
  globalThis.fetch = (async () => {
    const e = new Error("The operation was aborted due to timeout");
    e.name = "TimeoutError";
    throw e;
  }) as typeof fetch;
  await assert.rejects(userFromRequest(bearer()), (e: unknown) => e instanceof AuthUnavailableError && e.reason === "timeout");
});

test("ett otillgängligt svar cachas inte: nästa anrop frågar Supabase igen och lyckas", async () => {
  const r = bearer();
  supabaseSays(503);
  await assert.rejects(userFromRequest(r), AuthUnavailableError);
  supabaseSays(200, { id: "u2", email: null });
  assert.equal((await userFromRequest(r))?.id, "u2");
});

test("identityFromRequest: otillgängligt Supabase och ingen annan legitimation kastar (grinden svarar 503), ogiltig token ger null (401)", async () => {
  supabaseSays(503);
  await assert.rejects(identityFromRequest(bearer()), AuthUnavailableError);
  supabaseSays(401);
  assert.equal(await identityFromRequest(bearer()), null);
});

test("otillgängligt Supabase hindrar inte maskinnyckeln, och en giltig bildkaka släpper fortfarande igenom en GET", async () => {
  supabaseSays(503);
  process.env.CONDITION_SERVICE_KEY = "svc-key";
  const machine = await identityFromRequest(bearer({ "x-api-key": "svc-key" }));
  assert.equal(machine?.kind, "service");

  const cookie = issueMediaCookie("user-9", false).split(";")[0];
  const viaCookie = await identityFromRequest(bearer({ cookie }, "GET"));
  assert.equal(viaCookie?.id, "user-9", "GET med kaka: identiteten finns även när Supabase är nere");
  // Samma kaka godtas aldrig för en skrivning — då blir det otillgängligt, inte en identitet.
  await assert.rejects(identityFromRequest(bearer({ cookie }, "POST")), AuthUnavailableError);
});
