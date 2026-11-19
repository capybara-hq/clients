import { describe, expect, test } from "vitest";
import { fetchMeta } from "../src/meta.ts";

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
  test("malformed icons are not_capybara", async () => {
    for (const icons of [
      null,
      "x",
      [],
      { app: 1, maskable: null, favicon: null },
      { app: null, maskable: null },
      { app: null, maskable: {}, favicon: null },
    ]) {
      expect(await fetchMeta("https://x", fake(() => json({ ...good, icons })).fn)).toEqual({
        error: "not_capybara",
      });
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
