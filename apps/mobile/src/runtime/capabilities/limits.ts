// The mobile shell's input limits, declared structurally: the same values as the SDK's
// `MOBILE_SHELL_LIMITS` and `MENU_ITEM_ID` (core packages/plugin-sdk/src/shell-capabilities.ts).
// The pinned `@capybara-hq/plugin-sdk` predates them; the coordinator replaces this file with the
// SDK's exports once a release carries them.
import type { ProfileRef } from "../protocol.ts";

export const MOBILE_SHELL_LIMITS = {
  menuItems: 12,
  menuLabel: 64,
  menuTitle: 128,
  shareTitle: 256,
  shareText: 4000,
  url: 2048,
} as const;

export const MENU_ITEM_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when `v` has no key outside `allowed`. */
export function onlyKeys(v: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(v).every((k) => allowed.includes(k));
}

/**
 * Resolves a page-supplied URL against the profile's origin. Allowed: `https:` anywhere, or any
 * URL on the profile's own origin (a deployment may be plain http on a private network). Returns
 * the serialized URL, or null.
 */
export function resolveWebUrl(profile: ProfileRef, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MOBILE_SHELL_LIMITS.url) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw, profile.origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.origin !== profile.origin) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const href = url.href;
  return href.length > MOBILE_SHELL_LIMITS.url ? null : href;
}

export function fail(): never {
  throw { code: "failed" };
}
