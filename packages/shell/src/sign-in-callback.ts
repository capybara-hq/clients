import type { AuthCallback } from "./deep-link.js";

export const SIGN_IN_TTL_MS = 10 * 60 * 1000;

const stripSlashes = (s: string) => s.replace(/\/+$/, "");

/** Checks a sign-in callback against the pending attempt: state, then expiry, then issuer. */
export function checkCallback(
  cb: AuthCallback,
  pending: { state: string; base: string; createdAt: number },
  now: number,
): "ok" | "unknown_state" | "wrong_issuer" | "expired" {
  if (cb.state !== pending.state) return "unknown_state";
  if (now - pending.createdAt > SIGN_IN_TTL_MS) return "expired";
  if (stripSlashes(cb.iss) !== stripSlashes(pending.base)) return "wrong_issuer";
  return "ok";
}
