import { describe, expect, test, vi } from "vitest";
import { appSignInBlocked, discover, fetchMeta, META_TIMEOUT_MS, type Meta } from "../src/meta.ts";
import { startFakeDeployment } from "./fixtures/fake-deployment.ts";

const good = {
  name: "Acme",
  icon: "/icon.png",
  protocols: { device: { min: 3, max: 3 } },
  features: { localDevices: true, appSignIn: true },
};

function fake(res: () => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return res();
  }) as typeof fetch;
  return { fn, calls };
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("fetchMeta", () => {
  test("returns the meta and asks without caching", async () => {
    const f = fake(() => json(good));
    expect(await fetchMeta("https://x.example/p", f.fn)).toEqual(good);
    expect(f.calls[0]?.url).toBe("https://x.example/p/api/v1/meta");
    expect(f.calls[0]?.init?.cache).toBe("no-store");
  });
  test("accepts null name and icon", async () => {
    const f = fake(() => json({ ...good, name: null, icon: null }));
    expect(await fetchMeta("https://x.example", f.fn)).toMatchObject({ name: null, icon: null });
  });
  test("network error is unreachable", async () => {
    const f = fake(() => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchMeta("https://x.example", f.fn)).toEqual({ error: "unreachable" });
  });
  test("non-2xx, non-JSON and shape mismatch are not_capybara", async () => {
    expect(await fetchMeta("https://x", fake(() => json({}, 404)).fn)).toEqual({
      error: "not_capybara",
    });
    expect(await fetchMeta("https://x", fake(() => new Response("<html>")).fn)).toEqual({
      error: "not_capybara",
    });
    expect(await fetchMeta("https://x", fake(() => json({ ...good, protocols: {} })).fn)).toEqual({
      error: "not_capybara",
    });
    expect(await fetchMeta("https://x", fake(() => json(null)).fn)).toEqual({
      error: "not_capybara",
    });
  });
  test("appSignIn false is sign_in_unavailable (no http.publicUrl on the deployment)", async () => {
    const f = fake(() => json({ ...good, features: { localDevices: true, appSignIn: false } }));
    expect(await fetchMeta("https://x", f.fn)).toEqual({ error: "sign_in_unavailable" });
  });
  test("features without appSignIn (an older kernel) is too_old", async () => {
    const f = fake(() => json({ ...good, features: { localDevices: true } }));
    expect(await fetchMeta("https://x", f.fn)).toEqual({ error: "too_old" });
  });
  test("a non-boolean appSignIn is not_capybara", async () => {
    const f = fake(() => json({ ...good, features: { localDevices: true, appSignIn: "yes" } }));
    expect(await fetchMeta("https://x", f.fn)).toEqual({ error: "not_capybara" });
  });
  test("exposes icons; each may be null; a meta without icons stays valid", async () => {
    const icons = { app: "/icon/app?v=1", maskable: null, favicon: "/icon/favicon?v=2" };
    const withIcons = await fetchMeta("https://x", fake(() => json({ ...good, icons })).fn);
    expect(withIcons).toEqual({ ...good, icons });
    const nulls = { app: null, maskable: null, favicon: null };
    expect(await fetchMeta("https://x", fake(() => json({ ...good, icons: nulls })).fn)).toEqual({
      ...good,
      icons: nulls,
    });
    const without = await fetchMeta("https://x", fake(() => json(good)).fn);
    expect(without).toEqual(good);
    expect(without).not.toHaveProperty("icons");
  });
  test("a malformed icons field is ignored (forward compatible); the meta stays valid", async () => {
    for (const icons of [
      null,
      "x",
      [],
      { app: 1, maskable: null, favicon: null },
      { app: null, maskable: null },
      { app: null, maskable: {}, favicon: null },
    ]) {
      const meta = await fetchMeta("https://x", fake(() => json({ ...good, icons })).fn);
      expect(meta).toEqual(good);
      expect(meta).not.toHaveProperty("icons");
    }
  });
  test("never follows redirects and has a timeout signal", async () => {
    const f = fake(() => json(good));
    await fetchMeta("https://x", f.fn);
    expect(f.calls[0]?.init?.redirect).toBe("error");
    expect(f.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    const redirected = (async (_u: unknown, init?: RequestInit) => {
      if (init?.redirect === "error") throw new TypeError("redirect mode is set to error");
      return json(good);
    }) as typeof fetch;
    expect(await fetchMeta("https://x", redirected)).toEqual({ error: "unreachable" });
  });
  test("a stalled server is unreachable once the signal aborts", async () => {
    const stalled = ((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    const ctl = new AbortController();
    const p = fetchMeta("https://x", stalled, ctl.signal);
    ctl.abort();
    expect(await p).toEqual({ error: "unreachable" });
  });
  test("an oversized body is not_capybara", async () => {
    const big = JSON.stringify({ ...good, name: "a".repeat(70 * 1024) });
    expect(await fetchMeta("https://x", fake(() => new Response(big)).fn)).toEqual({
      error: "not_capybara",
    });
  });
  test("non-integer protocol bounds are not_capybara", async () => {
    const bad = { ...good, protocols: { device: { min: 1.5, max: 3 } } };
    expect(await fetchMeta("https://x", fake(() => json(bad)).fn)).toEqual({
      error: "not_capybara",
    });
  });
});

describe("appRedirectUris", () => {
  test("an array of strings is parsed, anything else is dropped", async () => {
    const uris = ["capybara://auth/callback"];
    const ok = await fetchMeta(
      "https://x",
      fake(() => json({ ...good, appRedirectUris: uris })).fn,
    );
    expect(ok).toMatchObject({ appRedirectUris: uris });
    for (const bad of ["x", [1], null]) {
      const r = await fetchMeta(
        "https://x",
        fake(() => json({ ...good, appRedirectUris: bad })).fn,
      );
      expect(r).not.toHaveProperty("appRedirectUris");
    }
  });
});

describe("discover", () => {
  const certErr = (msg: string, cause = false) =>
    (async () => {
      const e = new TypeError("fetch failed");
      if (cause) (e as { cause?: unknown }).cause = new Error(msg);
      else e.message = msg;
      throw e;
    }) as typeof fetch;

  test("returns base and meta", async () => {
    const r = await discover("x.example/p/", fake(() => json(good)).fn);
    expect(r).toMatchObject({ ok: true, base: "https://x.example/p", meta: { name: "Acme" } });
  });
  test("plain http to a remote host is not_https, without a request", async () => {
    const f = fake(() => json(good));
    expect(await discover("http://x.example", f.fn)).toEqual({ ok: false, error: "not_https" });
    expect(f.calls).toHaveLength(0);
  });
  test("loopback http is fine", async () => {
    expect(await discover("http://localhost:3000", fake(() => json(good)).fn)).toMatchObject({
      ok: true,
    });
  });
  test("an unparseable address is not_capybara", async () => {
    expect(await discover("", fake(() => json(good)).fn)).toEqual({
      ok: false,
      error: "not_capybara",
    });
  });
  test("certificate errors in the message or the cause are cert_invalid", async () => {
    expect(await discover("x.example", certErr("net::ERR_CERT_AUTHORITY_INVALID"))).toEqual({
      ok: false,
      error: "cert_invalid",
    });
    expect(await discover("x.example", certErr("CERT_HAS_EXPIRED", true))).toEqual({
      ok: false,
      error: "cert_invalid",
    });
  });
  test("other network errors are unreachable", async () => {
    expect(await discover("x.example", certErr("ECONNREFUSED"))).toEqual({
      ok: false,
      error: "unreachable",
    });
  });
  test("a stalled server is unreachable after the 10 s timeout", async () => {
    const timer = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
    try {
      const stalled = ((_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(new DOMException("timed out", "TimeoutError")),
          );
        })) as typeof fetch;
      const p = discover("x.example", stalled);
      timer.abort();
      expect(await p).toEqual({ ok: false, error: "unreachable" });
      expect(spy).toHaveBeenCalledWith(META_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });
  test("non-2xx, non-JSON and shape mismatch are not_capybara", async () => {
    expect(await fetchMeta("https://x", fake(() => json({}, 404)).fn)).toEqual({
      error: "not_capybara",
    });
    expect(await fetchMeta("https://x", fake(() => new Response("<html>")).fn)).toEqual({
      error: "not_capybara",
    });
    expect(await fetchMeta("https://x", fake(() => json({ ...good, protocols: {} })).fn)).toEqual({
      error: "not_capybara",
    });
    expect(await fetchMeta("https://x", fake(() => json(null)).fn)).toEqual({
      error: "not_capybara",
    });
  });
  test("appSignIn false is sign_in_unavailable (no http.publicUrl on the deployment)", async () => {
    const f = fake(() => json({ ...good, features: { localDevices: true, appSignIn: false } }));
    expect(await fetchMeta("https://x", f.fn)).toEqual({ error: "sign_in_unavailable" });
  });
  test("features without appSignIn (an older kernel) is too_old", async () => {
    const f = fake(() => json({ ...good, features: { localDevices: true } }));
    expect(await fetchMeta("https://x", f.fn)).toEqual({ error: "too_old" });
  });
  test("a non-boolean appSignIn is not_capybara", async () => {
    const f = fake(() => json({ ...good, features: { localDevices: true, appSignIn: "yes" } }));
    expect(await fetchMeta("https://x", f.fn)).toEqual({ error: "not_capybara" });
  });
  test("exposes icons; each may be null; a meta without icons stays valid", async () => {
    const icons = { app: "/icon/app?v=1", maskable: null, favicon: "/icon/favicon?v=2" };
    const withIcons = await fetchMeta("https://x", fake(() => json({ ...good, icons })).fn);
    expect(withIcons).toEqual({ ...good, icons });
    const nulls = { app: null, maskable: null, favicon: null };
    expect(await fetchMeta("https://x", fake(() => json({ ...good, icons: nulls })).fn)).toEqual({
      ...good,
      icons: nulls,
    });
    const without = await fetchMeta("https://x", fake(() => json(good)).fn);
    expect(without).toEqual(good);
    expect(without).not.toHaveProperty("icons");
  });
  test("a malformed icons field is ignored (forward compatible); the meta stays valid", async () => {
    for (const icons of [
      null,
      "x",
      [],
      { app: 1, maskable: null, favicon: null },
      { app: null, maskable: null },
      { app: null, maskable: {}, favicon: null },
    ]) {
      const meta = await fetchMeta("https://x", fake(() => json({ ...good, icons })).fn);
      expect(meta).toEqual(good);
      expect(meta).not.toHaveProperty("icons");
    }
  });
  test("never follows redirects and has a timeout signal", async () => {
    const f = fake(() => json(good));
    await fetchMeta("https://x", f.fn);
    expect(f.calls[0]?.init?.redirect).toBe("error");
    expect(f.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    const redirected = (async (_u: unknown, init?: RequestInit) => {
      if (init?.redirect === "error") throw new TypeError("redirect mode is set to error");
      return json(good);
    }) as typeof fetch;
    expect(await fetchMeta("https://x", redirected)).toEqual({ error: "unreachable" });
  });
  test("a stalled server is unreachable once the signal aborts", async () => {
    const stalled = ((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    const ctl = new AbortController();
    const p = fetchMeta("https://x", stalled, ctl.signal);
    ctl.abort();
    expect(await p).toEqual({ error: "unreachable" });
  });
  test("an oversized body is not_capybara", async () => {
    const big = JSON.stringify({ ...good, name: "a".repeat(70 * 1024) });
    expect(await fetchMeta("https://x", fake(() => new Response(big)).fn)).toEqual({
      error: "not_capybara",
    });
  });
  test("non-integer protocol bounds are not_capybara", async () => {
    const bad = { ...good, protocols: { device: { min: 1.5, max: 3 } } };
    expect(await fetchMeta("https://x", fake(() => json(bad)).fn)).toEqual({
      error: "not_capybara",
    });
  });
});

describe("appRedirectUris", () => {
  test("an array of strings is parsed, anything else is dropped", async () => {
    const uris = ["capybara://auth/callback"];
    const ok = await fetchMeta(
      "https://x",
      fake(() => json({ ...good, appRedirectUris: uris })).fn,
    );
    expect(ok).toMatchObject({ appRedirectUris: uris });
    for (const bad of ["x", [1], null]) {
      const r = await fetchMeta(
        "https://x",
        fake(() => json({ ...good, appRedirectUris: bad })).fn,
      );
      expect(r).not.toHaveProperty("appRedirectUris");
    }
  });
});

describe("discover", () => {
  const certErr = (msg: string, cause = false) =>
    (async () => {
      const e = new TypeError("fetch failed");
      if (cause) (e as { cause?: unknown }).cause = new Error(msg);
      else e.message = msg;
      throw e;
    }) as typeof fetch;

  test("returns base and meta", async () => {
    const r = await discover("x.example/p/", fake(() => json(good)).fn);
    expect(r).toMatchObject({ ok: true, base: "https://x.example/p", meta: { name: "Acme" } });
  });
  test("plain http to a remote host is not_https, without a request", async () => {
    const f = fake(() => json(good));
    expect(await discover("http://x.example", f.fn)).toEqual({ ok: false, error: "not_https" });
    expect(f.calls).toHaveLength(0);
  });
  test("loopback http is fine", async () => {
    expect(await discover("http://localhost:3000", fake(() => json(good)).fn)).toMatchObject({
      ok: true,
    });
  });
  test("an unparseable address is not_capybara", async () => {
    expect(await discover("", fake(() => json(good)).fn)).toEqual({
      ok: false,
      error: "not_capybara",
    });
  });
  test("certificate errors in the message or the cause are cert_invalid", async () => {
    expect(await discover("x.example", certErr("net::ERR_CERT_AUTHORITY_INVALID"))).toEqual({
      ok: false,
      error: "cert_invalid",
    });
    expect(await discover("x.example", certErr("CERT_HAS_EXPIRED", true))).toEqual({
      ok: false,
      error: "cert_invalid",
    });
  });
  test("other network errors are unreachable", async () => {
    expect(await discover("x.example", certErr("ECONNREFUSED"))).toEqual({
      ok: false,
      error: "unreachable",
    });
  });
  test("a stalled server is unreachable after the 10 s timeout", async () => {
    const timer = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
    try {
      const stalled = ((_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(new DOMException("timed out", "TimeoutError")),
          );
        })) as typeof fetch;
      const p = discover("x.example", stalled);
      timer.abort();
      expect(await p).toEqual({ ok: false, error: "unreachable" });
      expect(spy).toHaveBeenCalledWith(META_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });
  test("non-2xx, non-JSON and wrong shape are not_capybara", async () => {
    for (const res of [() => json({}, 500), () => new Response("<html>"), () => json({ a: 1 })]) {
      expect(await discover("x.example", fake(res).fn)).toEqual({
        ok: false,
        error: "not_capybara",
      });
    }
  });
  test("missing appSignIn is too_old; appSignIn false passes through", async () => {
    const old = { ...good, features: { localDevices: true } };
    expect(await discover("x.example", fake(() => json(old)).fn)).toEqual({
      ok: false,
      error: "too_old",
    });
    const off = { ...good, features: { localDevices: true, appSignIn: false } };
    const r = await discover("x.example", fake(() => json(off)).fn);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(appSignInBlocked(r.meta, "capybara://auth/callback")).toBe("not_allowed");
  });
  test("works against the fake deployment with its switches", async () => {
    const dep = await startFakeDeployment({
      meta: { appRedirectUris: ["capybara://auth/callback"] },
    });
    try {
      const r = await discover(dep.base, fetch);
      expect(r).toMatchObject({ ok: true, base: dep.base });
      if (r.ok) {
        expect(appSignInBlocked(r.meta, "capybara://auth/callback")).toBeNull();
        expect(appSignInBlocked(r.meta, "capybara://other")).toBe("not_allowed");
      }
    } finally {
      await dep.close();
    }
    const html = await startFakeDeployment({ metaRaw: "<html>" });
    try {
      expect(await discover(html.base, fetch)).toEqual({ ok: false, error: "not_capybara" });
    } finally {
      await html.close();
    }
    const old = await startFakeDeployment({ features: { appSignIn: null } });
    try {
      expect(await discover(old.base, fetch)).toEqual({ ok: false, error: "too_old" });
    } finally {
      await old.close();
    }
  });
});

describe("appSignInBlocked", () => {
  const meta = (extra: Partial<Meta> = {}): Meta => ({
    name: null,
    icon: null,
    protocols: { device: { min: 1, max: 1 } },
    features: { localDevices: true, appSignIn: true },
    ...extra,
  });
  test("go when appSignIn is on and no list is published", () => {
    expect(appSignInBlocked(meta(), "capybara://auth/callback")).toBeNull();
  });
  test("not_allowed when appSignIn is off", () => {
    const m = meta({ features: { localDevices: true, appSignIn: false } });
    expect(appSignInBlocked(m, "capybara://auth/callback")).toBe("not_allowed");
  });
  test("a published list must contain the redirect uri", () => {
    const m = meta({ appRedirectUris: ["capybara://auth/callback"] });
    expect(appSignInBlocked(m, "capybara://auth/callback")).toBeNull();
    expect(appSignInBlocked(m, "capybara://x")).toBe("not_allowed");
    expect(appSignInBlocked(meta({ appRedirectUris: [] }), "capybara://x")).toBe("not_allowed");
  });
});
