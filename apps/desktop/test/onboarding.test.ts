import type { DiscoveryResult, Meta } from "@capybara-hq/shell";
import { describe, expect, test, vi } from "vitest";
import type { OnboardingState } from "../src/local/onboarding-model.ts";
import { createLocalPages } from "../src/main/local-pages.ts";
import { localeFrom } from "../src/main/locale.ts";
import { createOnboarding, type OnboardingDeps, platformName } from "../src/main/onboarding.ts";
import type { Profile } from "../src/main/profiles.ts";
import type { SignInOutcome } from "../src/main/sign-in.ts";
import { LOCAL_ORIGIN } from "../src/shared/protocol.ts";

const META: Meta = {
  name: "Meta1 智能体平台",
  icon: "/api/v1/platform/icon/app?v=abc",
  protocols: { device: { min: 3, max: 3 } },
  features: { localDevices: true, appSignIn: true },
  appRedirectUris: ["capybara://auth/callback"],
};
const ICON = "data:image/png;base64,iVBORw0KGgo=";
const ACCOUNT = { name: "Grant", login: "grant@meta1.top" };

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeWindow(id: number) {
  const closed: Array<() => void> = [];
  let destroyed = false;
  const destroyedListeners: Array<() => void> = [];
  const win = {
    webContents: {
      id,
      send: vi.fn(),
      isDestroyed: () => destroyed,
      once: (_e: "destroyed", l: () => void) => destroyedListeners.push(l),
    },
    on: (_e: "closed", l: () => void) => closed.push(l),
    close: vi.fn(() => {
      destroyed = true;
      for (const l of closed) l();
    }),
    isDestroyed: () => destroyed,
    setBackgroundColor: vi.fn(),
    setTitleBarOverlay: vi.fn(),
  };
  return win;
}

/** A sign-in module whose outcomes the test settles. */
function fakeSignIn() {
  const attempts: Array<{
    profile: Profile;
    url: string;
    settle: (o: SignInOutcome) => void;
    live: boolean;
  }> = [];
  let stale: ((origin: string) => void) | undefined;
  const signIn = {
    begin: vi.fn((profile: Profile) => {
      for (const a of attempts)
        if (a.profile.id === profile.id && a.live) a.settle({ ok: false, reason: "cancelled" });
      const d = deferred<SignInOutcome>();
      const url = `${profile.base}/apps/authorize?state=s${attempts.length + 1}`;
      const attempt = {
        profile,
        url,
        live: true,
        settle: (o: SignInOutcome) => {
          if (!attempt.live) return;
          attempt.live = false;
          d.resolve(o);
        },
      };
      attempts.push(attempt);
      return { url, outcome: d.promise };
    }),
    pendingUrl: vi.fn((id: string) => attempts.find((a) => a.profile.id === id && a.live)?.url),
    cancel: vi.fn((id: string) => {
      for (const a of attempts)
        if (a.profile.id === id) a.settle({ ok: false, reason: "cancelled" });
    }),
    quiesce: vi.fn(async () => undefined),
    onStaleCallback: vi.fn((l: (origin: string) => void) => {
      stale = l;
      return () => undefined;
    }),
  };
  return { signIn, attempts, stale: (origin: string) => stale?.(origin) };
}

function setup(extra: Partial<OnboardingDeps> = {}) {
  const localPages = createLocalPages();
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const sign = fakeSignIn();
  const saved: Profile[] = [];
  const order: string[] = [];
  let ids = 0;
  const deps: OnboardingDeps = {
    localPages,
    openWindow: vi.fn(() => {
      const open = windows.find((w) => !w.isDestroyed());
      if (open) return open;
      const w = fakeWindow(100 + windows.length);
      windows.push(w);
      return w;
    }),
    pageBase: () => ({
      locale: "zh",
      appearance: { scheme: "dark" },
      os: "macos",
      appName: "Capybara",
      version: "0.1.0",
    }),
    controls: { x: 0, y: 0, width: 80, height: 28 },
    colors: () => ({ background: "#0A0A0A", symbol: "#8E8E89" }),
    discover: vi.fn(
      async (base: string): Promise<DiscoveryResult> => ({ ok: true, base, meta: META }),
    ),
    platformIcon: vi.fn(async () => ({ iconUrl: ICON, iconHash: "abc" })),
    storedIcon: () => undefined,
    isAllowed: () => true,
    findProfile: (base) => saved.find((p) => p.base === base),
    newId: () => `new${++ids}`,
    signIn: sign.signIn,
    redirectUri: "capybara://auth/callback",
    openExternal: vi.fn(async () => undefined),
    writeClipboard: vi.fn(),
    saveProfile: vi.fn((p: Profile, account) => {
      const profile = { ...p, signedIn: true, account };
      saved.push(profile);
      return profile;
    }),
    markSignedIn: vi.fn((id: string, account) => {
      const p = saved.find((q) => q.id === id);
      return p && { ...p, signedIn: true, account };
    }),
    openMain: vi.fn(),
    clearPartition: vi.fn(async (id: string) => {
      order.push(`clear:${id}`);
    }),
    removeProfile: vi.fn(),
    canRemove: () => true,
    machineName: "MacBook-Pro",
    ...extra,
  };
  (deps.signIn.quiesce as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
    order.push(`quiesce:${id}`);
  });
  const host = createOnboarding(deps);
  const win = () => windows.at(-1) as ReturnType<typeof fakeWindow>;
  const event = (sender: unknown = win().webContents) =>
    ({ sender, senderFrame: { origin: LOCAL_ORIGIN, parent: null } }) as Parameters<
      typeof localPages.handleAct
    >[0];
  const act = async (action: string, args?: Record<string, unknown>) => {
    const r = await localPages.handleAct(event(), { action, ...(args ? { args } : {}) });
    await flush();
    return r;
  };
  const state = () => localPages.handleState(event()) as OnboardingState;
  return { host, deps, localPages, windows, win, sign, saved, order, act, state, event };
}

async function toFound(h: ReturnType<typeof setup>, address = "capybara.meta1.top") {
  h.host.openConnect();
  await h.act("connect.submit", { address });
}

async function toWaiting(h: ReturnType<typeof setup>) {
  await toFound(h);
  await h.act("found.signIn");
}

describe("connect", () => {
  test("a first launch shows the connect page, app level, with the window controls", () => {
    const h = setup();
    h.host.openConnect();
    expect(h.windows).toHaveLength(1);
    expect(h.state()).toMatchObject({
      page: "connect",
      address: "",
      error: null,
      busy: false,
      controls: { x: 0, y: 0, width: 80, height: 28 },
      appName: "Capybara",
      version: "0.1.0",
    });
    expect(h.localPages.entries()[0]?.profileId).toBeUndefined();
  });

  test("errors before any request: invalid, not https, refused by the managed lock", async () => {
    const h = setup({ isAllowed: (a) => !a.includes("blocked") });
    h.host.openConnect();
    await h.act("connect.submit", { address: "https://" });
    expect(h.state()).toMatchObject({ page: "connect", error: "invalid" });
    await h.act("connect.submit", { address: "http://10.0.0.5:3000" });
    expect(h.state()).toMatchObject({ error: "not_https", errorHost: "10.0.0.5:3000" });
    await h.act("connect.submit", { address: "blocked.example.com" });
    expect(h.state()).toMatchObject({ error: "locked", address: "blocked.example.com" });
    expect(h.deps.discover).not.toHaveBeenCalled();
  });

  test("busy while discovery runs; its verdict names the host", async () => {
    const d = deferred<DiscoveryResult>();
    const h = setup({ discover: vi.fn(() => d.promise) });
    h.host.openConnect();
    void h.localPages.handleAct(h.event(), {
      action: "connect.submit",
      args: { address: "capybara.meta1.tpo" },
    });
    await flush();
    expect(h.state()).toMatchObject({ busy: true, error: null });
    expect(h.deps.discover).toHaveBeenCalledWith("https://capybara.meta1.tpo", expect.anything());
    d.resolve({ ok: false, error: "unreachable" });
    await flush();
    expect(h.state()).toMatchObject({
      page: "connect",
      busy: false,
      error: "unreachable",
      errorHost: "capybara.meta1.tpo",
    });
  });

  test("a later submit supersedes an earlier one (whose discovery is aborted)", async () => {
    const first = deferred<DiscoveryResult>();
    const signals: AbortSignal[] = [];
    const h = setup({
      discover: vi.fn((base: string, signal: AbortSignal) => {
        signals.push(signal);
        return base.includes("first")
          ? first.promise
          : Promise.resolve({ ok: true as const, base, meta: META });
      }),
    });
    h.host.openConnect();
    void h.localPages.handleAct(h.event(), {
      action: "connect.submit",
      args: { address: "first.example.com" },
    });
    await flush();
    await h.act("connect.submit", { address: "second.example.com" });
    expect(signals[0]?.aborted).toBe(true);
    first.resolve({ ok: false, error: "unreachable" });
    await flush();
    expect(h.state()).toMatchObject({ page: "found", platform: { host: "second.example.com" } });
  });

  test("a prefill (deep link) replaces the field's text and bumps the prefill counter", () => {
    const h = setup();
    h.host.openConnect();
    const before = h.state().prefill;
    h.host.openConnect("new.example.com");
    expect(h.windows).toHaveLength(1);
    expect(h.state()).toMatchObject({ page: "connect", address: "new.example.com" });
    expect(h.state().prefill).toBe(before + 1);
    // Focusing it again without an address keeps the text.
    h.host.openConnect();
    expect(h.state()).toMatchObject({ address: "new.example.com", prefill: before + 1 });
  });
});

describe("found", () => {
  test("discovery → a provisional profile with the platform's name, host and icon", async () => {
    const h = setup();
    await toFound(h);
    expect(h.state()).toMatchObject({
      page: "found",
      error: null,
      platform: { name: "Meta1 智能体平台", host: "capybara.meta1.top", iconUrl: ICON },
    });
    expect(h.host.current()).toEqual({ page: "found", profileId: "new1", provisional: true });
    // A provisional profile is app level for the local page registry (nothing saved yet).
    expect(h.localPages.entries()[0]?.profileId).toBeUndefined();
    expect(h.deps.platformIcon).toHaveBeenCalledWith(
      { base: "https://capybara.meta1.top", origin: "https://capybara.meta1.top" },
      META.icon,
    );
  });

  test("without a name the host is the name", () => {
    expect(platformName({ name: null }, "a.example.com")).toBe("a.example.com");
    expect(platformName({ name: "  " }, "a.example.com")).toBe("a.example.com");
    expect(platformName({ name: " X " }, "a.example.com")).toBe("X");
  });

  test("换一个地址 goes back to connect keeping the address", async () => {
    const h = setup();
    await toFound(h);
    const prefill = h.state().prefill;
    await h.act("found.changeAddress");
    expect(h.state()).toMatchObject({ page: "connect", address: "capybara.meta1.top" });
    expect(h.state().prefill).toBe(prefill + 1);
    expect(h.state().platform).toBeUndefined();
    // No attempt was begun: the provisional partition was never used.
    expect(h.deps.clearPartition).not.toHaveBeenCalled();
  });

  test("a deployment saved and signed in already: its main window, nothing added", async () => {
    const h = setup();
    h.saved.push({
      id: "p1",
      base: "https://capybara.meta1.top",
      origin: "https://capybara.meta1.top",
      name: "M",
      signedIn: true,
    });
    await toFound(h);
    // Its open window comes forward as it is: no navigation to `/`.
    expect(h.deps.openMain).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), false);
    expect(h.win().close).toHaveBeenCalled();
    expect(h.deps.saveProfile).not.toHaveBeenCalled();
  });

  test("a deployment saved but signed out: found for that profile, marked signed in on success", async () => {
    const h = setup();
    h.saved.push({
      id: "p1",
      base: "https://capybara.meta1.top",
      origin: "https://capybara.meta1.top",
      name: "M",
      signedIn: false,
    });
    await toWaiting(h);
    expect(h.sign.signIn.begin).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
    expect(h.localPages.entries()[0]?.profileId).toBe("p1");
    h.sign.attempts[0]?.settle({ ok: true, account: ACCOUNT });
    await flush();
    expect(h.deps.markSignedIn).toHaveBeenCalledWith("p1", ACCOUNT);
    expect(h.deps.saveProfile).not.toHaveBeenCalled();
    expect(h.deps.openMain).toHaveBeenCalled();
  });

  test("app sign-in not allowed: the error without opening the browser", async () => {
    const h = setup({
      discover: vi.fn(async (base: string) => ({
        ok: true as const,
        base,
        meta: { ...META, appRedirectUris: ["other://cb"] },
      })),
    });
    await toFound(h);
    await h.act("found.signIn");
    expect(h.state()).toMatchObject({ page: "found", error: "not_allowed" });
    expect(h.sign.signIn.begin).not.toHaveBeenCalled();
    expect(h.deps.openExternal).not.toHaveBeenCalled();
  });
});

describe("waiting", () => {
  test("在浏览器中登录 begins the attempt and opens its URL in the system browser", async () => {
    const h = setup();
    await toWaiting(h);
    expect(h.state()).toMatchObject({ page: "waiting", machine: "MacBook-Pro" });
    expect(h.sign.signIn.begin).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new1", base: "https://capybara.meta1.top", signedIn: false }),
    );
    expect(h.deps.openExternal).toHaveBeenCalledWith(h.sign.attempts[0]?.url);
  });

  test("reopen opens the same URL again; copy writes it to the clipboard", async () => {
    const h = setup();
    await toWaiting(h);
    const url = h.sign.attempts[0]?.url;
    expect(await h.act("waiting.reopen")).toEqual({ ok: true, value: true });
    expect(h.deps.openExternal).toHaveBeenLastCalledWith(url);
    expect(h.deps.openExternal).toHaveBeenCalledTimes(2);
    expect(await h.act("waiting.copyLink")).toEqual({ ok: true, value: true });
    expect(h.deps.writeClipboard).toHaveBeenCalledWith(url);
    expect(h.sign.signIn.begin).toHaveBeenCalledTimes(1);
  });

  test("取消 ends the attempt and goes back to found without an error", async () => {
    const h = setup();
    await toWaiting(h);
    await h.act("waiting.cancel");
    expect(h.sign.signIn.cancel).toHaveBeenCalledWith("new1");
    expect(h.state()).toMatchObject({ page: "found", error: null });
  });

  test("success saves the provisional profile under its id and opens the main window", async () => {
    const h = setup();
    await toWaiting(h);
    h.sign.attempts[0]?.settle({ ok: true, account: ACCOUNT });
    await flush();
    expect(h.deps.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new1", base: "https://capybara.meta1.top", iconHash: "abc" }),
      ACCOUNT,
    );
    expect(h.deps.openMain).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new1", signedIn: true }),
      true,
    );
    expect(h.win().close).toHaveBeenCalled();
    // The main window opened before the small one closed (the last window closing quits on
    // Windows / Linux).
    expect((h.deps.openMain as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      h.win().close.mock.invocationCallOrder[0] as number,
    );
    // Saved: the closing window clears nothing.
    expect(h.deps.clearPartition).not.toHaveBeenCalled();
    expect(h.host.current()).toBeUndefined();
  });

  test.each(["timeout", "cancelled", "not_allowed", "account_unusable", "link_invalid"] as const)(
    "a failure (%s) shows found with its error",
    async (reason) => {
      const h = setup();
      await toWaiting(h);
      h.sign.attempts[0]?.settle({ ok: false, reason });
      await flush();
      expect(h.state()).toMatchObject({ page: "found", error: reason });
      // 重新登录 starts a new attempt.
      await h.act("found.signIn");
      expect(h.sign.signIn.begin).toHaveBeenCalledTimes(2);
      expect(h.state().page).toBe("waiting");
    },
  );

  test("the browser not opening ends the attempt with the link-invalid copy", async () => {
    const h = setup({ openExternal: vi.fn(async () => Promise.reject(new Error("no browser"))) });
    await toWaiting(h);
    expect(h.sign.signIn.cancel).toHaveBeenCalledWith("new1");
    expect(h.state()).toMatchObject({ page: "found", error: "link_invalid" });
  });

  test("a stale callback of the same issuer ends the attempt and shows link invalid", async () => {
    const h = setup();
    await toWaiting(h);
    h.sign.stale("https://other.example.com");
    expect(h.state().page).toBe("waiting");
    expect(h.sign.signIn.cancel).not.toHaveBeenCalled();
    h.sign.stale("https://capybara.meta1.top");
    await flush();
    expect(h.state()).toMatchObject({ page: "found", error: "link_invalid" });
    expect(h.sign.signIn.cancel).toHaveBeenCalledWith("new1");
    // 重新登录 starts a fresh attempt.
    await h.act("found.signIn");
    expect(h.sign.signIn.begin).toHaveBeenCalledTimes(2);
  });

  test("an outcome arriving after the window closed saves nothing; clear waits for quiesce", async () => {
    const h = setup();
    // An exchange still running when the window closes: cancel does not settle it at once.
    (h.sign.signIn.cancel as ReturnType<typeof vi.fn>).mockImplementation(() => undefined);
    const quiet = deferred<void>();
    (h.sign.signIn.quiesce as ReturnType<typeof vi.fn>).mockImplementation(() => quiet.promise);
    await toWaiting(h);
    h.win().close();
    await flush();
    expect(h.sign.signIn.cancel).toHaveBeenCalledWith("new1");
    expect(h.deps.clearPartition).not.toHaveBeenCalled();
    h.sign.attempts[0]?.settle({ ok: true, account: ACCOUNT });
    await flush();
    expect(h.deps.saveProfile).not.toHaveBeenCalled();
    expect(h.deps.openMain).not.toHaveBeenCalled();
    quiet.resolve();
    await flush();
    expect(h.deps.clearPartition).toHaveBeenCalledWith("new1");
  });

  test("an outcome arriving after 取消 saves nothing", async () => {
    const h = setup();
    (h.sign.signIn.cancel as ReturnType<typeof vi.fn>).mockImplementation(() => undefined);
    await toWaiting(h);
    await h.act("waiting.cancel");
    h.sign.attempts[0]?.settle({ ok: true, account: ACCOUNT });
    await flush();
    expect(h.deps.saveProfile).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ page: "found", error: null });
  });

  test("the address saved meanwhile under another id: provisional cleared, sign in again", async () => {
    const h = setup();
    await toWaiting(h);
    const other: Profile = {
      id: "managed1",
      base: "https://capybara.meta1.top",
      origin: "https://capybara.meta1.top",
      name: "M",
      signedIn: false,
    };
    (h.deps.saveProfile as ReturnType<typeof vi.fn>).mockImplementation(() => other);
    h.sign.attempts[0]?.settle({ ok: true, account: ACCOUNT });
    await flush();
    expect(h.deps.openMain).not.toHaveBeenCalled();
    expect(h.order).toEqual(["quiesce:new1", "clear:new1"]);
    expect(h.state()).toMatchObject({ page: "found", error: "link_invalid" });
    expect(h.host.current()).toEqual({ page: "found", profileId: "managed1", provisional: false });
    h.saved.push(other);
    await h.act("found.signIn");
    expect(h.sign.signIn.begin).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "managed1" }),
    );
    h.sign.attempts[1]?.settle({ ok: true, account: ACCOUNT });
    await flush();
    expect(h.deps.markSignedIn).toHaveBeenCalledWith("managed1", ACCOUNT);
  });

  test("capybara://connect while waiting only brings the window forward", async () => {
    const h = setup();
    await toWaiting(h);
    h.host.openConnect("other.example.com");
    expect(h.state().page).toBe("waiting");
    expect(h.sign.signIn.cancel).not.toHaveBeenCalled();
    expect(h.deps.openWindow).toHaveBeenCalledTimes(2);
  });

  test("closing the window abandons: cancel, then the partition cleared after quiesce", async () => {
    const h = setup();
    await toWaiting(h);
    h.win().close();
    await flush();
    expect(h.sign.signIn.cancel).toHaveBeenCalledWith("new1");
    expect(h.order).toEqual(["quiesce:new1", "clear:new1"]);
    expect(h.host.current()).toBeUndefined();
    // The next window starts afresh on connect.
    h.host.openConnect();
    expect(h.windows).toHaveLength(2);
    expect(h.state()).toMatchObject({ page: "connect", error: null });
  });

  test("closing the window on found before any attempt clears nothing", async () => {
    const h = setup();
    await toFound(h);
    h.win().close();
    await flush();
    expect(h.deps.clearPartition).not.toHaveBeenCalled();
  });
});

describe("signed out", () => {
  const p1: Profile = {
    id: "p1",
    base: "https://capybara.meta1.top",
    origin: "https://capybara.meta1.top",
    name: "Meta1 智能体平台",
    signedIn: false,
    account: ACCOUNT,
  };

  test("the signed-out page of a saved profile, registered for that profile", () => {
    const h = setup({ storedIcon: () => ICON });
    h.host.showSignedOut(p1);
    expect(h.state()).toMatchObject({
      page: "signedOut",
      account: ACCOUNT,
      canRemove: true,
      platform: { name: "Meta1 智能体平台", host: "capybara.meta1.top", iconUrl: ICON },
    });
    expect(h.localPages.entries()[0]?.profileId).toBe("p1");
    expect(h.state().deviceConnected).toBe(false);
  });

  test("the device note: this machine is that deployment's device", () => {
    let connected = true;
    const h = setup({ deviceConnected: (id) => connected && id === "p1" });
    h.host.showSignedOut(p1);
    expect(h.state()).toMatchObject({ page: "signedOut", deviceConnected: true });
    connected = false;
    h.host.refresh();
    expect(h.state().deviceConnected).toBe(false);
    // Only the signed-out page carries it.
    connected = true;
    h.host.showFound(p1);
    expect(h.state()).toMatchObject({ page: "found", deviceConnected: false });
  });

  test("在浏览器中重新登录 signs in to that profile and opens its main window", async () => {
    const h = setup();
    h.saved.push(p1);
    h.host.showSignedOut(p1);
    await h.act("signedOut.signIn");
    expect(h.sign.signIn.begin).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
    expect(h.state().page).toBe("waiting");
    h.sign.attempts[0]?.settle({ ok: true, account: ACCOUNT });
    await flush();
    expect(h.deps.markSignedIn).toHaveBeenCalledWith("p1", ACCOUNT);
    expect(h.deps.openMain).toHaveBeenCalled();
  });

  test("添加其他平台 goes to connect; 移除这个平台 runs the removal flow", async () => {
    const h = setup();
    h.host.showSignedOut(p1);
    await h.act("signedOut.remove");
    expect(h.deps.removeProfile).toHaveBeenCalledWith("p1");
    h.host.profileRemoved("p1");
    expect(h.state()).toMatchObject({ page: "connect", account: null });
    h.host.showSignedOut(p1);
    await h.act("signedOut.addOther");
    expect(h.state().page).toBe("connect");
    expect(h.localPages.entries()[0]?.profileId).toBeUndefined();
  });

  test("a failed or cancelled sign-in from here returns here, the failure shown", async () => {
    const h = setup();
    h.host.showSignedOut(p1);
    await h.act("signedOut.signIn");
    h.sign.attempts[0]?.settle({ ok: false, reason: "timeout" });
    await flush();
    expect(h.state()).toMatchObject({ page: "signedOut", error: "timeout" });
    await h.act("signedOut.signIn");
    await h.act("waiting.cancel");
    expect(h.state()).toMatchObject({ page: "signedOut", error: null });
  });

  test("a saved profile is discovered once: the pre-check applies, name and icon refresh", async () => {
    const h = setup({
      discover: vi.fn(async (base: string) => ({
        ok: true as const,
        base,
        meta: { ...META, name: "Renamed", features: { ...META.features, appSignIn: false } },
      })),
    });
    h.host.showSignedOut(p1);
    await flush();
    expect(h.deps.discover).toHaveBeenCalledWith(p1.base, expect.anything());
    expect(h.state().platform).toMatchObject({ name: "Renamed", iconUrl: ICON });
    await h.act("signedOut.signIn");
    expect(h.state()).toMatchObject({ page: "signedOut", error: "not_allowed" });
    expect(h.sign.signIn.begin).not.toHaveBeenCalled();
  });

  test("a saved profile whose discovery fails still signs in (no pre-check)", async () => {
    const h = setup({
      discover: vi.fn(async () => ({ ok: false as const, error: "unreachable" as const })),
    });
    h.host.showSignedOut(p1);
    await h.act("signedOut.signIn");
    expect(h.sign.signIn.begin).toHaveBeenCalled();
    expect(h.state()).toMatchObject({ page: "waiting", platform: { name: p1.name } });
  });

  test("under a managed lock nothing is removable", async () => {
    const h = setup({ canRemove: () => false });
    h.host.showSignedOut(p1);
    expect(h.state().canRemove).toBe(false);
    expect(await h.act("signedOut.remove")).toEqual({ ok: true, value: false });
    expect(h.deps.removeProfile).not.toHaveBeenCalled();
  });

  test("a never-signed-in saved profile gets its found page", () => {
    const h = setup();
    const { account: _account, ...neverSignedIn } = p1;
    h.host.showFound(neverSignedIn);
    expect(h.state()).toMatchObject({ page: "found", account: null });
  });

  test("closing the window of a saved profile never clears its partition", async () => {
    const h = setup();
    h.host.showSignedOut(p1);
    await h.act("signedOut.signIn");
    h.win().close();
    await flush();
    expect(h.sign.signIn.cancel).toHaveBeenCalledWith("p1");
    expect(h.deps.clearPartition).not.toHaveBeenCalled();
  });
});

describe("the page's actions", () => {
  test("an action that does not fit the view does nothing", async () => {
    const h = setup();
    h.host.openConnect();
    expect(await h.act("found.signIn")).toEqual({ ok: true, value: false });
    expect(await h.act("waiting.cancel")).toEqual({ ok: true, value: false });
    expect(h.sign.signIn.begin).not.toHaveBeenCalled();
  });

  test("an address longer than 2048 characters is not submitted", async () => {
    const h = setup();
    h.host.openConnect();
    expect(await h.act("connect.submit", { address: "a".repeat(2049) })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(h.deps.discover).not.toHaveBeenCalled();
  });

  test("refresh recolors the window and pushes the state", () => {
    const h = setup();
    h.host.openConnect();
    h.win().webContents.send.mockClear();
    h.host.refresh();
    expect(h.win().setBackgroundColor).toHaveBeenCalledWith("#0A0A0A");
    expect(h.win().setTitleBarOverlay).toHaveBeenCalledWith({
      color: "#0A0A0A",
      symbolColor: "#8E8E89",
    });
    expect(h.win().webContents.send).toHaveBeenCalledTimes(1);
  });
});

describe("locale", () => {
  test("zh* is zh, everything else en", () => {
    expect(localeFrom("zh-CN")).toBe("zh");
    expect(localeFrom("zh-Hant-TW")).toBe("zh");
    expect(localeFrom("en-US")).toBe("en");
    expect(localeFrom("")).toBe("en");
  });
});
