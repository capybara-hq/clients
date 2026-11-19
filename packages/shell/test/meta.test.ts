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
  test("appSignIn false is too_old", async () => {
    const f = fake(() => json({ ...good, features: { localDevices: true, appSignIn: false } }));
    expect(await fetchMeta("https://x", f.fn)).toEqual({ error: "too_old" });
  });
});
