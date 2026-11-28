// The appearance a profile's local pages and windows use (desktop spec §6.10). The source of truth
// is the web's own `cb-theme` cookie in the profile's partition; the last chrome@1 report carries
// the platform's colors (and whether its theme has one scheme only); before any profile the OS
// decides. The cookie reads and writes are preferences.ts; this module only resolves.

import type { Tokens } from "../shared/appearance.ts";
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

/**
 * The main window's caption overlay on Windows / Linux: no ground of its own, so the web shows
 * through it (the shell's ground, a paper's corner, a dialog's scrim), only the symbols in the
 * appearance's muted color.
 */
export const TRANSPARENT_OVERLAY = "rgba(0, 0, 0, 0)";
export function mainOverlayColors(appearance: Appearance): { color: string; symbolColor: string } {
  return { color: TRANSPARENT_OVERLAY, symbolColor: overlayColors(appearance).symbolColor };
}

/** A color with no transparency: hex, `rgb()`, or `rgba()` whose alpha is 1. */
export function isOpaque(color: string): boolean {
  if (!color.startsWith("rgba(")) return isColorValue(color);
  if (!isColorValue(color)) return false;
  const alpha = Number(color.slice(color.lastIndexOf(",") + 1, -1).trim());
  return alpha === 1;
}

/** Whether two appearances say the same (scheme, every token, singleScheme). */
export function sameAppearance(a: Appearance | undefined, b: Appearance | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.scheme !== b.scheme || (a.singleScheme === true) !== (b.singleScheme === true)) {
    return false;
  }
  if (!a.tokens || !b.tokens) return a.tokens === b.tokens;
  const ta = a.tokens;
  const tb = b.tokens;
  return (Object.keys(ta) as (keyof Tokens)[]).every((k) => ta[k] === tb[k]);
}
