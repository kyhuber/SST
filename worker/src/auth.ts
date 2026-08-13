/**
 * Prototype access control: a single shared passphrase, checked here and
 * nowhere else.
 *
 * This is deliberately one function with a small number of call sites. The
 * plan is to put Cloudflare Access with a board email allowlist in front of
 * the Worker later; when that happens, this file is deleted and the calls are
 * removed. Nothing else in the Worker needs to change.
 */

import type { Env } from "./types";

/** Header the frontend sends the passphrase in. */
export const AUTH_HEADER = "X-HPIC-Auth";

/**
 * Compares two strings without leaking their contents through timing.
 * Length is not secret enough to matter here, but the comparison itself
 * runs over a fixed number of characters regardless.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // Compare over the longer length so a length mismatch costs the same.
  const length = Math.max(aBytes.length, bBytes.length);
  let mismatch = aBytes.length ^ bBytes.length;
  for (let i = 0; i < length; i++) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return mismatch === 0;
}

/** True when `supplied` matches the configured passphrase. */
export function checkPassphrase(supplied: string | null, env: Env): boolean {
  const expected = env.ACCESS_PASSPHRASE ?? "";
  // An unset passphrase must never mean "everyone is allowed".
  if (expected.length === 0) return false;
  if (supplied === null) return false;
  return constantTimeEqual(supplied, expected);
}

/** True when the request carries a valid passphrase header. */
export function authorize(request: Request, env: Env): boolean {
  return checkPassphrase(request.headers.get(AUTH_HEADER), env);
}
