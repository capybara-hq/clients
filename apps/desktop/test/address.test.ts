import { describe, expect, test, vi } from "vitest";
import {
  ADDRESS_STRING_KEYS,
  createAddressHost,
  discoverDeployment,
  localeFrom,
} from "../src/main/address.ts";
import { ADDRESS_CSP, createAppProtocolHandler } from "../src/main/app-protocol.ts";
import type { Profile } from "../src/main/profiles.ts";
import { fakeFrame } from "./fakes.ts";

const META = {
  name: "Example Corp",
  icon: "/api/v1/platform/icon/app?v=abc123",
  protocols: { device: { min: 3, max: 3 } },
  features: { localDevices: true, appSignIn: true },
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new TypeError("fetch failed");
    return route();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const json = (v: unknown) => () =>
  new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

describe("locale", () => {
  test("zh* is zh, everything else en", () => {
    expect(localeFrom("zh-CN")).toBe("zh");
    expect(localeFrom("zh-Hant-TW")).toBe("zh");
    expect(localeFrom("zh")).toBe("zh");
    expect(localeFrom("en-US")).toBe("en");
    expect(localeFrom("fr")).toBe("en");
    expect(localeFrom("")).toBe("en");
  });
});

describe("discovery in the main process", () => {
  test("normalization errors never reach the network", async () => {
    const fetchFn = fakeFetch({});
    expect((await discoverDeployment("", { fetch: fetchFn })).result).toEqual({
      ok: false,
      error: "invalid",
    });
    expect((await discoverDeployment("http://10.0.0.5", { fetch: fetchFn })).result).toEqual({
      ok: false,
      error: "insecure",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("meta errors map to error kinds", async () => {
    const unreachable = await discoverDeployment("a.example.com", { fetch: fakeFetch({}) });
    expect(unreachable.result).toEqual({ ok: false, error: "unreachable" });
    const old = await discoverDeployment("b.example.com", {
      fetch: fakeFetch({
        "https://b.example.com/api/v1/meta": json({
          ...META,
          features: { localDevices: true, appSignIn: false },
        }),
      }),
    });
    expect(old.result).toEqual({ ok: false, error: "too_old" });
    expect(old.candidate).toBeUndefined();
  });

  test("a deployment with a name and an icon", async () => {
    const r = await discoverDeployment("capybara.example.com/team/", {
      fetch: fakeFetch({
        "https://capybara.example.com/team/api/v1/meta": json(META),
        "https://capybara.example.com/api/v1/platform/icon/app?v=abc123": () =>
          new Response(PNG, { headers: { "content-type": "image/png" } }),
      }),
    });
    expect(r.result).toEqual({
      ok: true,
      name: "Example Corp",
      host: "capybara.example.com",
      icon: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
    });
    expect(r.candidate).toEqual({
      base: "https://capybara.example.com/team",
      origin: "https://capybara.example.com",
      name: "Example Corp",
      iconHash: "abc123",
    });
  });

  test("no name shows the host; a foreign or non-image icon is dropped", async () => {
    for (const [icon, headers] of [
      ["https://cdn.evil.example.com/i.png", { "content-type": "image/png" }],
      ["/icon.svg", { "content-type": "image/svg+xml" }],
      ["/big.png", { "content-type": "image/png" }],
    ] as const) {
      const r = await discoverDeployment("localhost:3000", {
        fetch: fakeFetch({
          "https://localhost:3000/api/v1/meta": json({ ...META, name: null, icon }),
          "https://cdn.evil.example.com/i.png": () => new Response(PNG, { headers }),
          "https://localhost:3000/icon.svg": () => new Response("<svg/>", { headers }),
          "https://localhost:3000/big.png": () =>
            new Response(new Uint8Array(300 * 1024), { headers }),
        }),
      });
      expect(r.result).toEqual({
        ok: true,
        name: "localhost:3000",
        host: "localhost:3000",
        icon: null,
      });
      expect(r.candidate?.name).toBe("localhost:3000");
    }
  });
});

// One address window: Electron hands the same webContents object to every message from it.
const ADDRESS_SENDER = { id: 7 };
const ADDRESS_EVENT = (sender: object = ADDRESS_SENDER) => ({
  sender,
  senderFrame: fakeFrame("app://address"),
});

function host(
  over: Partial<Parameters<typeof createAddressHost>[0]> = {},
): ReturnType<typeof createAddressHost> & { deps: Parameters<typeof createAddressHost>[0] } {
  const profile: Profile = {
    id: "p1",
    base: "https://capybara.example.com",
    origin: "https://capybara.example.com",
    name: "Example Corp",
  };
  const deps: Parameters<typeof createAddressHost>[0] = {
    discover: vi.fn(async () => ({
      result: { ok: true as const, name: "Example Corp", host: "capybara.example.com", icon: null },
      candidate: { base: profile.base, origin: profile.origin, name: profile.name },
    })),
    isAddressSender: (s: unknown) => s === ADDRESS_SENDER,
    locale: "zh",
    prefillFor: () => "capybara.example.com",
    addProfile: vi.fn(() => profile),
    openProfile: vi.fn(),
    closeSender: vi.fn(),
    ...over,
  };
  return Object.assign(createAddressHost(deps), { deps });
}

describe("the address page IPC", () => {
  test("init gives the locale, the strings and the prefill", () => {
    const h = host();
    const init = h.handleInit(ADDRESS_EVENT());
    expect(init?.locale).toBe("zh");
    expect(init?.prefill).toBe("capybara.example.com");
    expect(init?.strings["address.error.too_old"]).toBe("该平台版本过旧");
    expect(Object.keys(init?.strings ?? {}).sort()).toEqual([...ADDRESS_STRING_KEYS].sort());
  });

  test("only the top frame of a registered address window is served", async () => {
    const h = host();
    const bad = [
      { sender: { id: 7 }, senderFrame: fakeFrame("app://address") },
      { sender: ADDRESS_SENDER, senderFrame: fakeFrame("app://address", {}) },
      { sender: ADDRESS_SENDER, senderFrame: fakeFrame("https://capybara.example.com") },
      { sender: ADDRESS_SENDER, senderFrame: null },
    ];
    for (const e of bad) {
      expect(h.handleInit(e)).toBeNull();
      expect(await h.handleSubmit(e, "capybara.example.com")).toEqual({
        ok: false,
        error: "failed",
      });
      expect(await h.handleOpen(e)).toEqual({ ok: false, error: "failed" });
    }
    expect(h.deps.discover).not.toHaveBeenCalled();
    expect(h.deps.addProfile).not.toHaveBeenCalled();
  });

  test("submit, then open saves the discovered profile and loads it", async () => {
    const h = host();
    expect(await h.handleSubmit(ADDRESS_EVENT(), "capybara.example.com")).toEqual({
      ok: true,
      name: "Example Corp",
      host: "capybara.example.com",
      icon: null,
    });
    expect(h.deps.addProfile).not.toHaveBeenCalled();
    expect(await h.handleOpen(ADDRESS_EVENT())).toEqual({ ok: true });
    expect(h.deps.addProfile).toHaveBeenCalledWith({
      base: "https://capybara.example.com",
      origin: "https://capybara.example.com",
      name: "Example Corp",
    });
    expect(h.deps.openProfile).toHaveBeenCalledTimes(1);
    expect(h.deps.closeSender).toHaveBeenCalledTimes(1);
    // One use: a second open has nothing pending.
    expect(await h.handleOpen(ADDRESS_EVENT())).toEqual({ ok: false, error: "failed" });
  });

  test("open without a successful discovery saves nothing", async () => {
    const h = host({
      discover: vi.fn(async () => ({ result: { ok: false as const, error: "too_old" as const } })),
    });
    expect(await h.handleOpen(ADDRESS_EVENT())).toEqual({ ok: false, error: "failed" });
    expect(await h.handleSubmit(ADDRESS_EVENT(), "old.example.com")).toEqual({
      ok: false,
      error: "too_old",
    });
    expect(await h.handleOpen(ADDRESS_EVENT())).toEqual({ ok: false, error: "failed" });
    expect(h.deps.addProfile).not.toHaveBeenCalled();
  });

  test("a failed later submit clears the earlier candidate", async () => {
    let n = 0;
    const h = host({
      discover: vi.fn(async () =>
        ++n === 1
          ? {
              result: { ok: true as const, name: "A", host: "a.example.com", icon: null },
              candidate: {
                base: "https://a.example.com",
                origin: "https://a.example.com",
                name: "A",
              },
            }
          : { result: { ok: false as const, error: "unreachable" as const } },
      ),
    });
    await h.handleSubmit(ADDRESS_EVENT(), "a.example.com");
    await h.handleSubmit(ADDRESS_EVENT(), "b.example.com");
    expect(await h.handleOpen(ADDRESS_EVENT())).toEqual({ ok: false, error: "failed" });
  });

  test("a non-string address is invalid", async () => {
    const h = host();
    expect(await h.handleSubmit(ADDRESS_EVENT(), 42)).toEqual({ ok: false, error: "invalid" });
    expect(await h.handleSubmit(ADDRESS_EVENT(), "x".repeat(3000))).toEqual({
      ok: false,
      error: "invalid",
    });
  });
});

describe("the app:// protocol", () => {
  const files: Record<string, string> = {
    "/dist/address-page/index.html": "<html></html>",
    "/dist/address-page/address.css": "body{}",
    "/dist/address-page/address.js": "void 0",
  };
  const readFile = vi.fn(async (p: string) => {
    const v = files[p];
    if (v === undefined) throw new Error("ENOENT");
    return Buffer.from(v);
  });
  const handle = createAppProtocolHandler({ dir: "/dist/address-page", readFile });

  test("serves the three files with types and a strict CSP", async () => {
    for (const [url, type] of [
      ["app://address/index.html", "text/html"],
      ["app://address/", "text/html"],
      ["app://address/address.css", "text/css"],
      ["app://address/address.js", "text/javascript"],
    ]) {
      const res = await handle({ url: url as string });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type as string);
      expect(res.headers.get("content-security-policy")).toBe(ADDRESS_CSP);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(ADDRESS_CSP).toContain("default-src 'none'");
    expect(ADDRESS_CSP).toContain("script-src 'self'");
    expect(ADDRESS_CSP).toContain("style-src 'self'");
    expect(ADDRESS_CSP).toContain("img-src data:");
    expect(ADDRESS_CSP).not.toContain("connect-src");
  });

  test("anything else is 404 and never reads another path", async () => {
    readFile.mockClear();
    for (const url of [
      "app://address/../main/index.cjs",
      "app://address/%2e%2e/main/index.cjs",
      "app://address/..%2fmain%2findex.cjs",
      "app://address/index.html/../../x",
      "app://address/main/index.cjs",
      "app://other/index.html",
      "app://address/address.js.map",
      "not a url",
    ]) {
      const res = await handle({ url });
      expect(res.status).toBe(404);
    }
    for (const call of readFile.mock.calls) expect(Object.keys(files)).toContain(call[0]);
  });
});
