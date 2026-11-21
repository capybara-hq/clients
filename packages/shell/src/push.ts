// Push notifications in the mobile shell (mobile spec §5, core spec §9): which deployments a build
// can receive push from, which Android channel to register with, whether a push that arrives in
// the foreground is shown, and how a tapped push is matched to a profile. Pure: no I/O.
import { isRecord } from "./validate.js";

/** One entry of the meta's `features.push`: an app id and the channels that cover it. */
export interface PushApp {
  appId: string;
  providers: string[];
}

/** The longest in-app path a push carries (core `PUSH_LIMITS.pathChars`). */
export const PUSH_PATH_MAX = 512;
/** The longest thread id the shell accepts from a payload. */
export const PUSH_THREAD_ID_MAX = 128;

/**
 * True when the deployment lists the build's app id with a channel the build carries: only then
 * does the profile get `push@1` (a build without push credentials on that deployment never does).
 */
export function offersPush(
  meta: { features?: { push?: readonly PushApp[] } },
  build: { appId: string; providers: readonly string[] },
): boolean {
  const apps = meta.features?.push ?? [];
  return apps.some(
    (app) => app.appId === build.appId && app.providers.some((p) => build.providers.includes(p)),
  );
}

/**
 * The Android channel to register with: FCM when the phone has Google Play services and the build
 * carries it, else the aggregator, else none.
 */
export function pickAndroidProvider(
  env: { googlePlayServices: boolean },
  carried: { fcm?: string; aggregator?: string },
): string | null {
  if (env.googlePlayServices && carried.fcm) return carried.fcm;
  return carried.aggregator ?? null;
}

function pathnameOf(path: string, origin: string): string | null {
  try {
    return new URL(path, origin).pathname;
  } catch {
    return null;
  }
}

/**
 * Whether a push that arrives while the app is in the foreground shows as a banner: not when its
 * page is the one on screen (same origin, same pathname; the query may differ), shown otherwise.
 */
export function shouldPresentForeground(
  push: { origin: string; path: string },
  screen: { origin: string; url: string } | null,
): boolean {
  if (!screen || screen.origin !== push.origin) return true;
  let url: URL;
  try {
    url = new URL(screen.url);
  } catch {
    return true;
  }
  if (url.origin !== push.origin) return true;
  return url.pathname !== pathnameOf(push.path, push.origin);
}

/** The profile whose origin is exactly the push's origin, or null (never a prefix match). */
export function profileForPush(
  origin: string,
  profiles: readonly { id: string; origin: string }[],
): string | null {
  return profiles.find((p) => p.origin === origin)?.id ?? null;
}

/**
 * An origin as the kernel sends it: `new URL(http.publicUrl).origin`, already normalized
 * (`scheme://host[:port]`, lower case, punycode, no default port). Anything that is not exactly
 * its own serialized origin is refused: fail closed rather than guess at a normalization.
 */
function isOrigin(v: string): boolean {
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return url.origin === v;
}

/** An in-app path: one leading `/`, no backslash, and it resolves on the push's own origin. */
function isInAppPath(path: string, origin: string): boolean {
  if (path.length === 0 || path.length > PUSH_PATH_MAX) return false;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
  try {
    return new URL(path, origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The routing fields of a push's data (the channel-neutral message's `origin`, `path`,
 * `threadId`), or null when any is missing or malformed. Other fields are ignored.
 */
export function parsePushPayload(
  data: Record<string, unknown>,
): { origin: string; path: string; threadId: string } | null {
  if (!isRecord(data)) return null;
  const { origin, path, threadId } = data;
  if (typeof origin !== "string" || !isOrigin(origin)) return null;
  if (typeof path !== "string" || !isInAppPath(path, origin)) return null;
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  if (threadId.length > PUSH_THREAD_ID_MAX) return null;
  return { origin, path, threadId };
}

/** The meta's `features.push`, or undefined when absent or malformed (ignored, not fatal). */
export function parsePushApps(v: unknown): PushApp[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const apps: PushApp[] = [];
  for (const entry of v) {
    if (!isRecord(entry) || typeof entry.appId !== "string") return undefined;
    const { providers } = entry;
    if (!Array.isArray(providers) || !providers.every((p) => typeof p === "string")) {
      return undefined;
    }
    apps.push({ appId: entry.appId, providers: [...providers] });
  }
  return apps;
}
