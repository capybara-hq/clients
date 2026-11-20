// The appearance of the local pages (desktop spec §6.10): a scheme and, when the web reported its
// theme through chrome@1, the seven main color tokens. Pure; shared by main, the preload and the
// local pages' runtime (which validates again before it sets a custom property).

export type Scheme = "light" | "dark";

export interface Tokens {
  bg: string;
  panel: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  onAccent: string;
}

export interface Appearance {
  scheme: Scheme;
  /** The platform's own colors (chrome@1); absent = the built-in E 终端 values for `scheme`. */
  tokens?: Tokens;
  /** The platform's theme has one scheme only: no light / dark toggle anywhere. */
  singleScheme?: boolean;
}

export const TOKEN_NAMES = [
  "bg",
  "panel",
  "ink",
  "muted",
  "line",
  "accent",
  "onAccent",
] as const satisfies readonly (keyof Tokens)[];

/** The E 终端 values (design tokens of core's `@capybara-hq/design`, copied: the clients rule). */
export const BUILTIN_TOKENS: Record<Scheme, Tokens> = {
  dark: {
    bg: "#0A0A0A",
    panel: "#111110",
    ink: "#E6E6E3",
    muted: "#8E8E89",
    line: "#2A2A28",
    accent: "#FF6A13",
    onAccent: "#0A0A0A",
  },
  light: {
    bg: "#FAF9F6",
    panel: "#FFFFFF",
    ink: "#1A1A18",
    muted: "#5E5E5A",
    line: "#D9D8D2",
    accent: "#CC4609",
    onAccent: "#FFFFFF",
  },
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const BYTE = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|\\d{1,2})";
const ALPHA = "(?:0|1|0?\\.\\d{1,4}|1\\.0{1,4})";
const RGB = new RegExp(`^rgb\\(\\s*${BYTE}\\s*,\\s*${BYTE}\\s*,\\s*${BYTE}\\s*\\)$`);
const RGBA = new RegExp(
  `^rgba\\(\\s*${BYTE}\\s*,\\s*${BYTE}\\s*,\\s*${BYTE}\\s*,\\s*${ALPHA}\\s*\\)$`,
);

/**
 * `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `rgba(r, g, b, a)` with bytes 0–255 and alpha 0–1: the
 * forms the web's `chrome@1` report may carry (the design's COLOR rule). Anything else (named
 * colors, `color-mix()`, `var()`, 4 or 8 hex digits, which Electron and CSS read differently) is
 * not a color here.
 */
export function isColor(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 64) return false;
  return HEX.test(v) || RGB.test(v) || RGBA.test(v);
}

/** The seven tokens when every one is a color, else undefined (never a partial set). */
export function validTokens(v: unknown): Tokens | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const out = {} as Tokens;
  for (const name of TOKEN_NAMES) {
    const value = r[name];
    if (!isColor(value)) return undefined;
    out[name] = value;
  }
  return out;
}

/** A clean copy of a stored or received appearance, or undefined when its scheme is invalid. */
export function validAppearance(v: unknown): Appearance | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (r.scheme !== "light" && r.scheme !== "dark") return undefined;
  const tokens = validTokens(r.tokens);
  return {
    scheme: r.scheme,
    ...(tokens ? { tokens } : {}),
    ...(r.singleScheme === true ? { singleScheme: true } : {}),
  };
}

/** CSS custom property per token: what the local pages' stylesheet reads. */
export const TOKEN_PROPERTIES: Record<keyof Tokens, string> = {
  bg: "--cb-bg",
  panel: "--cb-panel",
  ink: "--cb-ink",
  muted: "--cb-muted",
  line: "--cb-line",
  accent: "--cb-accent",
  onAccent: "--cb-on-accent",
};
