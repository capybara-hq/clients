// The appearance a profile's local pages and windows use (desktop spec §6.10). The source of truth
// is the web's own `cb-theme` cookie in the profile's partition; the last chrome@1 report carries
// the platform's colors (and whether its theme has one scheme only); before any profile the OS
// decides. K8 adds the cookie reads and writes; this module only resolves.
import {
  type Appearance,
  BUILTIN_TOKENS,
  type Scheme,
  validAppearance,
} from "../shared/appearance.ts";

export {
  type Appearance,
  BUILTIN_TOKENS,
  isColor,
  type Scheme,
  type Tokens,
  validAppearance,
  validTokens,
} from "../shared/appearance.ts";

/**
 * - A single-scheme report wins outright: the platform has one look, and no toggle exists.
 * - Otherwise the scheme is the `cb-theme` cookie, else the last report's scheme, else the OS.
 * - The reported tokens apply only to the scheme they were reported for; after a local toggle to
 *   the other scheme the built-in values of that scheme are used until the web reports again.
 * Malformed input (a stored report, a cookie value) is ignored, never trusted.
 */
export function resolveAppearance(
  osDark: boolean,
  profileAppearance?: Appearance,
  cookieTheme?: string,
): Appearance {
  const report = validAppearance(profileAppearance);
  if (report?.singleScheme) return report;
  const cookie: Scheme | undefined =
    cookieTheme === "light" || cookieTheme === "dark" ? cookieTheme : undefined;
  const scheme: Scheme = cookie ?? report?.scheme ?? (osDark ? "dark" : "light");
  const tokens = report?.tokens && report.scheme === scheme ? report.tokens : undefined;
  return { scheme, ...(tokens ? { tokens } : {}) };
}

/** The window background for an appearance: the reported `bg`, else the built-in one. */
export function backgroundOf(appearance: Appearance): string {
  return appearance.tokens?.bg ?? BUILTIN_TOKENS[appearance.scheme].bg;
}
