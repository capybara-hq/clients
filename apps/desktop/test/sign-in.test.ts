import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { brand } from "../brand.ts";
import type { Profile } from "../src/main/profiles.ts";
import {
  createSignIn,
  REDIRECT_URI,
  type ResponseLike,
  type SignInDeps,
} from "../src/main/sign-in.ts";
import { machineNameFrom } from "../src/main/user-agent.ts";

const profile: Profile = {
  id: "p1",
  signedIn: true,
  base: "https://capybara.example.com/team",
  origin: "https://capybara.example.com",
  name: "Example",
};
const other: Profile = {
  id: "p2",
  signedIn: true,
  base: "https://other.example.com",
  origin: "https://other.example.com",
  name: "Other",
};

const TOKEN_BODY = {
  account: {
    id: "a1",
    displayName: "Grant",
    email: "grant@example.com",
    status: "active",
    isSuperAdmin: true,
    mustChangePassword: false,
    createdAt: "2026-11-20T00:00:00.000Z",
  },
  accessToken: "cap_at_SECRET",
  refresh: "cap_rt_SECRET",
};

function okResponse(body: unknown = TOKEN_BODY) {
  return { ok: true, status: 200, json: async () => body };
}

function setup(over: Partial<SignInDeps> = {}) {
  let clock = 1_000_000;
  let n = 0;
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const opened: string[] = [];
  const fetchCalls: { profileId: string; url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async () => okResponse());
  const profiles = new Map([
    [profile.id, profile],
    [other.id, other],
  ]);
  const onSignedIn = vi.fn();
  const log = vi.fn();
  const deps: SignInDeps = {
    openExternal: vi.fn(async (url: string) => {
      opened.push(url);
    }),
    fetchFor: (p) => async (url, init) => {
      fetchCalls.push({ profileId: p.id, url, init });
      return fetchImpl();
    },
    getProfile: (id) => profiles.get(id),
    onSignedIn,
    machineName: "Grants-MacBook",
    appVersion: "0.1.0",
    now: () => clock,
    pkce: () => {
      n += 1;
      return { verifier: `verifier-${n}`, challenge: `challenge-${n}` };
    },
    newState: () => `state-${n}`,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    log,
    ...over,
  };
  const signIn = createSignIn(deps);
  return {
    signIn,
    deps,
    opened,
    fetchCalls,
    fetchImpl,
    profiles,
    onSignedIn,
    log,
    timers,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Lets the start() promise register before the callback arrives. */
const flush = () => new Promise((r) => setImmediate(r));

const callback = (o: Partial<{ code: string; error: string; state: string; iss: string }>) => ({
  kind: "auth" as const,
  state: "state-1",
  iss: "https://capybara.example.com/team",
  ...(o.error ? { error: o.error } : { code: o.code ?? "cap_ac_1" }),
  ...o,
});

describe("signIn@1 start()", () => {
  test("opens the system browser at the authorize page under the profile base", async () => {
    const { signIn, opened } = setup();
    void signIn.capability.start({ profile });
    await flush();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toBe(
      "https://capybara.example.com/team/apps/authorize?client=desktop" +
        "&redirect_uri=capybara%3A%2F%2Fauth%2Fcallback&code_challenge=challenge-1" +
        "&code_challenge_method=S256&state=state-1&name=Grants-MacBook&app_version=0.1.0",
    );
  });

  test("the verifier never appears in the browser URL", async () => {
    const { signIn, opened } = setup();
    void signIn.capability.start({ profile });
    await flush();
    expect(opened[0]).not.toContain("verifier");
  });

  test("defaults: real PKCE and a 32-byte state", async () => {
    const { deps, opened } = setup();
    const { pkce: _pkce, newState: _newState, ...rest } = deps;
    void createSignIn(rest).capability.start({ profile });
    await flush();
    const url = new URL(opened[0] as string);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("a browser that cannot be opened fails the attempt and leaves nothing pending", async () => {
    const { signIn } = setup({
      openExternal: async () => {
        throw new Error("no browser");
      },
    });
    await expect(signIn.capability.start({ profile })).rejects.toEqual({ code: "failed" });
    expect(signIn.pendingCount()).toBe(0);
  });
});

describe("the callback", () => {
  test("a matching state and iss: one exchange through the profile session, then signedIn", async () => {
    const { signIn, fetchCalls, onSignedIn } = setup();
    const result = signIn.capability.start({ profile });
    await flush();
    await signIn.handleCallback(callback({}));
    await expect(result).resolves.toBe("signedIn");
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call?.profileId).toBe("p1");
    expect(call?.url).toBe("https://capybara.example.com/team/api/v1/app-auth/token");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.credentials).toBe("include");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.headers).toEqual({
      "content-type": "application/json",
      // The kernel requires it on every non-safe public route (login CSRF).
      "X-Capybara-Csrf": "1",
      // SessionService.refresh records the request's user agent on the session.
      "User-Agent": "Capybara Desktop/0.1.0 (Grants-MacBook)",
    });
    expect(JSON.parse(call?.init.body as string)).toEqual({
      code: "cap_ac_1",
      codeVerifier: "verifier-1",
      redirectUri: REDIRECT_URI,
    });
    // Derived from the brand's scheme (the only brand file); `capybara` gives the kernel's value.
    expect(REDIRECT_URI).toBe(`${brand.scheme}://auth/callback`);
    expect(REDIRECT_URI).toBe("capybara://auth/callback");
    // The window reloads (the wiring reloads every window of the profile on its origin).
    expect(onSignedIn).toHaveBeenCalledExactlyOnceWith(profile);
  });

  test("iss compares without a trailing slash", async () => {
    const { signIn, fetchCalls } = setup();
    const result = signIn.capability.start({ profile });
    await flush();
    await signIn.handleCallback(callback({ iss: "https://capybara.example.com/team/" }));
    await expect(result).resolves.toBe("signedIn");
    expect(fetchCalls).toHaveLength(1);
  });

  test("an unknown state: no exchange, and the pending attempt stays", async () => {
    const { signIn, fetchCalls } = setup();
    const result = signIn.capability.start({ profile });
    await flush();
    await signIn.handleCallback(callback({ state: "someone-else" }));
    expect(fetchCalls).toHaveLength(0);
    expect(signIn.pendingCount()).toBe(1);
    await signIn.handleCallback(callback({}));
    await expect(result).resolves.toBe("signedIn");
  });

  test("a wrong iss: no exchange, the attempt is dropped and fails", async () => {
    const { signIn, fetchCalls, onSignedIn } = setup();
    const result = signIn.capability.start({ profile });
    await flush();
    await signIn.handleCallback(callback({ iss: "https://evil.example.com/team" }));
    await expect(result).rejects.toEqual({ code: "failed" });
    // The origin alone is not enough: the base path is part of the issuer.
    const second = signIn.capability.start({ profile });
    await flush();
    await signIn.handleCallback(
      callback({ state: "state-2", iss: "https://capybara.example.com" }),
    );
    await expect(second).rejects.toEqual({ code: "failed" });
    expect(fetchCalls).toHaveLength(0);
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(signIn.pendingCount()).toBe(0);
  });

  test("a callback after 10 minutes: no exchange; signIn@1 reports a timeout as cancelled", async () => {
    const { signIn, fetchCalls, advance } = setup();
    const result = signIn.capability.start({ profile });
    await flush();
    advance(10 * 60 * 1000 + 1);
    await signIn.handleCallback(callback({}));
    await expect(result).resolves.toBe("cancelled");
    expect(fetchCalls).toHaveLength(0);
    expect(signIn.pendingCount()).toBe(0);
  });

  test("an attempt nobody finishes ends as cancelled after 10 minutes", async () => {
    const { signIn, timers, fetchCalls } = setup();
    const result = signIn.capability.start({ profile });
    await flush();
    expect(timers.map((t) => t.ms)).toEqual([10 * 60 * 1000]);
    timers[0]?.fn();
    await expect(result).resolves.toBe("cancelled");
    expect(signIn.pendingCount()).toBe(0);
    await signIn.handleCallback(callback({}));
    expect(fetchCalls).toHaveLength(0);
  });

  test("a replayed callback: no second exchange", async () => {
    const { signIn, fetchCalls, onSignedIn } = setup();
    const result = signIn.capability.start({ profile });
    await flush();
    const cb = callback({});
    await Promise.all([signIn.handleCallback(cb), signIn.handleCallback(cb)]);
    await signIn.handleCallback(cb);
    await expect(result).resolves.toBe("signedIn");
    expect(fetchCalls).toHaveLength(1);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  test("error=access_denied resolves cancelled and drops the attempt", async () => {
    const { signIn, fetchCalls, timers } = setup();
    const result = signIn.capability.start({ profile });
    await flush();
    await signIn.handleCallback(callback({ error: "access_denied" }));
    await expect(result).resolves.toBe("cancelled");
    expect(fetchCalls).toHaveLength(0);
    expect(signIn.pendingCount()).toBe(0);
    expect(timers[0]?.cancelled).toBe(true);
  });

  test("another error with a known state fails the attempt", async () => {
    const { signIn, fetchCalls } = setup();
    const result = signIn.capability.start({ profile });
    await flush();
    await signIn.handleCallback(callback({ error: "server_error" }));
    await expect(result).rejects.toEqual({ code: "failed" });
    expect(fetchCalls).toHaveLength(0);
  });

  test("a refused exchange (app_auth.code_invalid) fails without reloading", async () => {
    const { signIn, fetchImpl, onSignedIn } = setup();
    fetchImpl.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: "app_auth.code_invalid", message: "x" } }),
    });
    const result = signIn.capability.start({ profile });
    await flush();
    await signIn.handleCallback(callback({}));
    await expect(result).rejects.toEqual({ code: "failed" });
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test("503 app_auth.unavailable fails and logs the code, never the body", async () => {
    const { signIn, fetchImpl, onSignedIn, log } = setup();
    fetchImpl.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({
        error: { code: "app_auth.unavailable", message: "BODY_TEXT http.publicUrl is not set" },
      }),
    });
    const result = signIn.capability.start({ profile });
    await flush();
    await signIn.handleCallback(callback({}));
    await expect(result).rejects.toEqual({ code: "failed" });
    expect(onSignedIn).not.toHaveBeenCalled();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("503");
    expect(logged).toContain("app_auth.unavailable");
    expect(logged).not.toContain("BODY_TEXT");
  });

  test("a refusal whose body is not the kernel's error shape logs only the status", async () => {
    for (const json of [
      async () => {
        throw new SyntaxError("bad json");
      },
      async () => ({ error: { code: "NOT A CODE <script>" } }),
      async () => ({ error: { code: "x".repeat(200) } }),
      async () => "BODY_TEXT",
    ]) {
      const { signIn, fetchImpl, log } = setup();
      fetchImpl.mockResolvedValueOnce({ ok: false, status: 502, json } as never);
      const result = signIn.capability.start({ profile });
      await flush();
      await signIn.handleCallback(callback({}));
      await expect(result).rejects.toEqual({ code: "failed" });
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain("502");
      expect(logged).not.toMatch(/BODY_TEXT|script|xxxxxxxx/);
    }
  });

  test("a network error or a body without an account fails", async () => {
    for (const impl of [
      async () => {
        throw new Error("ECONNRESET");
      },
      async () => okResponse({ nope: true }),
      async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      }),
    ]) {
      const { signIn, fetchImpl, onSignedIn } = setup();
      fetchImpl.mockImplementationOnce(impl as never);
      const result = signIn.capability.start({ profile });
      await flush();
      await signIn.handleCallback(callback({}));
      await expect(result).rejects.toEqual({ code: "failed" });
      expect(onSignedIn).not.toHaveBeenCalled();
    }
  });

  test("the token exchange has a 30 s timeout; hitting it fails the sign-in", async () => {
    const timeout = new AbortController();
    const asked: number[] = [];
    const { signIn, deps, fetchImpl, onSignedIn } = setup({
      timeoutSignal: (ms) => {
        asked.push(ms);
        return timeout.signal;
      },
    });
    let signal: AbortSignal | null | undefined;
    // A fetch that only ends when its signal aborts, as a stalled server would.
    deps.fetchFor = () => (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    void fetchImpl;
    const result = signIn.capability.start({ profile });
    result.catch(() => undefined);
    await flush();
    const handled = signIn.handleCallback(callback({}));
    await flush();
    expect(asked).toEqual([30_000]);
    expect(signal).toBe(timeout.signal);
    timeout.abort();
    await handled;
    await expect(result).rejects.toEqual({ code: "failed" });
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test("a profile removed meanwhile gets no exchange", async () => {
    const { signIn, profiles, fetchCalls } = setup();
    const result = signIn.capability.start({ profile });
    await flush();
    profiles.delete(profile.id);
    await signIn.handleCallback(callback({}));
    await expect(result).resolves.toBe("cancelled");
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("pending attempts", () => {
  test("a new start for the same profile replaces the older one, which resolves cancelled", async () => {
    const { signIn, fetchCalls, timers } = setup();
    const first = signIn.capability.start({ profile });
    await flush();
    const second = signIn.capability.start({ profile });
    await flush();
    await expect(first).resolves.toBe("cancelled");
    expect(timers[0]?.cancelled).toBe(true);
    expect(signIn.pendingCount()).toBe(1);
    // The old state is gone: its callback does nothing.
    await signIn.handleCallback(callback({ state: "state-1" }));
    expect(fetchCalls).toHaveLength(0);
    await signIn.handleCallback(callback({ state: "state-2" }));
    await expect(second).resolves.toBe("signedIn");
    expect(JSON.parse(fetchCalls[0]?.init.body as string).codeVerifier).toBe("verifier-2");
  });

  test("attempts of two profiles are independent; a state is bound to its profile", async () => {
    const { signIn, fetchCalls } = setup();
    const a = signIn.capability.start({ profile });
    await flush();
    const b = signIn.capability.start({ profile: other });
    await flush();
    expect(signIn.pendingCount()).toBe(2);
    // The second profile's state with the first profile's issuer: wrong issuer for that attempt.
    await signIn.handleCallback(callback({ state: "state-2" }));
    await expect(b).rejects.toEqual({ code: "failed" });
    await signIn.handleCallback(callback({ state: "state-1" }));
    await expect(a).resolves.toBe("signedIn");
    expect(fetchCalls.map((c) => c.profileId)).toEqual(["p1"]);
  });
});

const refusal = (status: number, code?: string): ResponseLike => ({
  ok: false,
  status,
  json: async () => ({ error: { ...(code ? { code } : {}), message: "BODY_TEXT" } }),
});

describe("begin()", () => {
  test("returns the authorize URL without opening the browser; pendingUrl gives it back", () => {
    const { signIn, opened, deps } = setup();
    const { url } = signIn.begin(profile);
    expect(url).toBe(
      "https://capybara.example.com/team/apps/authorize?client=desktop" +
        "&redirect_uri=capybara%3A%2F%2Fauth%2Fcallback&code_challenge=challenge-1" +
        "&code_challenge_method=S256&state=state-1&name=Grants-MacBook&app_version=0.1.0",
    );
    expect(url).not.toContain("verifier");
    expect(opened).toHaveLength(0);
    expect(deps.openExternal).not.toHaveBeenCalled();
    expect(signIn.pendingUrl("p1")).toBe(url);
    expect(signIn.pendingUrl("p2")).toBeUndefined();
    expect(signIn.pendingCount()).toBe(1);
  });

  test("success: the account's name and login only, through the partition fetch", async () => {
    const { signIn, fetchCalls, onSignedIn, log } = setup();
    const { outcome } = signIn.begin(profile);
    await signIn.handleCallback(callback({}));
    const result = await outcome;
    expect(result).toStrictEqual({
      ok: true,
      account: { name: "Grant", login: "grant@example.com" },
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|a1|active|isSuperAdmin|createdAt/);
    const init = fetchCalls[0]?.init;
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.profileId).toBe("p1");
    expect(init?.credentials).toBe("include");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({ "X-Capybara-Csrf": "1" });
    // The app's own pages decide what follows: no window reload from here.
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(signIn.pendingUrl("p1")).toBeUndefined();
    expect(signIn.pendingCount()).toBe(0);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Grant|grant@example\.com/);
  });

  test.each([
    [
      "a login field wins over the email",
      { displayName: "Grant", login: "grant", email: "g@x.io" },
      { name: "Grant", login: "grant" },
    ],
    [
      "no email: an empty login",
      { displayName: "Grant", email: null },
      { name: "Grant", login: "" },
    ],
    [
      "names are trimmed",
      { displayName: "  Grant  ", email: " g@x.io " },
      { name: "Grant", login: "g@x.io" },
    ],
    [
      "no display name: the login stands in",
      { email: "g@x.io" },
      { name: "g@x.io", login: "g@x.io" },
    ],
    [
      "a name with a control character is dropped",
      { displayName: "Gr\u0000ant", email: "g@x.io" },
      { name: "g@x.io", login: "g@x.io" },
    ],
    [
      "a name with a bidi override is dropped",
      { displayName: "Grant‮txt.exe", email: "g@x.io" },
      { name: "g@x.io", login: "g@x.io" },
    ],
    [
      "a name over 200 characters is dropped",
      { displayName: "x".repeat(201), email: "g@x.io" },
      { name: "g@x.io", login: "g@x.io" },
    ],
    [
      "a name of exactly 200 characters is kept",
      { displayName: "x".repeat(200) },
      { name: "x".repeat(200), login: "" },
    ],
    [
      "non-string fields are ignored",
      { displayName: { toString: "x" }, login: 42, email: ["g@x.io"] },
      null,
    ],
    [
      "an email over 254 characters is dropped",
      { displayName: "Grant", email: `${"e".repeat(250)}@x.io` },
      { name: "Grant", login: "" },
    ],
    ["an empty account", {}, null],
    ["whitespace only", { displayName: "   ", email: "  " }, null],
  ])("the account: %s", async (_title, account, expected) => {
    const { signIn, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(okResponse({ account, accessToken: "cap_at_SECRET" }));
    const { outcome } = signIn.begin(profile);
    await signIn.handleCallback(callback({}));
    await expect(outcome).resolves.toStrictEqual(
      expected ? { ok: true, account: expected } : { ok: false, reason: "link_invalid" },
    );
  });

  test.each([
    ["no account", { nope: true }],
    ["an account that is not an object", { account: "Grant" }],
    ["an account that is an array", { account: ["Grant"] }],
    ["a null body", null],
    ["a string body", "Grant"],
  ])("a 200 with %s is link_invalid", async (_title, body) => {
    const { signIn, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(okResponse(body));
    const { outcome } = signIn.begin(profile);
    await signIn.handleCallback(callback({}));
    await expect(outcome).resolves.toEqual({ ok: false, reason: "link_invalid" });
  });

  test.each([
    [503, "app_auth.unavailable", "not_allowed"],
    [400, "app_auth.redirect_uri_invalid", "not_allowed"],
    [403, "auth.account_disabled", "account_unusable"],
    [400, "app_auth.code_invalid", "link_invalid"],
    [429, "rate_limited", "link_invalid"],
    [500, "internal", "link_invalid"],
    [502, undefined, "link_invalid"],
    // A code that is not the kernel's shape is never trusted, even if it contains a known one.
    [403, "AUTH.ACCOUNT_DISABLED", "link_invalid"],
    [403, "auth.account_disabled ", "link_invalid"],
  ] as const)("exchange %i %s → %s", async (status, code, reason) => {
    const { signIn, fetchImpl, log } = setup();
    fetchImpl.mockResolvedValueOnce(refusal(status, code));
    const { outcome } = signIn.begin(profile);
    await signIn.handleCallback(callback({}));
    await expect(outcome).resolves.toEqual({ ok: false, reason });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain(String(status));
    expect(logged).not.toContain("BODY_TEXT");
  });

  test("a code on an object prototype key maps to link_invalid", async () => {
    for (const code of ["constructor", "tostring", "__proto__"]) {
      const { signIn, fetchImpl } = setup();
      fetchImpl.mockResolvedValueOnce(refusal(400, code));
      const { outcome } = signIn.begin(profile);
      await signIn.handleCallback(callback({}));
      await expect(outcome).resolves.toEqual({ ok: false, reason: "link_invalid" });
    }
  });

  test("a network error, unreadable JSON or the exchange timeout is link_invalid", async () => {
    for (const impl of [
      async () => {
        throw new Error("ECONNRESET");
      },
      async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      }),
    ]) {
      const { signIn, fetchImpl } = setup();
      fetchImpl.mockImplementationOnce(impl as never);
      const { outcome } = signIn.begin(profile);
      await signIn.handleCallback(callback({}));
      await expect(outcome).resolves.toEqual({ ok: false, reason: "link_invalid" });
    }
  });

  test("no callback within 10 minutes: timeout", async () => {
    const { signIn, timers, fetchCalls } = setup();
    const { outcome } = signIn.begin(profile);
    expect(timers.map((t) => t.ms)).toEqual([10 * 60 * 1000]);
    timers[0]?.fn();
    await expect(outcome).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(signIn.pendingUrl("p1")).toBeUndefined();
    await signIn.handleCallback(callback({}));
    expect(fetchCalls).toHaveLength(0);
  });

  test("a callback after 10 minutes but before the timer fired: timeout, no exchange", async () => {
    const { signIn, advance, fetchCalls, timers } = setup();
    const { outcome } = signIn.begin(profile);
    advance(10 * 60 * 1000 + 1);
    await signIn.handleCallback(callback({}));
    await expect(outcome).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(fetchCalls).toHaveLength(0);
    expect(timers[0]?.cancelled).toBe(true);
    // The timer firing late changes nothing.
    timers[0]?.fn();
    expect(signIn.pendingCount()).toBe(0);
  });

  test("access_denied: cancelled; another callback error: link_invalid", async () => {
    for (const [error, reason] of [
      ["access_denied", "cancelled"],
      ["server_error", "link_invalid"],
      ["invalid_request", "link_invalid"],
    ] as const) {
      const { signIn, fetchCalls } = setup();
      const { outcome } = signIn.begin(profile);
      await signIn.handleCallback(callback({ error }));
      await expect(outcome).resolves.toEqual({ ok: false, reason });
      expect(fetchCalls).toHaveLength(0);
    }
  });

  test("a wrong issuer: link_invalid, no exchange, the attempt is used up", async () => {
    for (const iss of [
      "https://evil.example.com/team",
      "https://capybara.example.com",
      "https://capybara.example.com/team/x",
      "http://capybara.example.com/team",
    ]) {
      const { signIn, fetchCalls, log } = setup();
      const stale = vi.fn();
      signIn.onStaleCallback(stale);
      const { outcome } = signIn.begin(profile);
      await signIn.handleCallback(callback({ iss }));
      await expect(outcome).resolves.toEqual({ ok: false, reason: "link_invalid" });
      expect(fetchCalls).toHaveLength(0);
      expect(signIn.pendingCount()).toBe(0);
      expect(stale).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).toContain("wrong_issuer");
    }
  });

  test("a callback with neither code nor error: link_invalid, no exchange", async () => {
    const { signIn, fetchCalls } = setup();
    const { outcome } = signIn.begin(profile);
    await signIn.handleCallback({ kind: "auth", state: "state-1", iss: profile.base } as never);
    await expect(outcome).resolves.toEqual({ ok: false, reason: "link_invalid" });
    expect(fetchCalls).toHaveLength(0);
  });

  test("a profile removed or re-pointed meanwhile: cancelled, no exchange", async () => {
    for (const change of [
      (m: Map<string, Profile>) => m.delete("p1"),
      (m: Map<string, Profile>) =>
        m.set("p1", { ...profile, base: "https://elsewhere.example.com" }),
    ]) {
      const { signIn, profiles, fetchCalls } = setup();
      const { outcome } = signIn.begin(profile);
      change(profiles);
      await signIn.handleCallback(callback({}));
      await expect(outcome).resolves.toEqual({ ok: false, reason: "cancelled" });
      expect(fetchCalls).toHaveLength(0);
    }
  });

  test("the exchange uses the profile as stored now", async () => {
    const { signIn, profiles, fetchCalls } = setup();
    const { outcome } = signIn.begin(profile);
    profiles.set("p1", { ...profile, name: "Renamed" });
    await signIn.handleCallback(callback({}));
    await expect(outcome).resolves.toMatchObject({ ok: true });
    expect(fetchCalls[0]?.url).toBe("https://capybara.example.com/team/api/v1/app-auth/token");
  });
});

describe("cancel() and restarts", () => {
  test("cancel ends the waiting attempt as cancelled; its link then does nothing", async () => {
    const { signIn, fetchCalls, timers } = setup();
    const { outcome } = signIn.begin(profile);
    signIn.cancel("p1");
    await expect(outcome).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(timers[0]?.cancelled).toBe(true);
    expect(signIn.pendingUrl("p1")).toBeUndefined();
    await signIn.handleCallback(callback({}));
    expect(fetchCalls).toHaveLength(0);
    // Idempotent, and a profile without an attempt is fine.
    signIn.cancel("p1");
    signIn.cancel("nobody");
  });

  test("cancel leaves other profiles' attempts alone", async () => {
    const { signIn } = setup();
    const a = signIn.begin(profile);
    const b = signIn.begin(other);
    signIn.cancel("p2");
    await expect(b.outcome).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(signIn.pendingUrl("p1")).toBe(a.url);
    await signIn.handleCallback(callback({ state: "state-1" }));
    await expect(a.outcome).resolves.toMatchObject({ ok: true });
  });

  test("cancel while the exchange runs: cancelled stands, and signIn@1 reloads nothing", async () => {
    const { signIn, deps, onSignedIn } = setup();
    let finish: (r: ResponseLike) => void = () => undefined;
    deps.fetchFor = () => () => new Promise((r) => (finish = r));
    const result = signIn.capability.start({ profile });
    await flush();
    const handled = signIn.handleCallback(callback({}));
    await flush();
    signIn.cancel("p1");
    finish(okResponse());
    await handled;
    await expect(result).resolves.toBe("cancelled");
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test("a second begin cancels the first; the first link cannot touch the second", async () => {
    const { signIn, fetchCalls, timers } = setup();
    const stale = vi.fn();
    signIn.onStaleCallback(stale);
    const first = signIn.begin(profile);
    const second = signIn.begin(profile);
    await expect(first.outcome).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(timers[0]?.cancelled).toBe(true);
    expect(timers[1]?.cancelled).toBe(false);
    expect(second.url).not.toBe(first.url);
    expect(signIn.pendingUrl("p1")).toBe(second.url);
    expect(signIn.pendingCount()).toBe(1);
    await signIn.handleCallback(callback({ state: "state-1" }));
    expect(fetchCalls).toHaveLength(0);
    expect(stale).toHaveBeenCalledExactlyOnceWith("https://capybara.example.com");
    expect(signIn.pendingUrl("p1")).toBe(second.url);
    await signIn.handleCallback(callback({ state: "state-2" }));
    await expect(second.outcome).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(fetchCalls[0]?.init.body as string).codeVerifier).toBe("verifier-2");
  });

  test("a begin while the first exchange runs cancels the first", async () => {
    const { signIn, deps } = setup();
    let finish: (r: ResponseLike) => void = () => undefined;
    deps.fetchFor = () => () => new Promise((r) => (finish = r));
    const first = signIn.begin(profile);
    const handled = signIn.handleCallback(callback({}));
    await flush();
    const second = signIn.begin(profile);
    await expect(first.outcome).resolves.toEqual({ ok: false, reason: "cancelled" });
    finish(okResponse());
    await handled;
    expect(signIn.pendingUrl("p1")).toBe(second.url);
  });

  test("begin and signIn@1 share one attempt per profile", async () => {
    const { signIn } = setup();
    const fromPage = signIn.capability.start({ profile });
    await flush();
    const own = signIn.begin(profile);
    await expect(fromPage).resolves.toBe("cancelled");
    expect(signIn.pendingCount()).toBe(1);
    signIn.cancel("p1");
    await expect(own.outcome).resolves.toEqual({ ok: false, reason: "cancelled" });
  });
});

describe("replays and stale callbacks", () => {
  test("duplicate deliveries during the exchange: one exchange, not reported as stale", async () => {
    const { signIn, fetchCalls } = setup();
    const stale = vi.fn();
    signIn.onStaleCallback(stale);
    const { outcome } = signIn.begin(profile);
    const cb = callback({});
    await Promise.all([signIn.handleCallback(cb), signIn.handleCallback(cb)]);
    await expect(outcome).resolves.toMatchObject({ ok: true });
    expect(fetchCalls).toHaveLength(1);
    expect(stale).not.toHaveBeenCalled();
    // After the attempt ended, the same link is stale.
    await signIn.handleCallback(cb);
    expect(fetchCalls).toHaveLength(1);
    expect(stale).toHaveBeenCalledExactlyOnceWith("https://capybara.example.com");
  });

  test("an unknown state: the issuer's origin to listeners; no request, no attempt touched", async () => {
    const { signIn, fetchCalls, opened, timers, log } = setup();
    const stale = vi.fn();
    signIn.onStaleCallback(stale);
    const { outcome, url } = signIn.begin(profile);
    await signIn.handleCallback(callback({ state: "old-state" }));
    await signIn.handleCallback(callback({ state: "old-state", error: "access_denied" }));
    expect(stale.mock.calls).toEqual([
      ["https://capybara.example.com"],
      ["https://capybara.example.com"],
    ]);
    expect(fetchCalls).toHaveLength(0);
    expect(opened).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
    expect(timers[0]?.cancelled).toBe(false);
    expect(signIn.pendingUrl("p1")).toBe(url);
    await signIn.handleCallback(callback({}));
    await expect(outcome).resolves.toMatchObject({ ok: true });
  });

  test("a stale callback for another deployment does not touch a pending attempt", async () => {
    const { signIn, fetchCalls } = setup();
    const stale = vi.fn();
    signIn.onStaleCallback(stale);
    const a = signIn.begin(profile);
    await signIn.handleCallback(callback({ state: "x", iss: "https://other.example.com:8443/p" }));
    expect(stale).toHaveBeenCalledExactlyOnceWith("https://other.example.com:8443");
    expect(fetchCalls).toHaveLength(0);
    expect(signIn.pendingUrl("p1")).toBe(a.url);
  });

  test("stale with no attempts at all still reports the origin", async () => {
    const { signIn } = setup();
    const stale = vi.fn();
    signIn.onStaleCallback(stale);
    await signIn.handleCallback(callback({ state: "x", iss: "http://localhost:3000" }));
    expect(stale).toHaveBeenCalledExactlyOnceWith("http://localhost:3000");
  });

  test.each([
    ["javascript:alert(1)"],
    ["capybara://auth/callback"],
    ["file:///etc/passwd"],
    ["not a url"],
    [""],
    [`https://capybara.example.com/${"x".repeat(2100)}`],
  ])("an iss that is not an http(s) URL is not reported: %s", async (iss) => {
    const { signIn } = setup();
    const stale = vi.fn();
    signIn.onStaleCallback(stale);
    await signIn.handleCallback(callback({ state: "x", iss: iss.slice(0, 2200) }));
    expect(stale).not.toHaveBeenCalled();
  });

  test("credentials in the iss never reach the listener", async () => {
    const { signIn } = setup();
    const stale = vi.fn();
    signIn.onStaleCallback(stale);
    await signIn.handleCallback(
      callback({ state: "x", iss: "https://user:pw@capybara.example.com/t" }),
    );
    expect(stale).toHaveBeenCalledExactlyOnceWith("https://capybara.example.com");
  });

  test("unsubscribing stops the calls; a throwing listener stops nobody", async () => {
    const { signIn, log } = setup();
    const broken = vi.fn(() => {
      throw new Error("boom");
    });
    const kept = vi.fn();
    const dropped = vi.fn();
    signIn.onStaleCallback(broken);
    signIn.onStaleCallback(kept);
    const off = signIn.onStaleCallback(dropped);
    off();
    off();
    await expect(signIn.handleCallback(callback({ state: "x" }))).resolves.toBeUndefined();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("boom");
  });
});

describe("no tokens are kept", () => {
  const ALLOWED = [
    "appVersion",
    "fetchFor",
    "getProfile",
    "log",
    "machineName",
    "newState",
    "now",
    "onSignedIn",
    "openExternal",
    "pkce",
    "schedule",
    "timeoutSignal",
  ];

  test("the exchange touches no store, and nothing token-bearing leaves it", async () => {
    const accessed = new Set<string>();
    const { deps, log, onSignedIn } = setup();
    const watched = new Proxy(deps, {
      get(target, key, receiver) {
        accessed.add(String(key));
        return Reflect.get(target, key, receiver);
      },
    });
    const signIn = createSignIn(watched);
    const result = signIn.capability.start({ profile });
    await flush();
    await signIn.handleCallback(callback({}));
    const value = await result;
    expect(value).toBe("signedIn");
    // The module reaches the world only through these; none of them persists anything.
    for (const key of accessed) expect(ALLOWED).toContain(key);
    expect(JSON.stringify([log.mock.calls, onSignedIn.mock.calls, value])).not.toContain("SECRET");
  });

  test("begin's outcome carries nothing token-bearing", async () => {
    const { signIn, log } = setup();
    const { outcome } = signIn.begin(profile);
    await signIn.handleCallback(callback({}));
    const value = await outcome;
    expect(JSON.stringify([value, log.mock.calls])).not.toMatch(/SECRET|cap_ac_1|verifier/);
  });

  test("signIn@1 rejects failed for every refusal that is not a cancel", async () => {
    for (const code of ["auth.account_disabled", "app_auth.redirect_uri_invalid", "x.y"]) {
      const { signIn, fetchImpl, onSignedIn } = setup();
      fetchImpl.mockResolvedValueOnce(refusal(403, code));
      const result = signIn.capability.start({ profile });
      await flush();
      await signIn.handleCallback(callback({}));
      await expect(result).rejects.toEqual({ code: "failed" });
      expect(onSignedIn).not.toHaveBeenCalled();
    }
  });

  test("the module imports no storage (fs, Electron safeStorage, a keychain)", () => {
    const source = readFileSync(new URL("../src/main/sign-in.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      "../../brand.ts",
      "./ipc.ts",
      "./profiles.ts",
      "./user-agent.ts",
      "@capybara-hq/shell",
      "node:crypto",
    ]);
    expect(source).not.toMatch(/safeStorage|keytar|localStorage|writeFile/);
  });

  test("the capability takes the calling profile from the context", async () => {
    const { signIn, opened } = setup();
    void signIn.capability.start({ profile: other });
    await flush();
    expect(opened[0]).toMatch(/^https:\/\/other\.example\.com\/apps\/authorize\?/);
  });
});

describe("machineNameFrom", () => {
  test("trims, drops control characters and the .local suffix, caps at 64", () => {
    expect(machineNameFrom("  Grants-MacBook-Pro.local ")).toBe("Grants-MacBook-Pro");
    expect(machineNameFrom("a\u0000b\nc\u007f")).toBe("abc");
    expect(machineNameFrom("x".repeat(100))).toHaveLength(64);
    expect(machineNameFrom("")).toBe("Desktop");
    expect(machineNameFrom("\u0001\u0002")).toBe("Desktop");
  });

  test("the app version is capped at 32 characters", async () => {
    const { signIn, opened } = setup({ appVersion: "1".repeat(40) });
    void signIn.capability.start({ profile });
    await flush();
    expect(new URL(opened[0] as string).searchParams.get("app_version")).toBe("1".repeat(32));
  });
});
