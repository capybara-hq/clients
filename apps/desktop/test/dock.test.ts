import { describe, expect, test, vi } from "vitest";
import {
  createDockIcon,
  createDockIconCache,
  DOCK_ICON_MAX_BYTES,
  fetchPlatformIcon,
  platformIconUrl,
  pngDataUrl,
} from "../src/main/dock.ts";
import type { Profile } from "../src/main/profiles.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

const profile = (n: number, over: Partial<Profile> = {}): Profile => ({
  id: `p${n}`,
  signedIn: true,
  base: `https://p${n}.example.com`,
  origin: `https://p${n}.example.com`,
  name: `P${n}`,
  ...over,
});

const meta = (icon: string | null) => ({
  name: "X",
  icon,
  features: { appSignIn: true },
});

function setup(routes: Record<string, () => Response>, cache: Record<string, Uint8Array> = {}) {
  const fetchFn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const route = routes[String(input)];
    if (!route) throw new TypeError("fetch failed");
    return route();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  const stored = new Map(Object.entries(cache));
  const setIcon = vi.fn();
  const restoreDefault = vi.fn();
  const dock = createDockIcon({
    fetch: fetchFn,
    setIcon,
    restoreDefault,
    readCache: (h) => stored.get(h) ?? null,
    writeCache: (h, png) => {
      stored.set(h, png);
    },
  });
  return { dock, fetchFn, setIcon, restoreDefault, stored };
}

const json = (v: unknown) => () =>
  new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
const bytes = (b: Uint8Array) => () =>
  new Response(b, { headers: { "content-type": "image/png" } });

const ICON_URL = "https://p1.example.com/api/v1/platform/icon/app?v=abc123";
const META_URL = "https://p1.example.com/api/v1/meta";

describe("the Dock rule", () => {
  test("one profile with an icon sets the Dock icon and caches it by its hash", async () => {
    const { dock, setIcon, stored } = setup({
      [META_URL]: json(meta("/api/v1/platform/icon/app?v=abc123")),
      [ICON_URL]: bytes(PNG),
    });
    await dock.update([profile(1)]);
    expect(setIcon).toHaveBeenCalledExactlyOnceWith(PNG);
    expect(stored.get("abc123")).toEqual(PNG);
  });

  test("a cached icon is used without fetching it again", async () => {
    const { dock, setIcon, fetchFn } = setup(
      { [META_URL]: json(meta("/api/v1/platform/icon/app?v=abc123")) },
      { abc123: PNG },
    );
    await dock.update([profile(1)]);
    expect(setIcon).toHaveBeenCalledWith(PNG);
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([META_URL]);
  });

  test("several profiles keep the Capybara icon and fetch nothing", async () => {
    const { dock, setIcon, restoreDefault, fetchFn } = setup({});
    await dock.update([profile(1), profile(2)]);
    expect(setIcon).not.toHaveBeenCalled();
    expect(restoreDefault).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("no icon in the meta keeps the Capybara icon", async () => {
    const { dock, setIcon, restoreDefault } = setup({ [META_URL]: json(meta(null)) });
    await dock.update([profile(1)]);
    await dock.update([]);
    expect(setIcon).not.toHaveBeenCalled();
    expect(restoreDefault).not.toHaveBeenCalled();
  });

  test("init shows the Capybara icon, and never over a custom one", async () => {
    const first = setup({});
    first.dock.init();
    expect(first.restoreDefault).toHaveBeenCalledTimes(1);
    expect(first.setIcon).not.toHaveBeenCalled();

    const second = setup({
      [META_URL]: json(meta("/api/v1/platform/icon/app?v=abc123")),
      [ICON_URL]: bytes(PNG),
    });
    await second.dock.update([profile(1)]);
    second.dock.init();
    expect(second.restoreDefault).not.toHaveBeenCalled();
  });

  test("the Capybara icon comes back once a custom one no longer applies", async () => {
    const { dock, setIcon, restoreDefault } = setup({
      [META_URL]: json(meta("/api/v1/platform/icon/app?v=abc123")),
      [ICON_URL]: bytes(PNG),
    });
    await dock.update([profile(1)]);
    expect(setIcon).toHaveBeenCalledTimes(1);
    await dock.update([profile(1), profile(2)]);
    expect(restoreDefault).toHaveBeenCalledTimes(1);
    await dock.update([]);
    expect(restoreDefault).toHaveBeenCalledTimes(1);
  });

  test("an unreachable deployment keeps the icon it last had, when it is cached", async () => {
    const withCache = setup({}, { abc123: PNG });
    await withCache.dock.update([profile(1, { iconHash: "abc123" })]);
    expect(withCache.setIcon).toHaveBeenCalledWith(PNG);
    const without = setup({});
    await without.dock.update([profile(1, { iconHash: "abc123" })]);
    expect(without.setIcon).not.toHaveBeenCalled();
  });

  test("a later update supersedes an earlier one that is still fetching", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { dock, setIcon } = setup({
      [META_URL]: async () => {
        await gate;
        return json(meta("/api/v1/platform/icon/app?v=abc123"))();
      },
      [ICON_URL]: bytes(PNG),
    } as never);
    const first = dock.update([profile(1)]);
    await dock.update([profile(1), profile(2)]);
    release();
    await first;
    expect(setIcon).not.toHaveBeenCalled();
  });
});

describe("what is accepted as an icon", () => {
  const run = (response: () => Response, icon = "/api/v1/platform/icon/app?v=abc123") =>
    setup({ [META_URL]: json(meta(icon)), [ICON_URL]: response });

  test("a non-PNG is ignored and not cached", async () => {
    const { dock, setIcon, stored } = run(bytes(JPEG));
    await dock.update([profile(1)]);
    expect(setIcon).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });

  test("an icon over 1 MB is ignored", async () => {
    const big = new Uint8Array(DOCK_ICON_MAX_BYTES + 1);
    big.set(PNG);
    const { dock, setIcon, stored } = run(bytes(big));
    await dock.update([profile(1)]);
    expect(setIcon).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });

  test("exactly 1 MB is accepted", async () => {
    const edge = new Uint8Array(DOCK_ICON_MAX_BYTES);
    edge.set(PNG);
    const { dock, setIcon } = run(bytes(edge));
    await dock.update([profile(1)]);
    expect(setIcon).toHaveBeenCalledTimes(1);
  });

  test("a failed or empty answer is ignored", async () => {
    for (const r of [() => new Response("no", { status: 404 }), bytes(new Uint8Array())]) {
      const { dock, setIcon } = run(r);
      await dock.update([profile(1)]);
      expect(setIcon).not.toHaveBeenCalled();
    }
  });

  test("an icon on another origin is never fetched", async () => {
    const other = "https://cdn.example.com/icon.png?v=abc123";
    const { dock, setIcon, fetchFn } = setup({
      [META_URL]: json(meta(other)),
      [other]: bytes(PNG),
    });
    await dock.update([profile(1)]);
    expect(setIcon).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([META_URL]);
  });

  test("the icon is fetched without following redirects", async () => {
    const { dock, fetchFn } = run(bytes(PNG));
    await dock.update([profile(1)]);
    const call = fetchFn.mock.calls.find((c) => c[0] === ICON_URL);
    expect(call?.[1]).toMatchObject({ redirect: "error", cache: "no-store" });
  });

  test("without a usable hash the icon is shown but not cached", async () => {
    const url = "https://p1.example.com/icon.png";
    const { dock, setIcon, stored } = setup({
      [META_URL]: json(meta("/icon.png")),
      [url]: bytes(PNG),
    });
    await dock.update([profile(1)]);
    expect(setIcon).toHaveBeenCalledTimes(1);
    expect(stored.size).toBe(0);
  });

  test("a corrupt cache entry is refetched", async () => {
    const { dock, setIcon, stored } = setup(
      {
        [META_URL]: json(meta("/api/v1/platform/icon/app?v=abc123")),
        [ICON_URL]: bytes(PNG),
      },
      { abc123: JPEG },
    );
    await dock.update([profile(1)]);
    expect(setIcon).toHaveBeenCalledWith(PNG);
    expect(stored.get("abc123")).toEqual(PNG);
  });
});

describe("the icon cache", () => {
  function memory() {
    const files = new Map<string, Uint8Array>();
    return {
      files,
      readFileSync: (p: string) => {
        const v = files.get(p);
        if (!v) throw new Error("ENOENT");
        return v;
      },
      writeFileSync: (p: string, d: Uint8Array) => {
        files.set(p, d);
      },
      renameSync: (a: string, b: string) => {
        files.set(b, files.get(a) as Uint8Array);
        files.delete(a);
      },
      mkdirSync: () => undefined,
    };
  }

  test("round trips by hash through a temp file", () => {
    const fs = memory();
    const cache = createDockIconCache("/u/dock", fs);
    expect(cache.readCache("abc")).toBeNull();
    cache.writeCache("abc", PNG);
    expect([...fs.files.keys()]).toEqual(["/u/dock/abc.png"]);
    expect(cache.readCache("abc")).toEqual(PNG);
  });

  test("a hash that is not a plain token cannot name another path", () => {
    const cache = createDockIconCache("/u/dock", memory());
    expect(cache.readCache("../../etc/passwd")).toBeNull();
    expect(() => cache.writeCache("../x", PNG)).toThrow();
  });
});

describe("the platform icon for the local pages", () => {
  const deployment = { base: "https://p1.example.com/team", origin: "https://p1.example.com" };
  const iconUrl = "https://p1.example.com/api/v1/platform/icon/app?v=h1";

  test("resolved against the base, on the deployment's own origin only", () => {
    expect(platformIconUrl(deployment, "/api/v1/platform/icon/app?v=h1")?.url.href).toBe(iconUrl);
    expect(platformIconUrl(deployment, "/api/v1/platform/icon/app?v=h1")?.hash).toBe("h1");
    expect(platformIconUrl(deployment, "/x.png?v=../a")?.hash).toBeNull();
    expect(platformIconUrl(deployment, "https://evil.example.com/x.png")).toBeNull();
    expect(platformIconUrl(deployment, null)).toBeNull();
  });

  test("fetched as a PNG of at most 1 MB, cached by its hash, read from the cache first", async () => {
    const stored = new Map<string, Uint8Array>();
    const fetchFn = vi.fn(async () => new Response(PNG)) as unknown as typeof fetch;
    const deps = {
      fetch: fetchFn,
      readCache: (h: string) => stored.get(h) ?? null,
      writeCache: (h: string, png: Uint8Array) => {
        stored.set(h, png);
      },
    };
    const first = await fetchPlatformIcon(deployment, "/api/v1/platform/icon/app?v=h1", deps);
    expect(first).toEqual({ png: PNG, hash: "h1" });
    expect(stored.get("h1")).toEqual(PNG);
    await fetchPlatformIcon(deployment, "/api/v1/platform/icon/app?v=h1", deps);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(pngDataUrl(PNG)).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  });

  test("a JPEG or a foreign icon is no icon", async () => {
    const deps = {
      fetch: vi.fn(async () => new Response(JPEG)) as unknown as typeof fetch,
      readCache: () => null,
      writeCache: vi.fn(),
    };
    expect(await fetchPlatformIcon(deployment, "/icon?v=j", deps)).toBeNull();
    expect(await fetchPlatformIcon(deployment, "https://evil.example.com/i.png", deps)).toBeNull();
    expect(deps.writeCache).not.toHaveBeenCalled();
  });
});
