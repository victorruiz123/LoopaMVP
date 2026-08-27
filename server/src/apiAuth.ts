import { timingSafeEqual } from "node:crypto";

/**
 * Shared-secret auth for the public API. The key lives in CONDITION_API_KEY and is never logged, never
 * echoed back in an error, and never compared with === (that leaks length and prefix through timing).
 *
 * Fails CLOSED: with no key configured the API refuses every request rather than serving an open one.
 */
export type AuthResult = { ok: true } | { ok: false; status: number; error: string };

export function checkApiKey(header: string | string[] | undefined): AuthResult {
  const expected = process.env.CONDITION_API_KEY;
  if (!expected) {
    return { ok: false, status: 503, error: "API:t är inte aktiverat: CONDITION_API_KEY saknas i serverns miljö." };
  }
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) {
    return { ok: false, status: 401, error: "Saknar x-api-key." };
  }
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  // timingSafeEqual throws on length mismatch, so compare lengths first — that much is unavoidable.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "Ogiltig x-api-key." };
  }
  return { ok: true };
}
