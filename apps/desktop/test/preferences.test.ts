import { describe, expect, test, vi } from "vitest";
import { resolveAppearance } from "../src/main/appearance.ts";
import { createLocalPages } from "../src/main/local-pages.ts";
import {
  COOKIE_LIFETIME_S,
  type CookieDetails,
  createPreferences,
  installPreferenceActions,
  type PreferencesFs,
  preferenceCookie,
  provisionalToFollow,
} from "../src/main/preferences.ts";
import type { Profile } from "../src/main/profiles.ts";
import { LOCAL_ORIGIN } from "../src/shared/protocol.ts";

const NOW = 1_800_000_000;

const httpsProfile: Profile = {
  id: "p1",
  base: "https://capybara.example.com/team",
  origin: "https://capybara.example.com",
  name: "Example",
  signedIn: true,
};
const httpProfile: Profile = {
  id: "p2",
  base: "http://127.0.0.1:4000",
  origin: "http://127.0.0.1:4000",
  name: "Local",
  signedIn: true,
};

type Listener = (event: unknown, cookie: { name: string }, cause: string, removed: boolean) => void;

function fakeJar() {
  const cookies = new Map<string, CookieDetails>();
  const listeners: Listener[] = [];
  const jarParent = (name: string) => jar.parent.filter((c) => c.name === name);
  const jar = {
    cookies,
    listeners,
    /** Cookies of a parent domain, returned for every URL under it (like Chromium). */
    parent: [] as { name: string; value: string; domain: string; hostOnly: boolean }[],
    get: vi.fn(async (filter: { url: string; name: string }) => [
      ...jarParent(filter.name),
      ...[...cookies.values()]
        .filter((c) => c.url === filter.url && c.name === filter.name)
        .map((c) => ({ ...c, domain: new URL(c.url).hostname, hostOnly: true })),
    ]),
    set: vi.fn(async (d: CookieDetails) => {
      cookies.set(`${d.url} ${d.name}`, d);
      for (const l of listeners) l({}, { name: d.name }, "explicit", false);
    }),
    on: vi.fn((_event: "changed", l: Listener) => {
      listeners.push(l);
    }),
    /** What the web's own document.cookie write looks like to main. */
    webWrites(url: string, name: string, value: string) {
      cookies.set(`${url} ${name}`, {
        url,
        name,
        value,
        path: "/",
        expirationDate: NOW + COOKIE_LIFETIME_S,
        sameSite: "lax",
        secure: false,
        httpOnly: false,
      });
      for (const l of listeners) l({}, { name }, "explicit", false);
    },
    emit(name: string) {
      for (const l of listeners) l({}, { name }, "explicit", false);
    },
  };
  return jar;
}

function fakeFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("/data/preferences.json", initial);
  const fs: PreferencesFs = {
    readFileSync: (path) => {
      const v = files.get(path);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    writeFileSync: (path, data) => {
      files.set(path, data);
    },
    renameSync: (from, to) => {
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
    mkdirSync: () => undefined,
  };
  return { fs, files };
}

function setup(o: { file?: string; osLocale?: string } = {}) {
  const jars = new Map<string, ReturnType<typeof fakeJar>>();
  const jar = (id: string) => {
    let j = jars.get(id);
    if (!j) {
      j = fakeJar();
      jars.set(id, j);
    }
    return j;
  };
  const { fs, files } = fakeFs(o.file);
  const onChange = vi.fn();
  const prefs = createPreferences({
    file: "/data/preferences.json",
    fs,
    cookiesFor: (p) => jar(p.id),
    osLocale: () => o.osLocale ?? "en-US",
    now: () => NOW,
    onChange,
    log: vi.fn(),
  });
  return { prefs, jar, files, onChange };
}

/** Lets pending promise callbacks (a re-read after a change event) run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the preference cookies (spec 6.10)", () => {
  test("the attributes the web writes: path /, one year, lax, never HttpOnly; Secure on https", () => {
    expect(preferenceCookie(httpsProfile.origin, "cb-theme", "dark", NOW)).toEqual({
      url: "https://capybara.example.com/",
      name: "cb-theme",
      value: "dark",
      path: "/",
      expirationDate: NOW + 31_536_000,
      sameSite: "lax",
      secure: true,
      httpOnly: false,
    });
    expect(preferenceCookie(httpProfile.origin, "NEXT_LOCALE", "en", NOW)).toMatchObject({
      url: "http://127.0.0.1:4000/",
      name: "NEXT_LOCALE",
      value: "en",
      secure: false,
      httpOnly: false,
    });
  });

  test("nothing outside the fixed sets is ever written", async () => {
    for (const [name, value] of [
      ["cb-theme", "blue"],
      ["cb-theme", "dark; Domain=evil.example"],
      ["cb-theme", "zh"],
      ["NEXT_LOCALE", "fr"],
      ["NEXT_LOCALE", "light"],
      ["NEXT_LOCALE", ""],
    ] as const) {
      expect(() => preferenceCookie(httpsProfile.origin, name, value, NOW)).toThrow();
    }
    const s = setup();
    await expect(s.prefs.setTheme(httpsProfile, "blue" as never)).rejects.toThrow();
    await expect(s.prefs.setLocale(httpsProfile, "fr" as never)).rejects.toThrow();
    await expect(s.prefs.setTheme(undefined, "x" as never)).rejects.toThrow();
    expect(s.jar("p1").set).not.toHaveBeenCalled();
    expect(s.files.size).toBe(0);
  });

  test("setTheme / setLocale write the profile's cookies and update what pages read", async () => {
    const s = setup();
    await s.prefs.watch(httpsProfile);
    await s.prefs.setTheme(httpsProfile, "light");
    await s.prefs.setLocale(httpsProfile, "zh");
    expect([...s.jar("p1").cookies.values()].map((c) => [c.name, c.value, c.secure])).toEqual([
      ["cb-theme", "light", true],
      ["NEXT_LOCALE", "zh", true],
    ]);
    expect(s.prefs.theme(httpsProfile)).toBe("light");
    expect(s.prefs.locale(httpsProfile)).toBe("zh");
    expect(s.onChange).toHaveBeenCalledWith("p1");
    // The app level is untouched.
    expect(s.prefs.app()).toEqual({});
    expect(s.files.size).toBe(0);
  });

  test("reads ignore values outside the sets", async () => {
    const s = setup();
    s.jar("p1").webWrites("https://capybara.example.com/", "cb-theme", "<script>");
    s.jar("p1").webWrites("https://capybara.example.com/", "NEXT_LOCALE", "de");
    expect(await s.prefs.readTheme(httpsProfile)).toBeUndefined();
    expect(await s.prefs.readLocale(httpsProfile)).toBeUndefined();
    await s.prefs.watch(httpsProfile);
    expect(s.prefs.theme(httpsProfile)).toBeUndefined();
    expect(s.prefs.locale(httpsProfile)).toBe("en");
  });

  test("a toggle in the web reaches the cache through the partition's change event", async () => {
    const s = setup();
    await s.prefs.watch(httpsProfile);
    expect(s.prefs.locale(httpsProfile)).toBe("en");
    s.onChange.mockClear();
    s.jar("p1").webWrites("https://capybara.example.com/", "NEXT_LOCALE", "zh");
    await settle();
    expect(s.prefs.locale(httpsProfile)).toBe("zh");
    expect(s.onChange).toHaveBeenCalledWith("p1");
    // A cookie of the same name on another domain (a redirect hop) is not the profile's.
    s.jar("p1").webWrites("https://idp.example.org/", "NEXT_LOCALE", "en");
    await settle();
    expect(s.prefs.locale(httpsProfile)).toBe("zh");
    // Watching again adds no second listener.
    await s.prefs.watch(httpsProfile);
    expect(s.jar("p1").listeners).toHaveLength(1);
  });

  test("before any profile: the app's choice in preferences.json, else the OS", async () => {
    const s = setup({ osLocale: "zh-CN" });
    expect(s.prefs.locale()).toBe("zh");
    expect(s.prefs.theme()).toBeUndefined();
    await s.prefs.setLocale(undefined, "en");
    await s.prefs.setTheme(undefined, "dark");
    expect(s.prefs.locale()).toBe("en");
    expect(s.prefs.theme()).toBe("dark");
    expect(JSON.parse(s.files.get("/data/preferences.json") as string)).toEqual({
      theme: "dark",
      locale: "en",
    });
    expect(s.onChange).toHaveBeenCalledWith(undefined);
    // Kept across starts; malformed values are dropped.
    const again = setup({ file: s.files.get("/data/preferences.json") as string });
    expect(again.prefs.app()).toEqual({ theme: "dark", locale: "en" });
    const bad = setup({ file: '{"theme":"blue","locale":"fr"}' });
    expect(bad.prefs.app()).toEqual({});
    expect(setup({ file: "{not json" }).prefs.app()).toEqual({});
  });

  test("a profile without its own cookie follows the app's choice, then the OS", async () => {
    const s = setup({ osLocale: "en-GB" });
    await s.prefs.watch(httpsProfile);
    expect(s.prefs.locale(httpsProfile)).toBe("en");
    await s.prefs.setLocale(undefined, "zh");
    expect(s.prefs.locale(httpsProfile)).toBe("zh");
  });
});

describe("seeding a new profile", () => {
  test("the app's choices become the partition's cookies", async () => {
    const s = setup({ file: '{"theme":"light","locale":"en"}' });
    await s.prefs.seed(httpsProfile);
    expect(
      [...s.jar("p1").cookies.values()].map((c) => ({
        name: c.name,
        value: c.value,
        path: c.path,
        sameSite: c.sameSite,
        secure: c.secure,
        httpOnly: c.httpOnly,
      })),
    ).toEqual([
      {
        name: "cb-theme",
        value: "light",
        path: "/",
        sameSite: "lax",
        secure: true,
        httpOnly: false,
      },
      {
        name: "NEXT_LOCALE",
        value: "en",
        path: "/",
        sameSite: "lax",
        secure: true,
        httpOnly: false,
      },
    ]);
  });

  test("no choice, nothing written; a cookie already there stays unless overwritten", async () => {
    const none = setup();
    await none.prefs.seed(httpsProfile);
    expect(none.jar("p1").set).not.toHaveBeenCalled();

    const s = setup({ file: '{"theme":"light"}' });
    s.jar("p1").webWrites("https://capybara.example.com/", "cb-theme", "dark");
    await s.prefs.seed(httpsProfile);
    expect(await s.prefs.readTheme(httpsProfile)).toBe("dark");
    await s.prefs.seed(httpsProfile, { overwrite: true });
    expect(await s.prefs.readTheme(httpsProfile)).toBe("light");
  });
});

describe("the menus' language (spec 12)", () => {
  test("the current profile's once one exists, else the app's choice, else the OS", async () => {
    const s = setup({ osLocale: "zh-TW" });
    expect(s.prefs.menuLocale(undefined, [])).toBe("zh");
    await s.prefs.setLocale(undefined, "en");
    expect(s.prefs.menuLocale(undefined, [])).toBe("en");
    await s.prefs.watch(httpsProfile);
    await s.prefs.watch(httpProfile);
    await s.prefs.setLocale(httpsProfile, "zh");
    await s.prefs.setLocale(httpProfile, "en");
    // The last used profile, else the first one.
    expect(s.prefs.menuLocale(httpsProfile, [httpProfile, httpsProfile])).toBe("zh");
    expect(s.prefs.menuLocale(undefined, [httpsProfile, httpProfile])).toBe("zh");
    expect(s.prefs.menuLocale(httpProfile, [httpsProfile, httpProfile])).toBe("en");
  });
});

describe("the local pages' prefs actions", () => {
  function actions(o: { profiles?: Profile[]; singleScheme?: boolean } = {}) {
    const pages = createLocalPages();
    const s = setup();
    const afterAppLevel = vi.fn();
    installPreferenceActions({
      localPages: pages,
      prefs: s.prefs,
      getProfile: (id) => (o.profiles ?? []).find((p) => p.id === id),
      appearanceOf: (profile) =>
        resolveAppearance(
          false,
          o.singleScheme ? { scheme: "dark", singleScheme: true } : profile?.appearance,
          s.prefs.theme(profile),
        ),
      afterAppLevel,
    });
    let nextId = 1;
    const page = (profileId?: string) => {
      const contents = { id: nextId++, send: vi.fn() };
      pages.register(contents, {
        kind: "onboarding",
        ...(profileId ? { profileId } : {}),
        state: () => ({
          page: "found",
          locale: s.prefs.locale(),
          appearance: resolveAppearance(false, undefined, s.prefs.theme()),
          controls: null,
          os: "macos",
          appName: "Capybara",
          version: "0.1.0",
        }),
      });
      return (action: string, args: Record<string, unknown>) =>
        pages.handleAct(
          { sender: contents, senderFrame: { origin: LOCAL_ORIGIN, parent: null } },
          { action, args },
        );
    };
    return { pages, s, afterAppLevel, page };
  }

  test("an app-level page sets the app's choice and lets a provisional sign-in follow", async () => {
    const a = actions();
    const act = a.page();
    expect(await act("prefs.setTheme", { theme: "light" })).toEqual({ ok: true, value: true });
    expect(await act("prefs.setLocale", { locale: "en" })).toEqual({ ok: true, value: true });
    expect(a.s.prefs.app()).toEqual({ theme: "light", locale: "en" });
    expect(a.afterAppLevel).toHaveBeenCalledTimes(2);
  });

  test("a profile's page writes that profile's cookies", async () => {
    const a = actions({ profiles: [httpsProfile] });
    const act = a.page("p1");
    expect(await act("prefs.setTheme", { theme: "dark" })).toEqual({ ok: true, value: true });
    expect(await a.s.prefs.readTheme(httpsProfile)).toBe("dark");
    expect(a.s.prefs.app()).toEqual({});
    expect(a.afterAppLevel).not.toHaveBeenCalled();
  });

  test("values outside the sets never reach a handler", async () => {
    const a = actions({ profiles: [httpsProfile] });
    const act = a.page("p1");
    expect(await act("prefs.setTheme", { theme: "blue" })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await act("prefs.setLocale", { locale: "fr" })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(a.s.jar("p1").set).not.toHaveBeenCalled();
  });

  test("a page whose profile is gone is refused", async () => {
    const a = actions({ profiles: [] });
    const act = a.page("gone");
    expect(await act("prefs.setLocale", { locale: "en" })).toEqual({ ok: true, value: false });
    expect(a.s.prefs.app()).toEqual({});
  });

  test("under a single-scheme theme the toggle is hidden in the state and refused", async () => {
    const report = { scheme: "dark" as const, singleScheme: true as const };
    // The state a page receives: singleScheme set, so the preference bar leaves the toggle out.
    expect(resolveAppearance(false, report, "light")).toEqual(report);
    const a = actions({ profiles: [httpsProfile], singleScheme: true });
    const act = a.page("p1");
    expect(await act("prefs.setTheme", { theme: "light" })).toEqual({ ok: true, value: false });
    expect(a.s.jar("p1").set).not.toHaveBeenCalled();
    // The language still changes.
    expect(await act("prefs.setLocale", { locale: "en" })).toEqual({ ok: true, value: true });
  });
});

describe("review fixes", () => {
  test("a removed profile keeps no cache entry and reports nothing after a change event", async () => {
    const s = setup();
    await s.prefs.watch(httpsProfile);
    await s.prefs.setLocale(httpsProfile, "zh");
    s.onChange.mockClear();
    s.prefs.forget("p1");
    // The partition's clearing during removal raises change events.
    s.jar("p1").cookies.clear();
    s.jar("p1").emit("NEXT_LOCALE");
    await settle();
    expect(s.onChange).not.toHaveBeenCalled();
    expect(s.prefs.locale(httpsProfile)).toBe("en");
    // A write that finishes after the removal puts nothing back either.
    await s.prefs.setTheme(httpsProfile, "dark");
    expect(s.prefs.theme(httpsProfile)).toBeUndefined();
    expect(s.onChange).not.toHaveBeenCalled();
  });

  test("only the newest load writes the cache", async () => {
    const s = setup();
    await s.prefs.watch(httpsProfile);
    const jar = s.jar("p1");
    // The first load is held at its first read; a second one starts and finishes.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const original = jar.get.getMockImplementation();
    jar.get.mockImplementationOnce(async (f) => {
      const result = await (original as NonNullable<typeof original>)(f);
      await held;
      return result;
    });
    const first = s.prefs.watch(httpsProfile);
    jar.webWrites("https://capybara.example.com/", "cb-theme", "light");
    await settle();
    expect(s.prefs.theme(httpsProfile)).toBe("light");
    release();
    await first;
    // The older load read no cookie; it does not undo the newer value.
    expect(s.prefs.theme(httpsProfile)).toBe("light");
  });

  test("a setter during a load for the other preference leaves both fields current", async () => {
    const s = setup();
    await s.prefs.watch(httpsProfile);
    const jar = s.jar("p1");
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const original = jar.get.getMockImplementation();
    // The web toggles the language; the load it starts is held after its (stale) theme read.
    jar.get.mockImplementationOnce(async (f) => {
      const result = await (original as NonNullable<typeof original>)(f);
      await held;
      return result;
    });
    jar.webWrites("https://capybara.example.com/", "NEXT_LOCALE", "zh");
    await settle();
    await s.prefs.setTheme(httpsProfile, "dark");
    release();
    await settle();
    expect(s.prefs.theme(httpsProfile)).toBe("dark");
    expect(s.prefs.locale(httpsProfile)).toBe("zh");
  });

  test("seeds of one profile run one after another", async () => {
    const s = setup({ file: '{"theme":"light"}' });
    const jar = s.jar("p1");
    const order: string[] = [];
    jar.set.mockImplementation(async (d: CookieDetails) => {
      order.push(`set ${d.value}`);
      jar.cookies.set(`${d.url} ${d.name}`, d);
    });
    const first = s.prefs.seed(httpsProfile, { overwrite: true });
    await s.prefs.setTheme(undefined, "dark");
    const second = s.prefs.seed(httpsProfile, { overwrite: true });
    await Promise.all([first, second]);
    // The later seed's value is the last one written, whatever the timing.
    expect(order.at(-1)).toBe("set dark");
    expect(await s.prefs.readTheme(httpsProfile)).toBe("dark");
  });

  test("the host-only cookie wins over a parent domain's", async () => {
    const s = setup();
    const jar = s.jar("p1");
    jar.parent.push({ name: "cb-theme", value: "dark", domain: ".example.com", hostOnly: false });
    expect(await s.prefs.readTheme(httpsProfile)).toBe("dark");
    jar.webWrites("https://capybara.example.com/", "cb-theme", "light");
    expect(await s.prefs.readTheme(httpsProfile)).toBe("light");
  });

  test("menuLocale: a last-used profile that is not offered gives way to the offered one", async () => {
    const s = setup();
    await s.prefs.watch(httpsProfile);
    await s.prefs.watch(httpProfile);
    await s.prefs.setLocale(httpsProfile, "zh");
    await s.prefs.setLocale(httpProfile, "en");
    expect(s.prefs.menuLocale(httpsProfile, [httpProfile])).toBe("en");
  });

  test("an app-level choice reaches only the matching provisional profile", () => {
    const begun = { id: "prov", origin: "https://a.example.com" };
    expect(provisionalToFollow({ provisional: true, profileId: "prov" }, begun)).toBe(begun);
    expect(provisionalToFollow({ provisional: true, profileId: "other" }, begun)).toBeUndefined();
    expect(provisionalToFollow({ provisional: false, profileId: "prov" }, begun)).toBeUndefined();
    expect(provisionalToFollow(undefined, begun)).toBeUndefined();
    expect(
      provisionalToFollow({ provisional: true, profileId: "prov" }, undefined),
    ).toBeUndefined();
  });
});
