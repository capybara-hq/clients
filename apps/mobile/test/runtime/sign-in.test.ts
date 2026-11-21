import { readFileSync, writeFileSync } from "node:fs";
import { SIGN_IN_TTL_MS, signInBlockRules } from "@capybara-hq/shell";
import { describe, expect, test, vi } from "vitest";
import type { HttpGetPort } from "../../src/runtime/discovery.ts";
import type { HostPort } from "../../src/runtime/host-port.ts";
import type { ShellCallMessage } from "../../src/runtime/protocol.ts";
import { createRegistry } from "../../src/runtime/registry.ts";
import {
  appInfoFrom,
  createSignIn,
  createSignInSupport,
  SIGN_IN_KEY,
  type SignInDeps,
  type SignInProfile,
  signInPortsFrom,
} from "../../src/runtime/sign-in.ts";
import { blockRulesFor, removeBlockRulesOnRemoval } from "../../src/runtime/sign-in-block.ts";

const BASE = "https://cap.example.com/team";
const ORIGIN = "https://cap.example.com";
const SCHEME = "capybara";
const REDIRECT = `${SCHEME}://auth/callback`;
const VERIFIER = "v".repeat(43);
const CHALLENGE = "c".repeat(43);

const profile: SignInProfile = { id: "p1", origin: ORIGIN, base: BASE };

function callbackUrl(q: Record<string, string>): string {
  return `${REDIRECT}?${new URLSearchParams(q).toString()}`;
}

/** A sign-in with fakes: `answer` is what the browser session returns for the URL it was given. */
function setup(
  opts: {
    answer?: (url: string) => { callback: string } | { cancelled: true };
    exchange?: { ok: boolean; status: number; hasAccount: boolean };
    profiles?: () => SignInProfile[];
    origin?: string | null;
    states?: string[];
  } = {},
) {
  let clock = 1_000_000;
  const states = [...(opts.states ?? ["s1", "s2", "s3"])];
  const startedUrls: string[] = [];
  const logs: string[] = [];
  const deps = {
    auth: {
      start: vi.fn(async (url: string, scheme: string) => {
        expect(scheme).toBe(SCHEME);
        startedUrls.push(url);
        const state = new URL(url).searchParams.get("state") ?? "";
        return opts.answer
          ? opts.answer(url)
          : { callback: callbackUrl({ code: "cap_ac_1", state, iss: BASE }) };
      }),
    },
    exchange: vi.fn(async (_profileId: string, _req: { url: string; body: string }) => {
      return opts.exchange ?? { ok: true, status: 200, hasAccount: true };
    }),
    currentOrigin: vi.fn(async (_profileId: string) =>
      opts.origin === undefined ? ORIGIN : opts.origin,
    ),
    reload: vi.fn(async (_profileId: string) => {}),
    revoke: vi.fn(async (_profileId: string, _req: { url: string }) => {}),
    deviceName: "Grant’s iPhone",
    appVersion: "0.1.0",
    now: () => clock,
    newState: () => states.shift() ?? "exhausted",
    scheme: SCHEME,
    profiles: { list: opts.profiles ?? (() => [profile]) },
    pkce: async () => ({ verifier: VERIFIER, challenge: CHALLENGE }),
    log: (message: string) => logs.push(message),
  } satisfies SignInDeps<SignInProfile>;
  const signIn = createSignIn(deps);
  const host: HostPort = {
    onCall: () => () => {},
    reply: async () => {},
    pushState: async () => {},
    event: async () => {},
  };
  const registry = createRegistry({ host, profiles: deps.profiles });
  registry.register(SIGN_IN_KEY, signIn.capability);
  let n = 0;
  const start = (activation = true) =>
    registry.dispatch({
      profileId: profile.id,
      origin: ORIGIN,
      docId: "doc-0001-aaaa",
      callId: `c${++n}`,
      key: SIGN_IN_KEY,
      fn: "start",
      args: [],
      activation,
    } satisfies ShellCallMessage);
  return {
    deps,
    signIn,
    registry,
    start,
    startedUrls,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const FAILED = { ok: false, code: "failed" };

describe("signIn@1: the happy path", () => {
  test("opens the authorize URL, exchanges the code in the profile, reloads it", async () => {
    const s = setup();
    expect(await s.start()).toEqual({ ok: true, value: "signedIn" });

    const url = new URL(s.startedUrls[0] ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/apps/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client: "mobile",
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "s1",
      name: "Grant’s iPhone",
      app_version: "0.1.0",
    });
    expect(s.deps.exchange).toHaveBeenCalledTimes(1);
    const [profileId, req] = s.deps.exchange.mock.calls[0] ?? [];
    expect(profileId).toBe("p1");
    expect(req?.url).toBe(`${BASE}/api/v1/app-auth/token`);
    expect(JSON.parse(req?.body ?? "")).toEqual({
      code: "cap_ac_1",
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
    });
    expect(Object.keys(JSON.parse(req?.body ?? ""))).toEqual([
      "code",
      "codeVerifier",
      "redirectUri",
    ]);
    expect(s.deps.reload).toHaveBeenCalledWith("p1");
  });

  test("is confirming: no user activation, no browser", async () => {
    const s = setup();
    expect(s.signIn.capability.confirming).toEqual(["start"]);
    expect(await s.start(false)).toEqual({ ok: false, code: "no_activation" });
    expect(s.deps.auth.start).not.toHaveBeenCalled();
  });

  test("one attempt at a time: a second start while one runs is busy", async () => {
    let release: (v: { cancelled: true }) => void = () => {};
    const s = setup({
      answer: () => ({ cancelled: true }),
    });
    s.deps.auth.start.mockImplementationOnce(
      () => new Promise<{ cancelled: true }>((r) => (release = r)),
    );
    const first = s.start();
    await vi.waitFor(() => expect(s.deps.auth.start).toHaveBeenCalledTimes(1));
    expect(await s.signIn.begin("p1")).toBe("busy");
    release({ cancelled: true });
    expect(await first).toEqual({ ok: true, value: "cancelled" });
  });

  test("the device name and version are cleaned before they reach the URL", async () => {
    const s = setup();
    const signIn = createSignIn({
      ...s.deps,
      deviceName: `‮${"x".repeat(100)}\n`,
      appVersion: "",
    });
    await signIn.begin("p1");
    const url = new URL(s.startedUrls[0] ?? "");
    expect(url.searchParams.get("name")).toBe("x".repeat(64));
    expect(url.searchParams.get("app_version")).toBe("0.0.0");
  });
});

describe("signIn@1: callbacks out of place are refused (no exchange, failed)", () => {
  test("a wrong state", async () => {
    const s = setup({
      answer: () => ({ callback: callbackUrl({ code: "x", state: "other", iss: BASE }) }),
    });
    expect(await s.start()).toEqual(FAILED);
    expect(s.deps.exchange).not.toHaveBeenCalled();
  });

  test("expired after SIGN_IN_TTL_MS", async () => {
    let s = setup();
    s.deps.auth.start.mockImplementationOnce(async (url: string) => {
      s.advance(SIGN_IN_TTL_MS + 1);
      const state = new URL(url).searchParams.get("state") ?? "";
      return { callback: callbackUrl({ code: "x", state, iss: BASE }) };
    });
    expect(await s.start()).toEqual(FAILED);
    expect(s.deps.exchange).not.toHaveBeenCalled();

    // Just inside the window is fine.
    s = setup();
    s.deps.auth.start.mockImplementationOnce(async (url: string) => {
      s.advance(SIGN_IN_TTL_MS);
      const state = new URL(url).searchParams.get("state") ?? "";
      return { callback: callbackUrl({ code: "x", state, iss: BASE }) };
    });
    expect(await s.start()).toEqual({ ok: true, value: "signedIn" });
  });

  test("an iss of another deployment", async () => {
    for (const iss of ["https://evil.example.com/team", "https://cap.example.com", `${BASE}x`]) {
      const s = setup({
        answer: (url) => ({
          callback: callbackUrl({
            code: "x",
            state: new URL(url).searchParams.get("state") ?? "",
            iss,
          }),
        }),
      });
      expect(await s.start(), iss).toEqual(FAILED);
      expect(s.deps.exchange).not.toHaveBeenCalled();
    }
  });

  test("a second callback with the same state (one use)", async () => {
    // A state the app already used is never accepted again, even when the new attempt draws it.
    const s = setup({ states: ["s1", "s1"] });
    expect(await s.start()).toEqual({ ok: true, value: "signedIn" });
    expect(await s.start()).toEqual(FAILED);
    expect(s.deps.exchange).toHaveBeenCalledTimes(1);
    expect(s.deps.auth.start).toHaveBeenCalledTimes(1);
  });

  test("a replayed callback of an earlier attempt", async () => {
    const s = setup();
    expect(await s.start()).toEqual({ ok: true, value: "signedIn" });
    const first = callbackUrl({ code: "cap_ac_1", state: "s1", iss: BASE });
    s.deps.auth.start.mockImplementationOnce(async () => ({ callback: first }));
    expect(await s.start()).toEqual(FAILED);
    expect(s.deps.exchange).toHaveBeenCalledTimes(1);
  });

  test("a callback after the profile was removed", async () => {
    let list: SignInProfile[] = [profile];
    const s = setup({ profiles: () => list });
    s.deps.auth.start.mockImplementationOnce(async (url: string) => {
      list = [];
      const state = new URL(url).searchParams.get("state") ?? "";
      return { callback: callbackUrl({ code: "x", state, iss: BASE }) };
    });
    // The registry answers for the profile it found at the call; the attempt itself fails.
    expect(await s.start()).toEqual(FAILED);
    expect(s.deps.exchange).not.toHaveBeenCalled();
  });

  test("a callback after the profile was re-pointed to another base", async () => {
    let list: SignInProfile[] = [profile];
    const s = setup({ profiles: () => list });
    s.deps.auth.start.mockImplementationOnce(async (url: string) => {
      list = [{ ...profile, base: ORIGIN }];
      const state = new URL(url).searchParams.get("state") ?? "";
      return { callback: callbackUrl({ code: "x", state, iss: BASE }) };
    });
    expect(await s.start()).toEqual(FAILED);
    expect(s.deps.exchange).not.toHaveBeenCalled();
  });

  test("the profile WebView is off its origin", async () => {
    for (const origin of ["https://idp.example", null, "https://cap.example.com:444"]) {
      const s = setup({ origin });
      expect(await s.start(), String(origin)).toEqual(FAILED);
      expect(s.deps.exchange).not.toHaveBeenCalled();
      expect(s.deps.reload).not.toHaveBeenCalled();
    }
  });

  test("a callback link that does not parse, or of another scheme", async () => {
    for (const callback of [
      "capybara://auth/other?code=x&state=s1&iss=x",
      "https://cap.example.com/auth/callback?code=x&state=s1",
      "evil://auth/callback?code=x&state=s1&iss=https%3A%2F%2Fcap.example.com%2Fteam",
      "not a url",
    ]) {
      const s = setup({ answer: () => ({ callback }) });
      expect(await s.start(), callback).toEqual(FAILED);
      expect(s.deps.exchange).not.toHaveBeenCalled();
    }
  });
});

describe("signIn@1: cancel and errors", () => {
  test("a dismissed sheet is cancelled (also an Android resume without a callback)", async () => {
    const s = setup({ answer: () => ({ cancelled: true }) });
    expect(await s.start()).toEqual({ ok: true, value: "cancelled" });
    expect(s.deps.exchange).not.toHaveBeenCalled();
  });

  test("access_denied on the consent page is cancelled; another error fails", async () => {
    const denied = setup({
      answer: (url) => ({
        callback: callbackUrl({
          error: "access_denied",
          state: new URL(url).searchParams.get("state") ?? "",
          iss: BASE,
        }),
      }),
    });
    expect(await denied.start()).toEqual({ ok: true, value: "cancelled" });
    const other = setup({
      answer: (url) => ({
        callback: callbackUrl({
          error: "server_error",
          state: new URL(url).searchParams.get("state") ?? "",
          iss: BASE,
        }),
      }),
    });
    expect(await other.start()).toEqual(FAILED);
    expect(denied.deps.exchange).not.toHaveBeenCalled();
    expect(other.deps.exchange).not.toHaveBeenCalled();
  });

  test("the browser could not be opened", async () => {
    const s = setup();
    s.deps.auth.start.mockRejectedValueOnce(new Error("no window"));
    expect(await s.start()).toEqual(FAILED);
  });

  test("an exchange refused fails and logs only the status", async () => {
    const s = setup({ exchange: { ok: false, status: 400, hasAccount: false } });
    expect(await s.start()).toEqual(FAILED);
    expect(s.deps.reload).not.toHaveBeenCalled();
    expect(s.logs).toEqual(["sign-in exchange refused (400)"]);
    const text = s.logs.join("\n");
    for (const secret of ["cap_ac_1", VERIFIER, "s1"]) expect(text).not.toContain(secret);
  });

  test("an exchange that answers without an account, or throws, fails", async () => {
    const noAccount = setup({ exchange: { ok: true, status: 200, hasAccount: false } });
    expect(await noAccount.start()).toEqual(FAILED);
    expect(noAccount.deps.reload).not.toHaveBeenCalled();
    // The kernel answered 2xx, so a session cookie may be set: it is logged out (as the desktop).
    expect(noAccount.deps.revoke).toHaveBeenCalledWith("p1", { url: `${BASE}/api/v1/auth/logout` });
    const throws = setup();
    throws.deps.exchange.mockRejectedValueOnce(new Error("timeout cap_ac_1"));
    expect(await throws.start()).toEqual(FAILED);
    expect(throws.logs.join("\n")).not.toContain("cap_ac_1");
    expect(throws.deps.revoke).not.toHaveBeenCalled();
    // A failing logout still ends in failed.
    const revokeFails = setup({ exchange: { ok: true, status: 200, hasAccount: false } });
    revokeFails.deps.revoke.mockRejectedValueOnce(new Error("x"));
    expect(await revokeFails.start()).toEqual(FAILED);
  });

  test("a refused exchange logs nothing out", async () => {
    const s = setup({ exchange: { ok: false, status: 400, hasAccount: false } });
    await s.start();
    expect(s.deps.revoke).not.toHaveBeenCalled();
  });

  test("a later attempt works after a failed one", async () => {
    const s = setup();
    s.deps.auth.start.mockImplementationOnce(async () => ({ cancelled: true }));
    expect(await s.start()).toEqual({ ok: true, value: "cancelled" });
    expect(await s.start()).toEqual({ ok: true, value: "signedIn" });
  });
});

describe("begin: the address page's sign-in", () => {
  test("signs the stored profile in without a page call", async () => {
    const s = setup();
    expect(await s.signIn.begin("p1")).toBe("signedIn");
    expect(s.deps.exchange).toHaveBeenCalledTimes(1);
  });

  test("an unknown profile starts nothing", async () => {
    const s = setup();
    expect(await s.signIn.begin("nope")).toBe("failed");
    expect(s.deps.auth.start).not.toHaveBeenCalled();
  });
});

describe("too old: a deployment whose meta lacks appSignIn", () => {
  const meta = (features: Record<string, unknown>) =>
    JSON.stringify({
      name: "Cap",
      icon: null,
      protocols: { device: { min: 1, max: 1 } },
      features,
    });
  const port = (body: string): HttpGetPort => ({
    get: async () => ({ status: 200, body }),
  });

  test("gets the too-old state and signIn@1 is not offered", async () => {
    const tooOld = vi.fn();
    const support = createSignInSupport({
      httpGet: port(meta({ localDevices: true })),
      onTooOld: tooOld,
    });
    expect(support.available(profile)).toBe(true);
    expect(await support.check(profile)).toBe("too_old");
    expect(tooOld).toHaveBeenCalledWith("p1");
    expect(support.available(profile)).toBe(false);

    const s = setup();
    s.registry.register(SIGN_IN_KEY, s.signIn.capability, {
      available: (p) => support.available(p),
    });
    expect(Object.keys(s.registry.descriptors(profile).capabilities)).not.toContain(SIGN_IN_KEY);
    expect(await s.start()).toEqual(FAILED);
    expect(s.deps.auth.start).not.toHaveBeenCalled();
  });

  test("a current deployment keeps it; an unreachable one changes nothing", async () => {
    const tooOld = vi.fn();
    const ok = createSignInSupport({
      httpGet: port(meta({ localDevices: true, appSignIn: true })),
      onTooOld: tooOld,
    });
    expect(await ok.check(profile)).toBe("ok");
    expect(ok.available(profile)).toBe(true);
    const down = createSignInSupport({
      httpGet: { get: async () => Promise.reject(new Error("unreachable")) },
      onTooOld: tooOld,
    });
    expect(await down.check(profile)).toBe("unknown");
    expect(down.available(profile)).toBe(true);
    expect(tooOld).not.toHaveBeenCalled();
  });

  test("hands each meta it reads to onMeta (push reads features.push from it)", async () => {
    const onMeta = vi.fn();
    const push = [{ appId: "com.example.app", providers: ["push-apns"] }];
    const support = createSignInSupport({
      httpGet: port(meta({ localDevices: true, appSignIn: true, push })),
      onTooOld: () => {},
      onMeta,
    });
    await support.check(profile);
    expect(onMeta).toHaveBeenCalledWith(
      profile,
      expect.objectContaining({ features: expect.objectContaining({ push }) }),
    );
  });

  test("a too-old or unreadable meta hands onMeta null", async () => {
    const onMeta = vi.fn();
    const old = createSignInSupport({
      httpGet: port(meta({ localDevices: true })),
      onTooOld: () => {},
      onMeta,
    });
    await old.check(profile);
    const down = createSignInSupport({
      httpGet: { get: async () => Promise.reject(new Error("unreachable")) },
      onTooOld: () => {},
      onMeta,
    });
    await down.check(profile);
    expect(onMeta.mock.calls).toEqual([
      [profile, null],
      [profile, null],
    ]);
  });

  test("an upgraded deployment is offered again", async () => {
    let body = meta({ localDevices: true });
    const support = createSignInSupport({
      httpGet: { get: async () => ({ status: 200, body }) },
      onTooOld: () => {},
    });
    await support.check(profile);
    body = meta({ localDevices: true, appSignIn: true });
    await support.check(profile);
    expect(support.available(profile)).toBe(true);
  });
});

// ---- The in-WebView block: the rules native gets, and the loopback fixture XCTest loads ----

describe("blockRulesFor", () => {
  test("is the shell's rules as JSON for the profile's base", () => {
    expect(JSON.parse(blockRulesFor(BASE))).toEqual(signInBlockRules(BASE));
    expect(JSON.parse(blockRulesFor(BASE)).length).toBeGreaterThan(0);
  });

  test("refuses a base that yields no rules (fail closed)", () => {
    expect(() => blockRulesFor("not a url")).toThrow();
  });
});

interface Vector {
  method: string;
  url: string;
  base: string;
  blocked: boolean;
  iosBlocksAnyMethod?: boolean;
}

/**
 * The deployment's host in the loopback fixture; XCTest and the Android device test swap it for
 * `127.0.0.1:<port>`.
 */
const LOOPBACK = "siblocal";
/** Any other origin; XCTest swaps it for `localhost:<port>` (same server, another origin). */
const OTHER = "sibother";

const AUTHORITY = /^([A-Za-z][A-Za-z0-9+.-]*):[/\\]*([^/\\?#]*)/;

/** `url` with its scheme and host:port replaced, everything after (raw path, query) kept as written. */
function remap(url: string, host: string): string | null {
  const m = AUTHORITY.exec(url);
  if (!m) return null;
  const authority = m[2] ?? "";
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at + 1) : "";
  return `http://${userinfo}${host}${url.slice(m[0].length)}`;
}

function loopbackFixture() {
  const vectors = JSON.parse(
    readFileSync(
      new URL("../../../../packages/shell/test/fixtures/in-window-sign-in.json", import.meta.url),
      "utf8",
    ),
  ) as Vector[];
  const bases = new Map<string, unknown>();
  const cases: {
    url: string;
    base: string;
    method: string;
    blocked: boolean;
    guard: boolean;
    from: string;
  }[] = [];
  for (const v of vectors) {
    let target: URL;
    let home: URL;
    try {
      target = new URL(v.url);
      home = new URL(v.base);
    } catch {
      continue;
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") continue;
    const base = remap(v.base, LOOPBACK);
    const url = remap(v.url, target.origin === home.origin ? LOOPBACK : OTHER);
    if (!base || !url) continue;
    if (!bases.has(base)) bases.set(base, signInBlockRules(base));
    cases.push({
      url,
      base,
      method: v.method,
      // iOS rules know no method; Android's guard (shouldInterceptRequest) does.
      blocked: v.blocked || v.iosBlocksAnyMethod === true,
      guard: v.blocked,
      from: `${v.method} ${v.url} on ${v.base}`,
    });
  }
  return { loopbackHost: LOOPBACK, otherHost: OTHER, rules: Object.fromEntries(bases), cases };
}

describe("the loopback block fixture (SignInBlockTests.swift, SignInBlockPageTest.kt)", () => {
  const path = new URL("../fixtures/sign-in-block.json", import.meta.url);
  const fixture = loopbackFixture();

  test("is in sync with the shell's vectors and rules (UPDATE_FIXTURES=1 rewrites it)", () => {
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(path, text);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(fixture.cases.length).toBeGreaterThan(130);
  });

  test("the remapped rules decide every case as the original vector says (emulated)", () => {
    for (const c of fixture.cases) {
      const rules = fixture.rules[c.base] as { trigger: { "url-filter": string } }[];
      const href = new URL(c.url).href;
      const got = rules.some((r) => new RegExp(r.trigger["url-filter"], "i").test(href));
      expect(got, c.from).toBe(c.blocked);
    }
  });

  test("the placeholders appear only as hosts", () => {
    for (const [base, rules] of Object.entries(fixture.rules)) {
      expect(new URL(base).host).toBe(LOOPBACK);
      const text = JSON.stringify(rules);
      expect(text.split(LOOPBACK).length - 1).toBe((rules as unknown[]).length);
      expect(text).not.toContain(OTHER);
    }
  });
});

describe("the plugin adapter", () => {
  const native = (answers: Record<string, unknown>) => ({
    signInStart: vi.fn(async () => answers.start),
    signInExchange: vi.fn(async () => answers.exchange),
    currentOrigin: vi.fn(async () => answers.origin),
    reload: vi.fn(async () => {}),
    signInRevoke: vi.fn(async () => {}),
    appInfo: vi.fn(async () => answers.info),
  });

  test("passes well-formed answers through", async () => {
    const n = native({
      start: { callback: "capybara://auth/callback?x" },
      exchange: { ok: true, status: 200, hasAccount: true },
      origin: { origin: ORIGIN },
      info: { deviceName: "iPhone", appVersion: "1.2.3" },
    });
    const ports = signInPortsFrom(n);
    expect(await ports.auth.start("https://x", SCHEME)).toEqual({
      callback: "capybara://auth/callback?x",
    });
    expect(n.signInStart).toHaveBeenCalledWith({ url: "https://x", scheme: SCHEME });
    expect(await ports.exchange("p1", { url: "u", body: "b" })).toEqual({
      ok: true,
      status: 200,
      hasAccount: true,
    });
    expect(n.signInExchange).toHaveBeenCalledWith({ profileId: "p1", url: "u", body: "b" });
    expect(await ports.currentOrigin("p1")).toBe(ORIGIN);
    await ports.revoke("p1", { url: "u" });
    expect(n.signInRevoke).toHaveBeenCalledWith({ profileId: "p1", url: "u" });
    expect(await appInfoFrom(n)).toEqual({ deviceName: "iPhone", appVersion: "1.2.3" });
  });

  test("a malformed answer never reads as success", async () => {
    const n = native({ start: {}, exchange: { ok: "yes" }, origin: {}, info: null });
    const ports = signInPortsFrom(n);
    await expect(ports.auth.start("https://x", SCHEME)).rejects.toThrow();
    expect(await ports.exchange("p1", { url: "u", body: "b" })).toEqual({
      ok: false,
      status: 0,
      hasAccount: false,
    });
    expect(await ports.currentOrigin("p1")).toBeNull();
    expect(await appInfoFrom(n)).toEqual({ deviceName: "", appVersion: "" });
    expect(await ports.auth.start.call(null, "https://x", SCHEME).catch(() => "rejected")).toBe(
      "rejected",
    );
    expect(
      await signInPortsFrom(native({ start: { cancelled: true } })).auth.start("https://x", SCHEME),
    ).toEqual({ cancelled: true });
  });
});

describe("removed profiles drop their block rules (M9)", () => {
  test("the store's removal asks native to delete the profile's rule list", async () => {
    let listener: ((p: { id: string }) => void | Promise<void>) | undefined;
    const store = {
      onRemoved: (l: (p: { id: string }) => void | Promise<void>) => {
        listener = l;
        return () => {};
      },
    };
    const native = { removeBlockRules: vi.fn(async (_o: { profileId: string }) => {}) };
    removeBlockRulesOnRemoval(store, native);
    await listener?.({ id: "p9" });
    expect(native.removeBlockRules).toHaveBeenCalledWith({ profileId: "p9" });
    native.removeBlockRules.mockRejectedValueOnce(new Error("x"));
    await expect(Promise.resolve(listener?.({ id: "p8" }))).resolves.toBeUndefined();
  });
});

describe("no code or verifier in the bridge's logs (M4)", () => {
  test("Capacitor logs nothing, debug builds included", async () => {
    const config = (await import("../../capacitor.config.ts")).default;
    expect(config.loggingBehavior).toBe("none");
  });
});
