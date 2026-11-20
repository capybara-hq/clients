// The appearance a profile's local pages and windows use (desktop spec §6.10). The source of truth
// is the web's own `cb-theme` cookie in the profile's partition; the last chrome@1 report carries
// the platform's colors (and whether its theme has one scheme only); before any profile the OS
// decides. The cookie reads and writes are preferences.ts; this module only resolves.
import {
  type Appearance,
  BUILTIN_TOKENS,
  isColor as isColorValue,
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

/** The window background for an appearance, as Electron takes it: the reported `bg`, else built-in. */
export function backgroundOf(appearance: Appearance): string {
  return electronColor(appearance.tokens?.bg) ?? BUILTIN_TOKENS[appearance.scheme].bg;
}

/**
 * A validated color (`isColor`) as Electron takes it: `#rgb` / `#rrggbb` stay, `rgb()` / `rgba()`
 * become `#rrggbb` with the alpha dropped (Electron reads 8 hex digits alpha first, CSS alpha
 * last, so no alpha form is ever handed over). Undefined for anything that is not a color.
 */
export function electronColor(color: unknown): string | undefined {
  if (!isColorValue(color)) return undefined;
  if (color.startsWith("#")) return color;
  const parts = color.slice(color.indexOf("(") + 1, -1).split(",");
  const hex = parts
    .slice(0, 3)
    .map((p) => Number(p.trim()).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
}

/** The title bar overlay's colors (Windows / Linux) for an appearance. */
export function overlayColors(appearance: Appearance): { color: string; symbolColor: string } {
  const tokens = appearance.tokens ?? BUILTIN_TOKENS[appearance.scheme];
  return {
    color: electronColor(tokens.bg) ?? BUILTIN_TOKENS[appearance.scheme].bg,
    symbolColor: electronColor(tokens.muted) ?? BUILTIN_TOKENS[appearance.scheme].muted,
  };
}
