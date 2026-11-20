import { describe, expect, test, vi } from "vitest";
import { createConfirmGate } from "../src/main/ipc.ts";
import type { Profile } from "../src/main/profiles.ts";
import {
  type CompletedDetails,
  createSignOut,
  isLoginUrl,
  isLogoutCompletion,
  LOGGED_OUT_WINDOW_MS,
  type SignOutDeps,
  signOutOnLogin,
  watchLoginNavigations,
  watchLogout,
} from "../src/main/sign-out.ts";
import { fakeEmitter } from "./fakes.ts";

const profile: Profile = {
  id: "p1",
  base: "https://a.example.com/team",
  origin: "https://a.example.com",
  name: "A",
  signedIn: true,
  account: { name: "Ann", login: "ann@example.com" },
};

const done = (url: string, method = "POST", statusCode = 200): CompletedDetails => ({
  url,
  method,
  statusCode,
});

describe("the logout filter", () => {
  const base = profile.base;
  test("matches a 2xx POST to the profile's own logout route", () => {
    expect(isLogoutCompletion(done(`${base}/api/v1/auth/logout`), base)).toBe(true);
    expect(isLogoutCompletion(done(`${base}/api/v1/auth/logout/`, "post", 204), base)).toBe(true);
    expect(isLogoutCompletion(done(`${base}/api/v1/auth/logout?x=1`), base)).toBe(true);
  });

  test("only POST", () => {
    expect(isLogoutCompletion(done(`${base}/api/v1/auth/logout`, "GET"), base)).toBe(false);
  });

  test("only 2xx", () => {
    for (const status of [199, 302, 401, 403, 500]) {
      expect(isLogoutCompletion(done(`${base}/api/v1/auth/logout`, "POST", status), base)).toBe(
        false,
      );
    }
  });

  test("only the profile's own base", () => {
    // Another origin, the same path.
    expect(isLogoutCompletion(done("https://b.example.com/team/api/v1/auth/logout"), base)).toBe(
      false,
    );
    // The same origin outside the base path.
    expect(isLogoutCompletion(done("https://a.example.com/api/v1/auth/logout"), base)).toBe(false);
    expect(isLogoutCompletion(done("https://a.example.com/teamx/api/v1/auth/logout"), base)).toBe(
      false,
    );
    // Another scheme or port.
    expect(isLogoutCompletion(done("http://a.example.com/team/api/v1/auth/logout"), base)).toBe(
      false,
    );
    // Not the route.
    expect(isLogoutCompletion(done(`${base}/api/v1/auth/login`), base)).toBe(false);
    expect(isLogoutCompletion(done("not a url"), base)).toBe(false);
  });

  test("watchLogout registers one onCompleted listener and reports only matches", () => {
    let listener: ((d: CompletedDetails) => void) | undefined;
    const onCompleted = vi.fn((l: (d: CompletedDetails) => void) => {
      listener = l;
    });
    const onLogout = vi.fn();
    watchLogout({ webRequest: { onCompleted } }, base, onLogout);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    listener?.(done(`${base}/api/v1/auth/logout`, "POST", 401));
    listener?.(done(`${base}/api/v1/me`, "POST"));
    expect(onLogout).not.toHaveBeenCalled();
    listener?.(done(`${base}/api/v1/auth/logout`));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

describe("isLoginUrl", () => {
  test("the deployment's /login under its base, any query", () => {
    expect(isLoginUrl(profile, "https://a.example.com/team/login")).toBe(true);
    expect(isLoginUrl(profile, "https://a.example.com/team/login?returnTo=%2Fchat")).toBe(true);
    expect(isLoginUrl(profile, "https://a.example.com/team/login/")).toBe(true);
  });

  test("not another page, path or origin", () => {
    expect(isLoginUrl(profile, "https://a.example.com/team/")).toBe(false);
    expect(isLoginUrl(profile, "https://a.example.com/login")).toBe(false);
    expect(isLoginUrl(profile, "https://a.example.com/team/login/sso")).toBe(false);
    expect(isLoginUrl(profile, "https://evil.example.com/team/login")).toBe(false);
    expect(isLoginUrl(profile, "garbage")).toBe(false);
  });
});

function setup(over: Partial<SignOutDeps> = {}) {
  let stored: Profile | undefined = { ...profile };
  let clock = 1_000;
  const order: string[] = [];
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({
    ok: true,
    status: 204,
    json: async () => ({}),
  }));
  const deps = {
    getProfile: vi.fn((id: string) => (stored?.id === id ? stored : undefined)),
    markSignedOut: vi.fn((id: string) => {
      if (stored?.id !== id) return undefined;
      stored = { ...stored, signedIn: false };
      order.push("mark");
      return stored;
    }),
    showSignedOut: vi.fn((_p: Profile) => {
      order.push("show");
    }),
    closeProfileWindows: vi.fn((_id: string) => {
      order.push("close");
    }),
    confirm: vi.fn(async (_p: Profile) => true),
    fetchFor: vi.fn(() => fetch),
    clearSessionCookies: vi.fn(async (_p: Profile) => {
      order.push("cookies");
    }),
    onSignedOut: vi.fn(),
    now: () => clock,
    log: vi.fn(),
    ...over,
  };
  const signOut = createSignOut(deps);
  return {
    signOut,
    deps,
    fetch,
    order,
    advance: (ms: number) => {
      clock += ms;
    },
    stored: () => stored,
    remove: () => {
      stored = undefined;
    },
  };
}

describe("noteLoggedOut / takeLoggedOut", () => {
  test("true once after a logout", () => {
    const h = setup();
    expect(h.signOut.takeLoggedOut("p1")).toBe(false);
    h.signOut.noteLoggedOut("p1");
    expect(h.signOut.takeLoggedOut("p1")).toBe(true);
    expect(h.signOut.takeLoggedOut("p1")).toBe(false);
  });

  test("only within 30 s", () => {
    const h = setup();
    h.signOut.noteLoggedOut("p1");
    h.advance(LOGGED_OUT_WINDOW_MS);
    expect(h.signOut.takeLoggedOut("p1")).toBe(true);
    h.signOut.noteLoggedOut("p1");
    h.advance(LOGGED_OUT_WINDOW_MS + 1);
    expect(h.signOut.takeLoggedOut("p1")).toBe(false);
  });

  test("per profile, and ignored for a profile that is not signed in", () => {
    const h = setup();
    h.signOut.noteLoggedOut("p1");
    expect(h.signOut.takeLoggedOut("p2")).toBe(false);
    expect(h.signOut.takeLoggedOut("p1")).toBe(true);
    h.deps.markSignedOut("p1");
    h.signOut.noteLoggedOut("p1");
    expect(h.signOut.takeLoggedOut("p1")).toBe(false);
  });
});

describe("complete", () => {
  test("marks signed out, shows the signed-out page first, then closes the windows", async () => {
    const h = setup();
    await h.signOut.complete("p1");
    expect(h.order).toEqual(["mark", "show", "close"]);
    expect(h.deps.markSignedOut).toHaveBeenCalledWith("p1");
    expect(h.deps.showSignedOut).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", signedIn: false, account: profile.account }),
    );
    expect(h.deps.closeProfileWindows).toHaveBeenCalledWith("p1");
    expect(h.deps.onSignedOut).toHaveBeenCalledTimes(1);
    // The profile stays.
    expect(h.stored()).toMatchObject({ id: "p1", signedIn: false });
  });

  test("clears a pending logout note", async () => {
    const h = setup();
    h.signOut.noteLoggedOut("p1");
    await h.signOut.complete("p1");
    expect(h.signOut.takeLoggedOut("p1")).toBe(false);
  });

  test("a removed profile: nothing", async () => {
    const h = setup();
    h.remove();
    await h.signOut.complete("p1");
    expect(h.deps.showSignedOut).not.toHaveBeenCalled();
    expect(h.deps.closeProfileWindows).not.toHaveBeenCalled();
  });
});

describe("confirmAndSignOut", () => {
  test("asks, posts the logout through the partition, clears the cookies, completes", async () => {
    const h = setup();
    await h.signOut.confirmAndSignOut("p1");
    expect(h.deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
    expect(h.deps.fetchFor).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://a.example.com/team/api/v1/auth/logout");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "X-Capybara-Csrf": "1" },
      credentials: "include",
      redirect: "error",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(h.order).toEqual(["cookies", "mark", "show", "close"]);
  });

  test("cancelled: nothing is posted or changed", async () => {
    const h = setup({ confirm: vi.fn(async () => false) });
    await h.signOut.confirmAndSignOut("p1");
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.deps.markSignedOut).not.toHaveBeenCalled();
    expect(h.stored()?.signedIn).toBe(true);
  });

  test("a failed or refused logout still signs out", async () => {
    for (const fetch of [
      vi.fn(async () => {
        throw new TypeError("network");
      }),
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
    ]) {
      const h = setup({ fetchFor: () => fetch });
      await h.signOut.confirmAndSignOut("p1");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(h.order).toEqual(["cookies", "mark", "show", "close"]);
    }
  });

  test("a cookie clearing failure still signs out", async () => {
    const h = setup({
      clearSessionCookies: vi.fn(async () => {
        throw new Error("jar");
      }),
    });
    await h.signOut.confirmAndSignOut("p1");
    expect(h.deps.showSignedOut).toHaveBeenCalledTimes(1);
  });

  test("a profile that is not signed in is not asked about", async () => {
    const h = setup();
    h.deps.markSignedOut("p1");
    await h.signOut.confirmAndSignOut("p1");
    expect(h.deps.confirm).not.toHaveBeenCalled();
  });

  test("signed out meanwhile (the web's own sign-out): no second POST", async () => {
    let answer: (yes: boolean) => void = () => {};
    const h = setup({
      confirm: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const flow = h.signOut.confirmAndSignOut("p1");
    await h.signOut.complete("p1");
    answer(true);
    await flow;
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.deps.showSignedOut).toHaveBeenCalledTimes(1);
  });

  test("one dialog at a time per profile (the gate)", async () => {
    const gate = createConfirmGate();
    let answer: (yes: boolean) => void = () => {};
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const h = setup({ gate, confirm });
    const first = h.signOut.confirmAndSignOut("p1");
    await h.signOut.confirmAndSignOut("p1");
    expect(confirm).toHaveBeenCalledTimes(1);
    answer(false);
    await first;
    // Released afterwards.
    expect(gate.isConfirmingCallAllowed("p1", true)).toBe("ok");
  });
});

describe("the login navigation watch", () => {
  function contents() {
    const em = fakeEmitter();
    return { ...em, on: em.on };
  }
  const event = () => ({ preventDefault: vi.fn() });

  test("a /login after a logout completes the sign-out and stops the navigation", async () => {
    const h = setup();
    const wc = contents();
    watchLoginNavigations(wc, profile, signOutOnLogin(h.signOut, "p1"));
    h.signOut.noteLoggedOut("p1");
    const e = event();
    wc.emit("will-navigate", e, "https://a.example.com/team/login");
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.deps.showSignedOut).toHaveBeenCalledTimes(1));
    // Reported again (committed anyway): once only.
    wc.emit("did-navigate", {}, "https://a.example.com/team/login");
    expect(h.deps.showSignedOut).toHaveBeenCalledTimes(1);
  });

  test("a client navigation (did-navigate-in-page) counts too", async () => {
    const h = setup();
    const wc = contents();
    watchLoginNavigations(wc, profile, signOutOnLogin(h.signOut, "p1"));
    h.signOut.noteLoggedOut("p1");
    wc.emit("did-navigate-in-page", {}, "https://a.example.com/team/login?returnTo=%2F", true);
    await vi.waitFor(() => expect(h.deps.showSignedOut).toHaveBeenCalledTimes(1));
  });

  test("a /login without a logout is left alone (K9 adds the expired page)", () => {
    const h = setup();
    const wc = contents();
    watchLoginNavigations(wc, profile, signOutOnLogin(h.signOut, "p1"));
    const e = event();
    wc.emit("will-navigate", e, "https://a.example.com/team/login");
    wc.emit("did-navigate", {}, "https://a.example.com/team/login");
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(h.deps.showSignedOut).not.toHaveBeenCalled();
  });

  test("subframes, other pages and other origins are ignored", () => {
    const onLogin = vi.fn();
    const wc = contents();
    watchLoginNavigations(wc, profile, onLogin);
    wc.emit("did-navigate-in-page", {}, "https://a.example.com/team/login", false);
    wc.emit("will-redirect", event(), "https://a.example.com/team/login", false, false);
    wc.emit("will-navigate", event(), "https://a.example.com/team/chat");
    wc.emit("will-navigate", event(), "https://b.example.com/team/login");
    expect(onLogin).not.toHaveBeenCalled();
    wc.emit("will-redirect", event(), "https://a.example.com/team/login", false, true);
    expect(onLogin).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://a.example.com/team/login", stoppable: true }),
    );
  });
});
