import { describe, expect, test, vi } from "vitest";
import type { MainErrorState } from "../src/local/main-error-model.ts";
import type { LocalActHandler } from "../src/main/local-pages.ts";
import type { Overlay, OverlayOptions } from "../src/main/overlay.ts";
import type { Profile } from "../src/main/profiles.ts";
import {
  createSessionWatch,
  PROBE_FAST_MS,
  PROBE_SLOW_MS,
  probeDelay,
  probeMeta,
  returnUrlFor,
  type SessionWatchDeps,
  type SessionWindow,
} from "../src/main/session-watch.ts";
import type { SignInOutcome } from "../src/main/sign-in.ts";
import { createSignOut } from "../src/main/sign-out.ts";

const BASE = "https://a.example.com/team";
const LOGIN = `${BASE}/login`;

const initialProfile = (): Profile => ({
  id: "p1",
  base: BASE,
  origin: "https://a.example.com",
  name: "A",
  signedIn: true,
  account: { name: "Ann", login: "ann@example.com" },
});

type Listener = (...args: unknown[]) => void;

function emitter() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(event: string, l: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), l]);
      return this;
    },
    removeListener(event: string, l: Listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((x) => x !== l),
      );
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners.get(event) ?? []) l(...args);
    },
  };
}

function fakeWindow() {
  const em = emitter();
  const wc = { ...emitter(), focus: vi.fn() };
  const win = {
    ...em,
    webContents: wc,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentSize: () => [1280, 800],
    isDestroyed: () => false,
    isFullScreen: () => false,
    loadURL: vi.fn(async (_url: string) => undefined),
  };
  return win;
}

let nextContentsId = 1000;

interface FakeOverlay extends Overlay {
  options: OverlayOptions;
  state(): MainErrorState;
}

function setup(over: Partial<SessionWatchDeps> = {}) {
  let profile: Profile | undefined = initialProfile();
  let clock = 1_000_000;
  const overlays: FakeOverlay[] = [];
  const handlers = new Map<string, LocalActHandler>();
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const outcomes: ((o: SignInOutcome) => void)[] = [];
  const probes: ((up: boolean) => void)[] = [];
  const signOut = {
    takeLoggedOut: vi.fn((_id: string) => false),
    noteLogin: vi.fn(),
    complete: vi.fn(async (_id: string) => undefined),
    confirmAndSignOut: vi.fn(async (_id: string) => undefined),
  };
  const signIn = {
    begin: vi.fn((_p: Profile) => ({
      url: `https://a.example.com/apps/authorize?n=${outcomes.length}`,
      outcome: new Promise<SignInOutcome>((resolve) => outcomes.push(resolve)),
    })),
    pendingUrl: vi.fn((_id: string) => "https://a.example.com/apps/authorize?pending"),
    cancel: vi.fn(),
  };
  const deps: SessionWatchDeps = {
    showOverlay: (_parent, options) => {
      let removed = false;
      const o: FakeOverlay = {
        contents: {
          id: nextContentsId++,
          send: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          isDestroyed: () => removed,
          close: vi.fn(),
          focus: vi.fn(),
        },
        push: vi.fn(),
        remove: vi.fn(() => {
          removed = true;
        }),
        isRemoved: () => removed,
        options,
        state: () => options.state() as MainErrorState,
      };
      overlays.push(o);
      return o;
    },
    localPages: {
      handle: ((_kind: string, action: string, handler: LocalActHandler) => {
        handlers.set(action, handler);
        return () => handlers.delete(action);
      }) as SessionWatchDeps["localPages"]["handle"],
    },
    getProfile: (id) => (id === profile?.id ? profile : undefined),
    signOut,
    signIn,
    openExternal: vi.fn(async (_url: string) => undefined),
    markSignedIn: vi.fn((id: string, account: { name: string; login: string }) => {
      if (!profile || profile.id !== id) return undefined;
      profile = { ...profile, signedIn: true, account };
      return profile;
    }),
    popupPlatformMenu: vi.fn(),
    probe: vi.fn(() => new Promise<boolean>((resolve) => probes.push(resolve))),
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    now: () => clock,
    pageBase: () => ({
      locale: "zh",
      appearance: { scheme: "dark" },
      os: "macos",
      appName: "Capybara",
      version: "1.0.0",
    }),
    platformOf: (p) => ({ name: p.name, host: new URL(p.origin).host }),
    controls: () => null,
    background: () => "#0a0a0a",
    ...over,
  };
  const watch = createSessionWatch(deps);
  const win = fakeWindow();
  watch.watch(initialProfile(), win as unknown as SessionWindow);
  const live = () => timers.filter((t) => !t.cancelled);
  return {
    deps,
    watch,
    win,
    signOut,
    signIn,
    overlays,
    timers,
    outcomes,
    probes,
    /** The overlay showing now, if any. */
    shown: () => overlays.find((o) => !o.isRemoved()),
    act: async (overlay: Overlay, action: string) =>
      handlers.get(action)?.({ contents: overlay.contents, kind: "main-error" }, {}),
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    /** Fires the next live timer (after moving the clock by its delay). */
    fireTimer: () => {
      const t = live()[0];
      if (!t) throw new Error("no timer");
      t.cancelled = true;
      clock += t.ms;
      t.run();
      return t.ms;
    },
    live,
    signOutProfile: () => {
      if (profile) profile = { ...profile, signedIn: false };
    },
  };
}

const navEvent = () => ({ preventDefault: vi.fn() });

describe("returnUrlFor", () => {
  const p = initialProfile();
  test("the returnTo of the login URL when it is a path on the deployment", () => {
    expect(returnUrlFor(p, `${LOGIN}?returnTo=%2Fteam%2Fchat%2F42%3Fx%3D1`, undefined)).toBe(
      `${BASE}/chat/42?x=1`,
    );
  });

  test("never another origin, a protocol-relative path, the login page or outside the base", () => {
    const last = `${BASE}/agents`;
    for (const rt of [
      "https://evil.example.com/team/x",
      "//evil.example.com/team/x",
      "/\\evil.example.com/team/x",
      "/team/login",
      "/elsewhere",
      "team/chat",
    ]) {
      expect(returnUrlFor(p, `${LOGIN}?returnTo=${encodeURIComponent(rt)}`, last)).toBe(last);
    }
  });

  test("else the last page, else the base", () => {
    expect(returnUrlFor(p, LOGIN, `${BASE}/agents`)).toBe(`${BASE}/agents`);
    expect(returnUrlFor(p, LOGIN, undefined)).toBe(`${BASE}/`);
    expect(returnUrlFor(p, LOGIN, "https://b.example.com/x")).toBe(`${BASE}/`);
  });
});

describe("the /login decision", () => {
  test("after a logout: the end of a sign-out, the navigation stopped, no overlay", () => {
    const h = setup();
    h.signOut.takeLoggedOut.mockReturnValue(true);
    const e = navEvent();
    h.win.webContents.emit("will-navigate", e, LOGIN);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(h.signOut.complete).toHaveBeenCalledWith("p1");
    expect(h.signOut.noteLogin).not.toHaveBeenCalled();
    expect(h.overlays).toHaveLength(0);
    // Reported again (did-navigate): decided once.
    h.win.webContents.emit("did-navigate", {}, LOGIN, 200);
    expect(h.signOut.complete).toHaveBeenCalledTimes(1);
    expect(h.overlays).toHaveLength(0);
  });

  test("without a logout: noted for the sign-out, stopped, the expired page", () => {
    const h = setup();
    const e = navEvent();
    h.win.webContents.emit("will-redirect", e, LOGIN, false, true);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(h.signOut.noteLogin).toHaveBeenCalledWith("p1");
    expect(h.signOut.complete).not.toHaveBeenCalled();
    expect(h.shown()?.state()).toMatchObject({
      page: "expired",
      error: null,
      waiting: false,
      platform: { name: "A", host: "a.example.com" },
    });
    expect(h.watch.showsExpired("p1")).toBe(true);
    // The same navigation reported again: still one overlay.
    h.win.webContents.emit("did-navigate", {}, LOGIN, 200);
    expect(h.overlays).toHaveLength(1);
  });

  test("a client navigation (did-navigate-in-page) shows the expired page too", () => {
    const h = setup();
    h.win.webContents.emit("did-navigate-in-page", {}, `${LOGIN}?returnTo=%2Fteam%2Fx`, true);
    expect(h.shown()?.state().page).toBe("expired");
  });

  test("another origin's /login is ignored", () => {
    const h = setup();
    const e = navEvent();
    h.win.webContents.emit("will-navigate", e, "https://b.example.com/team/login");
    h.win.webContents.emit("did-navigate", {}, "https://a.example.com/login", 200);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(h.signOut.noteLogin).not.toHaveBeenCalled();
    expect(h.overlays).toHaveLength(0);
  });

  test("a profile signed out already decides nothing", () => {
    const h = setup();
    h.signOutProfile();
    h.win.webContents.emit("will-navigate", navEvent(), LOGIN);
    expect(h.signOut.takeLoggedOut).not.toHaveBeenCalled();
    expect(h.overlays).toHaveLength(0);
  });
});

describe("re-sign-in from the expired page", () => {
  async function expired(returnTo?: string) {
    const h = setup();
    h.win.webContents.emit("did-navigate", {}, `${BASE}/agents`, 200);
    const url = returnTo ? `${LOGIN}?returnTo=${encodeURIComponent(returnTo)}` : LOGIN;
    h.win.webContents.emit("will-navigate", navEvent(), url);
    const overlay = h.shown() as FakeOverlay;
    await h.act(overlay, "mainError.signIn");
    return { h, overlay };
  }

  test("ok: signed in with the account, overlay removed, the returnTo loaded", async () => {
    const { h, overlay } = await expired("/team/chat/7");
    expect(h.signIn.begin).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.deps.openExternal).toHaveBeenCalledTimes(1));
    expect(overlay.state().waiting).toBe(true);
    h.outcomes[0]?.({ ok: true, account: { name: "Ann", login: "ann@example.com" } });
    await vi.waitFor(() => expect(overlay.isRemoved()).toBe(true));
    expect(h.deps.markSignedIn).toHaveBeenCalledWith("p1", {
      name: "Ann",
      login: "ann@example.com",
    });
    expect(h.win.loadURL).toHaveBeenCalledWith(`${BASE}/chat/7`);
    expect(h.watch.showsExpired("p1")).toBe(false);
  });

  test("without returnTo: the last page the window showed", async () => {
    const { h, overlay } = await expired();
    h.outcomes[0]?.({ ok: true, account: { name: "Ann", login: "ann@example.com" } });
    await vi.waitFor(() => expect(overlay.isRemoved()).toBe(true));
    expect(h.win.loadURL).toHaveBeenCalledWith(`${BASE}/agents`);
  });

  test("another account: back to the home page", async () => {
    const { h, overlay } = await expired("/team/chat/7");
    h.outcomes[0]?.({ ok: true, account: { name: "Bob", login: "bob@example.com" } });
    await vi.waitFor(() => expect(overlay.isRemoved()).toBe(true));
    expect(h.win.loadURL).toHaveBeenCalledWith(`${BASE}/`);
  });

  test("while waiting the button reopens the same URL (no new attempt)", async () => {
    const { h, overlay } = await expired();
    await h.act(overlay, "mainError.signIn");
    expect(h.signIn.begin).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(h.deps.openExternal).toHaveBeenLastCalledWith(
        "https://a.example.com/apps/authorize?pending",
      ),
    );
  });

  test("a failure shows inline and the overlay stays", async () => {
    const { h, overlay } = await expired();
    h.outcomes[0]?.({ ok: false, reason: "account_unusable" });
    await vi.waitFor(() => expect(overlay.state().error).toBe("account_unusable"));
    expect(overlay.state().waiting).toBe(false);
    expect(overlay.isRemoved()).toBe(false);
    expect(h.win.loadURL).not.toHaveBeenCalled();
    // 重新登录 starts a new attempt and clears the error.
    await h.act(overlay, "mainError.signIn");
    expect(h.signIn.begin).toHaveBeenCalledTimes(2);
    expect(overlay.state().error).toBeNull();
  });

  test("the browser does not open: the attempt is cancelled, link invalid shown", async () => {
    const h = setup({
      openExternal: vi.fn(async () => {
        throw new Error("no browser");
      }),
    });
    h.win.webContents.emit("will-navigate", navEvent(), LOGIN);
    const overlay = h.shown() as FakeOverlay;
    await h.act(overlay, "mainError.signIn");
    await vi.waitFor(() => expect(overlay.state().error).toBe("link_invalid"));
    expect(h.signIn.cancel).toHaveBeenCalledWith("p1");
  });

  test("退出登录 completes the sign-out without asking and cancels a pending attempt", async () => {
    const { h, overlay } = await expired();
    await h.act(overlay, "mainError.signOut");
    expect(h.signIn.cancel).toHaveBeenCalledWith("p1");
    expect(h.signOut.complete).toHaveBeenCalledWith("p1");
    expect(h.signOut.confirmAndSignOut).not.toHaveBeenCalled();
  });

  test("切换平台 pops the platform menu up over the window", async () => {
    const { h, overlay } = await expired();
    await h.act(overlay, "mainError.switchPlatform");
    expect(h.deps.popupPlatformMenu).toHaveBeenCalledWith(h.win);
  });

  test("an action from anything but the window's overlay is refused", async () => {
    const h = setup();
    h.win.webContents.emit("will-navigate", navEvent(), LOGIN);
    const stranger = { ...(h.shown() as FakeOverlay), contents: { id: 1, send: vi.fn() } };
    expect(await h.act(stranger as unknown as Overlay, "mainError.signIn")).toBe(false);
    expect(h.signIn.begin).not.toHaveBeenCalled();
  });
});

describe("with the real sign-out: a logout completion after the expired page", () => {
  test("ends the sign-out at once, however late (the window counts as on /login)", async () => {
    let watchRef: { showsExpired(id: string): boolean } | undefined;
    let stored: Profile | undefined = initialProfile();
    const showSignedOut = vi.fn();
    const signOut = createSignOut({
      getProfile: () => stored,
      markSignedOut: () => {
        stored = stored && { ...stored, signedIn: false };
        return stored;
      },
      showSignedOut,
      closeProfileWindows: vi.fn(),
      showsLogin: (id) => watchRef?.showsExpired(id) === true,
      confirm: async () => true,
      fetchFor: () => vi.fn(),
      clearSessionCookies: async () => undefined,
    });
    const h = setup({ signOut, getProfile: () => stored });
    watchRef = h.watch;
    h.win.webContents.emit("will-navigate", navEvent(), LOGIN);
    expect(h.watch.showsExpired("p1")).toBe(true);
    // Long after the 5 s pairing window of a bare /login.
    h.advance(60_000);
    signOut.noteLoggedOut("p1");
    await vi.waitFor(() => expect(showSignedOut).toHaveBeenCalledTimes(1));
  });
});

describe("the unreachable page", () => {
  test("probe backoff: every 5 s for a minute, then every 30 s", () => {
    expect(probeDelay(0)).toBe(PROBE_FAST_MS);
    expect(probeDelay(59_999)).toBe(PROBE_FAST_MS);
    expect(probeDelay(60_000)).toBe(PROBE_SLOW_MS);
  });

  test("a main-frame network failure shows it; probes back off; 2xx reloads the failed URL", async () => {
    const h = setup();
    h.win.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", `${BASE}/c/1`, true);
    const overlay = h.shown() as FakeOverlay;
    expect(overlay.state()).toMatchObject({ page: "unreachable", probing: false });
    expect(overlay.state().downSince).toBe(h.now());
    const delays: number[] = [];
    // Thirteen failed probes: 12 × 5 s reach the minute, then 30 s.
    for (let i = 0; i < 13; i++) {
      delays.push(h.fireTimer());
      expect(overlay.state().probing).toBe(true);
      h.probes.shift()?.(false);
      await vi.waitFor(() => expect(h.live()).toHaveLength(1));
    }
    expect(delays.slice(0, 12)).toEqual(Array(12).fill(PROBE_FAST_MS));
    expect(delays[12]).toBe(PROBE_SLOW_MS);
    expect(h.live()[0]?.ms).toBe(PROBE_SLOW_MS);
    // The platform answers: the overlay goes and the failed page loads again.
    h.fireTimer();
    h.probes.shift()?.(true);
    await vi.waitFor(() => expect(overlay.isRemoved()).toBe(true));
    expect(h.win.loadURL).toHaveBeenCalledWith(`${BASE}/c/1`);
    expect(h.live()).toHaveLength(0);
  });

  test("502 / 503 / 504 main documents show it; other codes do not", () => {
    for (const code of [502, 503, 504]) {
      const h = setup();
      h.win.webContents.emit("did-navigate", {}, `${BASE}/`, code);
      expect(h.shown()?.state().page).toBe("unreachable");
    }
    const h = setup();
    h.win.webContents.emit("did-navigate", {}, `${BASE}/`, 500);
    h.win.webContents.emit("did-navigate", {}, `${BASE}/`, 404);
    expect(h.overlays).toHaveLength(0);
  });

  test("aborts, subframes and other origins are ignored", () => {
    const h = setup();
    h.win.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", `${BASE}/`, true);
    h.win.webContents.emit("did-fail-load", {}, -105, "x", `${BASE}/frame`, false);
    h.win.webContents.emit("did-fail-load", {}, -105, "x", "https://b.example.com/", true);
    h.win.webContents.emit("did-navigate", {}, "https://b.example.com/", 503);
    expect(h.overlays).toHaveLength(0);
  });

  test("重试 probes now, one probe at a time", async () => {
    const h = setup();
    h.win.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", `${BASE}/`, true);
    const overlay = h.shown() as FakeOverlay;
    await h.act(overlay, "mainError.retry");
    expect(h.deps.probe).toHaveBeenCalledTimes(1);
    // The scheduled probe was cancelled while this one runs; a second 重试 waits for it.
    expect(h.live()).toHaveLength(0);
    await h.act(overlay, "mainError.retry");
    expect(h.deps.probe).toHaveBeenCalledTimes(1);
    h.probes.shift()?.(false);
    await vi.waitFor(() => expect(h.live()).toHaveLength(1));
    expect(overlay.state().probing).toBe(false);
  });

  test("the elapsed time grows in the state", () => {
    const h = setup();
    h.win.webContents.emit("did-fail-load", {}, -105, "x", `${BASE}/`, true);
    const overlay = h.shown() as FakeOverlay;
    const since = overlay.state().downSince as number;
    h.advance(5 * 60_000);
    expect(overlay.state().now - since).toBe(5 * 60_000);
  });

  test("closing the window stops probing and removes the overlay", () => {
    const h = setup();
    h.win.webContents.emit("did-fail-load", {}, -105, "x", `${BASE}/`, true);
    expect(h.live()).toHaveLength(1);
    h.win.emit("closed");
    expect(h.live()).toHaveLength(0);
    expect(h.shown()).toBeUndefined();
  });

  test("退出登录 there asks first (the session may be alive)", async () => {
    const h = setup();
    h.win.webContents.emit("did-fail-load", {}, -105, "x", `${BASE}/`, true);
    await h.act(h.shown() as FakeOverlay, "mainError.signOut");
    expect(h.signOut.confirmAndSignOut).toHaveBeenCalledWith("p1");
    expect(h.signOut.complete).not.toHaveBeenCalled();
  });

  test("the expired page takes over from the unreachable one and stops probing", () => {
    const h = setup();
    h.win.webContents.emit("did-fail-load", {}, -105, "x", `${BASE}/`, true);
    const overlay = h.shown() as FakeOverlay;
    h.win.webContents.emit("will-redirect", navEvent(), LOGIN, false, true);
    expect(h.live()).toHaveLength(0);
    expect(overlay.state().page).toBe("expired");
    // A load failure while expired does not switch back.
    h.win.webContents.emit("did-fail-load", {}, -105, "x", `${BASE}/`, true);
    expect(overlay.state().page).toBe("expired");
    expect(h.overlays).toHaveLength(1);
  });
});

describe("probeMeta", () => {
  test("2xx is up; anything else or a network error is down", async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200 }));
    expect(await probeMeta(ok as never, BASE)).toBe(true);
    expect(ok).toHaveBeenCalledWith(
      `${BASE}/api/v1/meta`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(await probeMeta((async () => ({ ok: false, status: 503 })) as never, BASE)).toBe(false);
    expect(
      await probeMeta(
        (async () => {
          throw new Error("ECONNREFUSED");
        }) as never,
        BASE,
      ),
    ).toBe(false);
  });
});
