// A profile's appearance as `chrome@1.setAppearance` reports it (mobile spec §4.4, §6.3; layout
// spec §9.2): validated, kept per profile under `appearance.<profileId>`, and turned into what
// native sets (the background behind the WebView and the status bar style). The stored value is
// applied at the next launch before the WebView loads, so the launch never flashes another color.
import type { ChromeCapabilityV1, ShellChromeTokens } from "@capybara-hq/plugin-sdk";
import { isRecord } from "@capybara-hq/shell";

export type ChromeTokens = ShellChromeTokens;

/** What `chrome@1.setAppearance` takes. */
export type ChromeAppearance = Parameters<ChromeCapabilityV1["setAppearance"]>[0];

/** What native sets: an opaque `#rrggbb` and the status bar content style. */
export interface NativeLook {
  background: string;
  /** `light` content on a dark scheme, `dark` content on a light one. */
  statusBar: "light" | "dark";
  /**
   * The page's accent and the ink on it, opaque `#rrggbb`, when it sent its tokens: the strip
   * fills its top item with them (nav@1, iOS). Absent: the shell's own tint.
   */
  accent?: string;
  onAccent?: string;
}

const TOKEN_NAMES = ["bg", "panel", "ink", "muted", "line", "accent", "onAccent"] as const;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const BYTE = "(25[0-5]|2[0-4]\\d|1\\d\\d|\\d{1,2})";
const ALPHA = "(?:0|1|0?\\.\\d{1,4}|1\\.0{1,4})";
const RGB = new RegExp(`^rgb\\(\\s*${BYTE}\\s*,\\s*${BYTE}\\s*,\\s*${BYTE}\\s*\\)$`);
const RGBA = new RegExp(
  `^rgba\\(\\s*${BYTE}\\s*,\\s*${BYTE}\\s*,\\s*${BYTE}\\s*,\\s*${ALPHA}\\s*\\)$`,
);

/**
 * `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `rgba(r, g, b, a)` (the desktop's rule). Named colors,
 * `var()` and 4 or 8 hex digits (alpha first natively, last in CSS) are not colors here.
 */
export function isColor(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 64) return false;
  return HEX.test(v) || RGB.test(v) || RGBA.test(v);
}

/** A color as an opaque lower-case `#rrggbb` (the alpha dropped); undefined when not a color. */
export function opaqueHex(color: unknown): string | undefined {
  if (!isColor(color)) return undefined;
  if (color.startsWith("#")) {
    const h = color.slice(1).toLowerCase();
    return h.length === 3 ? `#${[...h].map((c) => c + c).join("")}` : `#${h}`;
  }
  const m = RGB.exec(color) ?? RGBA.exec(color);
  if (!m) return undefined;
  return `#${m
    .slice(1, 4)
    .map((n) => Number(n).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** A clean copy of a `setAppearance` input or a stored one; null when anything is invalid. */
export function validAppearanceInput(v: unknown): ChromeAppearance | null {
  if (!isRecord(v)) return null;
  if (v.scheme !== "light" && v.scheme !== "dark") return null;
  if (!isColor(v.background)) return null;
  const out: ChromeAppearance = { scheme: v.scheme, background: v.background };
  if (v.tokens !== undefined) {
    if (!isRecord(v.tokens)) return null;
    const tokens = {} as ChromeTokens;
    for (const name of TOKEN_NAMES) {
      const value = v.tokens[name];
      if (!isColor(value)) return null;
      tokens[name] = value;
    }
    out.tokens = tokens;
  }
  if (v.singleScheme !== undefined) {
    if (typeof v.singleScheme !== "boolean") return null;
    if (v.singleScheme) out.singleScheme = true;
  }
  return out;
}

export function nativeLook(a: ChromeAppearance): NativeLook {
  const look: NativeLook = {
    background: opaqueHex(a.background) ?? (a.scheme === "dark" ? "#0a0a0a" : "#faf9f6"),
    statusBar: a.scheme === "dark" ? "light" : "dark",
  };
  const accent = opaqueHex(a.tokens?.accent);
  const onAccent = opaqueHex(a.tokens?.onAccent);
  if (accent && onAccent) {
    look.accent = accent;
    look.onAccent = onAccent;
  }
  return look;
}

export const appearanceKey = (profileId: string) => `appearance.${profileId}`;

/** An async key-value backend (`PrefsBackend` in profiles.ts, `@capacitor/preferences`). */
export interface AppearanceBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface AppearanceStore {
  /** The last valid appearance of the profile; null when none, malformed or unreadable. */
  load(profileId: string): Promise<ChromeAppearance | null>;
  save(profileId: string, a: ChromeAppearance): Promise<void>;
}

export function createAppearanceStore(backend: AppearanceBackend): AppearanceStore {
  return {
    async load(profileId) {
      try {
        const raw = await backend.get(appearanceKey(profileId));
        return raw === null ? null : validAppearanceInput(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    save: (profileId, a) => backend.set(appearanceKey(profileId), JSON.stringify(a)),
  };
}
