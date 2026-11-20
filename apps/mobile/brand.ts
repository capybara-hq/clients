/**
 * The only brand file of the mobile app: a fork that ships its own build changes these values and
 * the two images under assets/, then runs `pnpm --filter @capybara-hq/mobile apply-brand`.
 * scripts/apply-brand.ts writes the native identifiers, icon sets and splash from it; CI runs
 * `check:brand` and fails on drift.
 */
export type Brand = {
  /** The name under the icon. */
  productName: string;
  /** Bundle id (iOS) and application id (Android): reverse DNS. */
  appId: string;
  /** The custom URL scheme the sign-in callback returns on (`<scheme>://auth/callback`). */
  scheme: string;
  /** 1024 x 1024 PNG, relative to this folder. */
  icon: string;
  /** The launch image and its ground colours (the page ground tokens of the design system). */
  splash: { image: string; background: { light: string; dark: string } };
  /** A deployment the app opens straight into, or null. https only. */
  presetUrl: string | null;
  /** True: only the preset is usable (needs a preset). */
  lockToPreset: boolean;
};

export const brand: Brand = {
  productName: "Capybara",
  appId: "com.capybarahq.mobile",
  scheme: "capybara",
  icon: "assets/icon.png",
  splash: {
    image: "assets/splash.png",
    // The `bg` token of core docs/design/tokens.json ("Page background").
    background: { light: "#FAF9F6", dark: "#0A0A0A" },
  },
  presetUrl: null,
  lockToPreset: false,
};

// No underscores: App Store Connect rejects them in a bundle id.
const APP_ID = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
// Schemes a browser or the system already owns: a callback on them could be taken by someone else.
const RESERVED_SCHEMES = new Set([
  "http",
  "https",
  "file",
  "ftp",
  "ws",
  "wss",
  "data",
  "blob",
  "about",
  "javascript",
  "mailto",
  "tel",
  "sms",
  "intent",
]);

/** The problems of a brand, empty when it is valid. */
export function validateBrand(b: Brand): string[] {
  const problems: string[] = [];
  // The name lands in an xcconfig (`//` starts a comment, `$(` expands), a Java properties file and
  // an Android string resource.
  if (
    b.productName.trim() === "" ||
    /["'\\\n\r<>&@?]/.test(b.productName) ||
    b.productName.includes("//") ||
    b.productName.includes("$(")
  ) {
    problems.push(
      "productName must be non-empty and contain none of: quotes, backslash, newline, < > & @ ?, // and $(",
    );
  }
  if (b.icon !== "assets/icon.png") problems.push('icon must be "assets/icon.png"');
  if (b.splash.image !== "assets/splash.png") {
    problems.push('splash.image must be "assets/splash.png"');
  }
  if (!APP_ID.test(b.appId)) problems.push(`appId "${b.appId}" is not a reverse-DNS identifier`);
  if (!SCHEME.test(b.scheme)) {
    problems.push(`scheme "${b.scheme}" must be lowercase letters, digits, "+", "." or "-"`);
  } else if (RESERVED_SCHEMES.has(b.scheme)) {
    problems.push(`scheme "${b.scheme}" is reserved`);
  }
  if (b.presetUrl !== null) {
    let ok = false;
    try {
      const url = new URL(b.presetUrl);
      ok = url.protocol === "https:" && url.hostname !== "";
    } catch {}
    if (!ok) problems.push(`presetUrl "${b.presetUrl}" must be an https URL or null`);
  }
  if (b.lockToPreset && b.presetUrl === null) problems.push("lockToPreset needs a presetUrl");
  for (const mode of ["light", "dark"] as const) {
    if (!HEX.test(b.splash.background[mode])) {
      problems.push(`splash.background.${mode} must be #rrggbb`);
    }
  }
  return problems;
}
