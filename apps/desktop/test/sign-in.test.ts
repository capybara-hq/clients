import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { brand } from "../brand.ts";
import type { Profile } from "../src/main/profiles.ts";
import { createSignIn, REDIRECT_URI, type SignInDeps } from "../src/main/sign-in.ts";
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
  account: { id: "a1" },
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

describe("start()", () => {
  test("opens the system browser at the authorize page under the profile base", async () => {
    const { signIn, opened } = setup();
    void signIn.start(profile);
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
    void signIn.start(profile);
    await flush();
    expect(opened[0]).not.toContain("verifier");
  });

  test("defaults: real PKCE and a 32-byte state", async () => {
    const { deps, opened } = setup();
    const { pkce: _pkce, newState: _newState, ...rest } = deps;
    void createSignIn(rest).start(profile);
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
    await expect(signIn.start(profile)).rejects.toEqual({ code: "failed" });
    expect(signIn.pendingCount()).toBe(0);
  });
});

describe("the callback", () => {
  test("a matching state and iss: one exchange through the profile session, then signedIn", async () => {
    const { signIn, fetchCalls, onSignedIn } = setup();
    const result = signIn.start(profile);
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
    const result = signIn.start(profile);
    await flush();
    await signIn.handleCallback(callback({ iss: "https://capybara.example.com/team/" }));
    await expect(result).resolves.toBe("signedIn");
    expect(fetchCalls).toHaveLength(1);
  });

  test("an unknown state: no exchange, and the pending attempt stays", async () => {
    const { signIn, fetchCalls } = setup();
    const result = signIn.start(profile);
    await flush();
    await signIn.handleCallback(callback({ state: "someone-else" }));
    expect(fetchCalls).toHaveLength(0);
    expect(signIn.pendingCount()).toBe(1);
    await signIn.handleCallback(callback({}));
    await expect(result).resolves.toBe("signedIn");
  });

  test("a wrong iss: no exchange, the attempt is dropped and fails", async () => {
    const { signIn, fetchCalls, onSignedIn } = setup();
    const result = signIn.start(profile);
    await flush();
    await signIn.handleCallback(callback({ iss: "https://evil.example.com/team" }));
    await expect(result).rejects.toEqual({ code: "failed" });
    // The origin alone is not enough: the base path is part of the issuer.
    const second = signIn.start(profile);
    await flush();
    await signIn.handleCallback(
      callback({ state: "state-2", iss: "https://capybara.example.com" }),
    );
    await expect(second).rejects.toEqual({ code: "failed" });
    expect(fetchCalls).toHaveLength(0);
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(signIn.pendingCount()).toBe(0);
  });

  test("a callback after 10 minutes: no exchange", async () => {
    const { signIn, fetchCalls, advance } = setup();
    const result = signIn.start(profile);
    await flush();
    advance(10 * 60 * 1000 + 1);
    await signIn.handleCallback(callback({}));
    await expect(result).rejects.toEqual({ code: "failed" });
    expect(fetchCalls).toHaveLength(0);
    expect(signIn.pendingCount()).toBe(0);
  });

  test("an attempt nobody finishes ends as cancelled after 10 minutes", async () => {
    const { signIn, timers, fetchCalls } = setup();
    const result = signIn.start(profile);
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
    const result = signIn.start(profile);
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
    const result = signIn.start(profile);
    await flush();
    await signIn.handleCallback(callback({ error: "access_denied" }));
    await expect(result).resolves.toBe("cancelled");
    expect(fetchCalls).toHaveLength(0);
    expect(signIn.pendingCount()).toBe(0);
    expect(timers[0]?.cancelled).toBe(true);
  });

  test("another error with a known state fails the attempt", async () => {
    const { signIn, fetchCalls } = setup();
    const result = signIn.start(profile);
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
    const result = signIn.start(profile);
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
    const result = signIn.start(profile);
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
      const result = signIn.start(profile);
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
      const result = signIn.start(profile);
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
    const result = signIn.start(profile);
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
    const result = signIn.start(profile);
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
    const first = signIn.start(profile);
    await flush();
    const second = signIn.start(profile);
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
    const a = signIn.start(profile);
    await flush();
    const b = signIn.start(other);
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
    const result = signIn.start(profile);
    await flush();
    await signIn.handleCallback(callback({}));
    const value = await result;
    expect(value).toBe("signedIn");
    // The module reaches the world only through these; none of them persists anything.
    for (const key of accessed) expect(ALLOWED).toContain(key);
    expect(JSON.stringify([log.mock.calls, onSignedIn.mock.calls, value])).not.toContain("SECRET");
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
    void signIn.start(profile);
    await flush();
    expect(new URL(opened[0] as string).searchParams.get("app_version")).toBe("1".repeat(32));
  });
});
