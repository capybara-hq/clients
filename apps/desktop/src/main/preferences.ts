// Theme and language (desktop spec §6.10, §12). The source of truth of a profile is the web's own
// cookies in its partition: `cb-theme` (light | dark, design's THEME_COOKIE) and `NEXT_LOCALE`
// (zh | en, the web's LOCALE_COOKIE). A local page's toggle writes them for the profile's origin
// with the attributes the web writes (path /, one year, SameSite=Lax; never HttpOnly: the web
// reads them), plus Secure on https. Before any profile the app keeps its own choice in
// `<userData>/preferences.json`, else the OS decides; that choice seeds a new profile's cookies.
//
// The local pages' state is synchronous, so the values are cached per profile: read when a profile
// is watched and again whenever the partition reports a change to one of the two cookies (a toggle
// in the web). Only the fixed values are ever written or trusted. Electron objects come in as
// parameters.
import { dirname } from "node:path";
import type { Locale } from "@capybara-hq/shell";
import type { Appearance, Scheme } from "../shared/appearance.ts";
import type { LocalActContext, LocalPages } from "./local-pages.ts";
import { localeFrom } from "./locale.ts";
import type { Profile } from "./profiles.ts";

export type Theme = Scheme;

export const THEME_COOKIE = "cb-theme";
export const LOCALE_COOKIE = "NEXT_LOCALE";
export const THEMES: readonly Theme[] = ["light", "dark"];
export const LOCALES: readonly Locale[] = ["zh", "en"];
/** The web's `max-age=31536000`. */
export const COOKIE_LIFETIME_S = 31_536_000;

export const isTheme = (v: unknown): v is Theme =>
  typeof v === "string" && (THEMES as readonly string[]).includes(v);
export const isLocale = (v: unknown): v is Locale =>
  typeof v === "string" && (LOCALES as readonly string[]).includes(v);

export interface CookieDetails {
  url: string;
  name: string;
  value: string;
  path: string;
  expirationDate: number;
  sameSite: "lax";
  secure: boolean;
  httpOnly: false;
}

/** The part of Electron's `session.cookies` used here. */
export interface CookieJarLike {
  get(filter: {
    url: string;
    name: string;
  }): Promise<{ name: string; value: string; domain?: string; hostOnly?: boolean }[]>;
  set(details: CookieDetails): Promise<void>;
  on?(
    event: "changed",
    listener: (event: unknown, cookie: { name: string }, cause: string, removed: boolean) => void,
  ): unknown;
}

export interface PreferencesFs {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  mkdirSync(path: string, options: { recursive: true }): unknown;
}

export interface AppPreferences {
  theme?: Theme;
  locale?: Locale;
}

export type PrefsProfile = Pick<Profile, "id" | "origin">;

export interface PreferencesDeps {
  /** `<userData>/preferences.json`. */
  file: string;
  fs: PreferencesFs;
  /** The profile's partition's cookie jar. */
  cookiesFor(profile: PrefsProfile): CookieJarLike;
  /** `app.getLocale()`. */
  osLocale(): string;
  /** Seconds since the epoch; injected for tests. */
  now?(): number;
  /** A cached value changed: of `profileId`, or app level when undefined. */
  onChange?(profileId: string | undefined): void;
  log?: (message: string, err?: unknown) => void;
}

/** The cookie a toggle writes for `origin`: only the fixed names and values reach here. */
export function preferenceCookie(
  origin: string,
  name: typeof THEME_COOKIE | typeof LOCALE_COOKIE,
  value: string,
  nowS: number,
): CookieDetails {
  const ok = name === THEME_COOKIE ? isTheme(value) : isLocale(value);
  if (!ok) throw new Error(`${name} does not take that value`);
  const url = new URL(origin);
  return {
    url: `${url.origin}/`,
    name,
    value,
    path: "/",
    expirationDate: Math.floor(nowS) + COOKIE_LIFETIME_S,
    sameSite: "lax",
    secure: url.protocol === "https:",
    httpOnly: false,
  };
}

function readAppFile(deps: PreferencesDeps): AppPreferences {
  try {
    const raw: unknown = JSON.parse(deps.fs.readFileSync(deps.file, "utf8"));
    if (typeof raw !== "object" || raw === null) return {};
    const r = raw as Record<string, unknown>;
    return {
      ...(isTheme(r.theme) ? { theme: r.theme } : {}),
      ...(isLocale(r.locale) ? { locale: r.locale } : {}),
    };
  } catch {
    // Missing or malformed: no choice yet.
    return {};
  }
}

export function createPreferences(deps: PreferencesDeps) {
  const log = (message: string, err?: unknown) => deps.log?.(message, err);
  const now = deps.now ?? (() => Date.now() / 1000);
  let app = readAppFile(deps);
  const cache = new Map<string, { theme?: Theme; locale?: Locale }>();
  const watched = new Set<string>();
  /** Partitions with a change listener: one each, kept across forget (a partition lives on). */
  const listening = new Set<string>();
  /** The newest load per profile: only it writes the cache. */
  const loads = new Map<string, number>();
  /** Generation counter shared by all profiles, so a deleted entry never repeats a number. */
  let generation = 0;
  /** The tail of each profile's seed chain. */
  const seeding = new Map<string, Promise<void>>();

  function saveApp(): void {
    const tmp = `${deps.file}.tmp`;
    deps.fs.mkdirSync(dirname(deps.file), { recursive: true });
    deps.fs.writeFileSync(tmp, `${JSON.stringify(app, null, 2)}\n`);
    deps.fs.renameSync(tmp, deps.file);
  }

  async function readCookie(
    profile: PrefsProfile,
    name: typeof THEME_COOKIE | typeof LOCALE_COOKIE,
  ): Promise<string | undefined> {
    const valid = name === THEME_COOKIE ? isTheme : isLocale;
    try {
      const found = (
        await deps.cookiesFor(profile).get({ url: `${profile.origin}/`, name })
      ).filter((c) => c.name === name && valid(c.value));
      // The web writes a host-only cookie; one set for a parent domain only counts without it.
      const host = new URL(profile.origin).hostname;
      const own = found.find((c) => c.hostOnly === true || c.domain === host);
      return (own ?? found[0])?.value;
    } catch (err) {
      log(`could not read ${name}`, err);
      return undefined;
    }
  }

  /** Starts a new generation of the profile's cached values: older loads stop counting. */
  function bump(profileId: string): number {
    const seq = ++generation;
    loads.set(profileId, seq);
    return seq;
  }

  /** Runs `fn` after the profile's earlier seeds: one seed at a time per partition. */
  function serial(profileId: string, fn: () => Promise<void>): Promise<void> {
    const next = (seeding.get(profileId) ?? Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => undefined);
    seeding.set(profileId, tail);
    void tail.then(() => {
      if (seeding.get(profileId) === tail) seeding.delete(profileId);
    });
    return next;
  }

  /** Re-reads both cookies of `profile` into the cache; reports a change. */
  async function load(profile: PrefsProfile): Promise<void> {
    const seq = bump(profile.id);
    const theme = await readCookie(profile, THEME_COOKIE);
    const locale = await readCookie(profile, LOCALE_COOKIE);
    // A newer load or write has the last word; a forgotten profile keeps no entry.
    if (loads.get(profile.id) !== seq || !watched.has(profile.id)) return;
    const next = {
      ...(isTheme(theme) ? { theme } : {}),
      ...(isLocale(locale) ? { locale } : {}),
    };
    const prev = cache.get(profile.id);
    cache.set(profile.id, next);
    if (prev?.theme !== next.theme || prev?.locale !== next.locale) deps.onChange?.(profile.id);
  }

  async function writeCookie(
    profile: PrefsProfile,
    name: typeof THEME_COOKIE | typeof LOCALE_COOKIE,
    value: string,
  ): Promise<void> {
    await deps.cookiesFor(profile).set(preferenceCookie(profile.origin, name, value, now()));
  }

  async function seedNow(profile: PrefsProfile, o: { overwrite?: boolean }): Promise<void> {
    const pairs: [typeof THEME_COOKIE | typeof LOCALE_COOKIE, string | undefined][] = [
      [THEME_COOKIE, app.theme],
      [LOCALE_COOKIE, app.locale],
    ];
    for (const [name, value] of pairs) {
      if (value === undefined) continue;
      try {
        if (!o.overwrite && (await readCookie(profile, name)) !== undefined) continue;
        await writeCookie(profile, name, value);
      } catch (err) {
        log(`could not seed ${name}`, err);
      }
    }
    if (watched.has(profile.id)) await load(profile);
  }

  function locale(profile?: PrefsProfile): Locale {
    return (
      (profile ? cache.get(profile.id)?.locale : undefined) ??
      app.locale ??
      localeFrom(deps.osLocale())
    );
  }

  return {
    /** The profile's `cb-theme`, read from its partition now (undefined: none or not valid). */
    async readTheme(profile: PrefsProfile): Promise<Theme | undefined> {
      const v = await readCookie(profile, THEME_COOKIE);
      return isTheme(v) ? v : undefined;
    },

    /** The profile's `NEXT_LOCALE`, read from its partition now. */
    async readLocale(profile: PrefsProfile): Promise<Locale | undefined> {
      const v = await readCookie(profile, LOCALE_COOKIE);
      return isLocale(v) ? v : undefined;
    },

    /**
     * Caches the profile's two cookies and follows changes to them (a toggle in the web). Once per
     * profile; a later call only re-reads.
     */
    async watch(profile: PrefsProfile): Promise<void> {
      watched.add(profile.id);
      if (!listening.has(profile.id)) {
        listening.add(profile.id);
        try {
          deps.cookiesFor(profile).on?.("changed", (_event, cookie) => {
            if (!watched.has(profile.id)) return;
            if (cookie?.name !== THEME_COOKIE && cookie?.name !== LOCALE_COOKIE) return;
            // The event's cookie may be of another domain (a redirect through another origin):
            // read again for the profile's origin instead of trusting it.
            void load(profile);
          });
        } catch (err) {
          log("could not follow the preference cookies", err);
        }
      }
      await load(profile);
    },

    /** The profile is gone: its cache and its change listener stop counting. */
    forget(profileId: string): void {
      watched.delete(profileId);
      cache.delete(profileId);
      // An in-flight load finds no entry and stops.
      loads.delete(profileId);
    },

    /** Sets the theme of `profile` (its cookie) or, without one, the app's choice. */
    async setTheme(profile: PrefsProfile | undefined, theme: Theme): Promise<void> {
      if (!isTheme(theme)) throw new Error("not a theme");
      if (!profile) {
        app = { ...app, theme };
        saveApp();
        deps.onChange?.(undefined);
        return;
      }
      await writeCookie(profile, THEME_COOKIE, theme);
      if (!watched.has(profile.id)) return;
      cache.set(profile.id, { ...cache.get(profile.id), theme });
      deps.onChange?.(profile.id);
      // Read both cookies again: a load in flight (the other preference toggled in the web) is
      // superseded, and its field ends up current too.
      await load(profile);
    },

    /** Sets the language of `profile` (its cookie) or, without one, the app's choice. */
    async setLocale(profile: PrefsProfile | undefined, locale: Locale): Promise<void> {
      if (!isLocale(locale)) throw new Error("not a locale");
      if (!profile) {
        app = { ...app, locale };
        saveApp();
        deps.onChange?.(undefined);
        return;
      }
      await writeCookie(profile, LOCALE_COOKIE, locale);
      if (!watched.has(profile.id)) return;
      cache.set(profile.id, { ...cache.get(profile.id), locale });
      deps.onChange?.(profile.id);
      // Read both cookies again: a load in flight (the other preference toggled in the web) is
      // superseded, and its field ends up current too.
      await load(profile);
    },

    /**
     * Seeds a new profile's partition with the app's choices; a cookie the partition holds already
     * stays. `overwrite`: the app's choice wins (a provisional profile whose pages are app level).
     */
    seed(profile: PrefsProfile, o: { overwrite?: boolean } = {}): Promise<void> {
      return serial(profile.id, () => seedNow(profile, o));
    },

    /** The app's own choices (before any profile). */
    app(): AppPreferences {
      return { ...app };
    },

    /**
     * The theme cookie to resolve the appearance with: the profile's cached `cb-theme`, or for no
     * profile the app's choice (undefined: the report, else the OS, decides).
     */
    theme(profile?: PrefsProfile): Theme | undefined {
      return profile ? cache.get(profile.id)?.theme : app.theme;
    },

    /** A page's language: the profile's `NEXT_LOCALE`, else the app's choice, else the OS. */
    locale,

    /**
     * The menus' language (spec §12): of the current profile once a profile exists (the last used
     * when it is among `profiles`, the offered ones, else the first of them), else the app's
     * choice, else the OS.
     */
    menuLocale(lastUsed: PrefsProfile | undefined, profiles: readonly PrefsProfile[]): Locale {
      const current =
        lastUsed && profiles.some((p) => p.id === lastUsed.id) ? lastUsed : profiles[0];
      return locale(current);
    },
  };
}

export type Preferences = ReturnType<typeof createPreferences>;

/**
 * The provisional profile whose partition follows an app-level choice: the one whose sign-in began
 * last, while the small window still shows it as provisional; undefined otherwise.
 */
export function provisionalToFollow<P extends PrefsProfile>(
  current: { provisional: boolean; profileId?: string } | undefined,
  begun: P | undefined,
): P | undefined {
  return current?.provisional && begun && current.profileId === begun.id ? begun : undefined;
}

export interface PreferenceActionDeps {
  localPages: Pick<LocalPages, "handle">;
  prefs: Pick<Preferences, "setTheme" | "setLocale">;
  /** The stored profile of a page's `profileId`. */
  getProfile(id: string): Profile | undefined;
  /** The appearance the page shows now (its `singleScheme` hides and refuses the toggle). */
  appearanceOf(profile: Profile | undefined): Appearance;
  /** After an app-level choice: a provisional profile in sign-in follows it (`seed` overwrite). */
  afterAppLevel?(): Promise<void> | void;
}

/**
 * The onboarding page's `prefs.setTheme` / `prefs.setLocale` (spec §6.10): for the page's profile
 * (its cookie) or, for an app-level page, the app's choice. The arguments arrive checked against
 * the fixed sets (LOCAL_PAGE_ACTIONS) and are checked again here. A page whose profile is gone, or
 * a theme toggle under a single-scheme platform theme, is refused (false).
 */
export function installPreferenceActions(deps: PreferenceActionDeps): () => void {
  const profileOf = (ctx: LocalActContext): { ok: boolean; profile?: Profile } => {
    if (ctx.profileId === undefined) return { ok: true };
    const profile = deps.getProfile(ctx.profileId);
    return profile ? { ok: true, profile } : { ok: false };
  };
  const offTheme = deps.localPages.handle("onboarding", "prefs.setTheme", async (ctx, args) => {
    if (!isTheme(args.theme)) return false;
    const { ok, profile } = profileOf(ctx);
    if (!ok || deps.appearanceOf(profile).singleScheme) return false;
    await deps.prefs.setTheme(profile, args.theme);
    if (!profile) await deps.afterAppLevel?.();
    return true;
  });
  const offLocale = deps.localPages.handle("onboarding", "prefs.setLocale", async (ctx, args) => {
    if (!isLocale(args.locale)) return false;
    const { ok, profile } = profileOf(ctx);
    if (!ok) return false;
    await deps.prefs.setLocale(profile, args.locale);
    if (!profile) await deps.afterAppLevel?.();
    return true;
  });
  return () => {
    offTheme();
    offLocale();
  };
}
