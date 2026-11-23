import { describe, expect, test } from "vitest";
import { brand as officialBrand } from "../brand.ts";
import { answerDiscover } from "../src/runtime/address-bridge.ts";
import { createAddressModel, resolveIcon } from "../src/runtime/address-model.ts";
import {
  discover,
  type HttpGetPort,
  type HttpGetResult,
  startRoute,
} from "../src/runtime/discovery.ts";
import { createProfileStore } from "../src/runtime/profiles.ts";

const META = {
  name: "Acme",
  icon: "/api/v1/meta/icon.png?v=1",
  icons: { app: "/api/v1/meta/icon.png?v=1", maskable: null, favicon: null },
  features: { appSignIn: true },
};

function fakeGet(answers: Record<string, HttpGetResult | Error>): HttpGetPort & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async get(url) {
      urls.push(url);
      const a = answers[url];
      if (!a) throw new Error("ECONNREFUSED");
      if (a instanceof Error) throw a;
      return a;
    },
  };
}
const ok = (meta: unknown): HttpGetResult => ({ status: 200, body: JSON.stringify(meta) });
const META_URL = "https://capybara.example.com/api/v1/meta";

describe("discover", () => {
  test("adds https and asks /api/v1/meta of the normalized base", async () => {
    const httpGet = fakeGet({ [META_URL]: ok(META) });
    const r = await discover("capybara.example.com", { httpGet });
    expect(r).toMatchObject({ base: "https://capybara.example.com", meta: { name: "Acme" } });
    expect(httpGet.urls).toEqual([META_URL]);
  });

  test("http for a non-loopback host is insecure and asks nothing", async () => {
    const httpGet = fakeGet({});
    expect(await discover("http://x.example", { httpGet })).toEqual({ error: "insecure" });
    expect(httpGet.urls).toEqual([]);
  });

  test("an unparseable address is invalid", async () => {
    expect(await discover("   ", { httpGet: fakeGet({}) })).toEqual({ error: "invalid" });
  });

  test("a redirect is unreachable (never followed)", async () => {
    const httpGet = fakeGet({ [META_URL]: { status: 302, body: "" } });
    expect(await discover("capybara.example.com", { httpGet })).toEqual({ error: "unreachable" });
  });

  test("a network failure is unreachable, a certificate failure cert_invalid", async () => {
    expect(await discover("capybara.example.com", { httpGet: fakeGet({}) })).toEqual({
      error: "unreachable",
    });
    const httpGet = fakeGet({ [META_URL]: new Error("CERT_INVALID") });
    expect(await discover("capybara.example.com", { httpGet })).toEqual({ error: "cert_invalid" });
  });

  test("a non-200, non-JSON or truncated answer is not_capybara", async () => {
    for (const answer of [
      { status: 404, body: "" },
      { status: 200, body: "<html>" },
      { status: 200, body: "{}", truncated: true },
    ]) {
      const httpGet = fakeGet({ [META_URL]: answer });
      expect(await discover("capybara.example.com", { httpGet })).toEqual({
        error: "not_capybara",
      });
    }
  });

  test("a null-body status (204, 205, 304) or an out-of-range status is not_capybara", async () => {
    for (const status of [204, 205, 304, 101, 199, 600]) {
      for (const body of ["", "x"]) {
        const httpGet = fakeGet({ [META_URL]: { status, body } });
        expect(await discover("capybara.example.com", { httpGet })).toEqual({
          error: "not_capybara",
        });
      }
    }
  });

  test("meta without appSignIn is too_old, appSignIn false is sign_in_unavailable", async () => {
    const { appSignIn: _, ...features } = META.features;
    let httpGet = fakeGet({ [META_URL]: ok({ ...META, features }) });
    expect(await discover("capybara.example.com", { httpGet })).toEqual({ error: "too_old" });
    httpGet = fakeGet({
      [META_URL]: ok({ ...META, features: { ...features, appSignIn: false } }),
    });
    expect(await discover("capybara.example.com", { httpGet })).toEqual({
      error: "sign_in_unavailable",
    });
  });
});

function profilesFake(initial: string[] = []) {
  const data = new Map<string, string>();
  let n = 0;
  const store = createProfileStore({
    prefs: {
      get: (k) => data.get(k) ?? null,
      set: async (k, v) => void data.set(k, v),
    },
    stores: {
      mode: async () => "multi",
      create: async () => {},
      remove: async () => {},
      clearAll: async () => {},
    },
    confirm: async () => true,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    now: () => 1,
  });
  return {
    store,
    ready: Promise.all(initial.map((base) => store.add({ base, name: null, iconUrl: null }))),
  };
}

describe("discovery deadline", () => {
  const dripping: HttpGetPort = { get: () => new Promise(() => {}) };

  test("an aborted signal ends a native request that never answers as unreachable", async () => {
    const controller = new AbortController();
    const pending = discover("capybara.example.com", {
      httpGet: dripping,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toEqual({ error: "unreachable" });
  });

  test("an already aborted signal never reaches the port", async () => {
    const httpGet = fakeGet({ [META_URL]: ok(META) });
    const controller = new AbortController();
    controller.abort();
    expect(await discover("capybara.example.com", { httpGet, signal: controller.signal })).toEqual({
      error: "unreachable",
    });
    expect(httpGet.urls).toEqual([]);
  });
});

describe("startRoute", () => {
  const preset = { ...officialBrand, presetUrl: "https://acme.example.com", lockToPreset: false };

  test("no preset and no profiles goes to the address page", async () => {
    const { store } = profilesFake();
    expect(await startRoute(officialBrand, null, store)).toBe("address");
    expect(store.list()).toEqual([]);
  });

  test("a preset with no profile adds it and opens it", async () => {
    const { store } = profilesFake();
    const route = await startRoute(preset, null, store);
    expect(store.list().map((p) => p.base)).toEqual(["https://acme.example.com"]);
    expect(route).toEqual({ profileId: store.list()[0]?.id });
  });

  test("with profiles it opens the current one", async () => {
    const { store, ready } = profilesFake(["https://a.example.com", "https://b.example.com"]);
    await ready;
    expect(await startRoute(officialBrand, null, store)).toEqual({
      profileId: store.current()?.id,
    });
    expect(store.list()).toHaveLength(2);
  });

  test("locked: opens the preset's profile, adding it when only others exist", async () => {
    const { store, ready } = profilesFake(["https://a.example.com"]);
    await ready;
    const route = await startRoute({ ...preset, lockToPreset: true }, null, store);
    const added = store.list().find((p) => p.base === "https://acme.example.com");
    expect(route).toEqual({ profileId: added?.id });
  });

  test("a managed preset overrides an unlocked brand; a locked brand wins over managed", async () => {
    let { store } = profilesFake();
    await startRoute(officialBrand, { presetUrl: "https://mdm.example.com" }, store);
    expect(store.list().map((p) => p.base)).toEqual(["https://mdm.example.com"]);
    ({ store } = profilesFake());
    await startRoute(
      { ...preset, lockToPreset: true },
      { presetUrl: "https://mdm.example.com" },
      store,
    );
    expect(store.list().map((p) => p.base)).toEqual(["https://acme.example.com"]);
  });

  test("a bad managed preset is ignored", async () => {
    const { store } = profilesFake();
    expect(await startRoute(officialBrand, { presetUrl: "http://evil.example" }, store)).toBe(
      "address",
    );
  });
});

/** The page's model over the runtime's discovery, as the framed page reaches it by postMessage. */
const modelOver = (httpGet: HttpGetPort, lockedBase: string | null) =>
  createAddressModel({ discover: (input) => answerDiscover(input, { httpGet, lockedBase }) });

describe("the address page model", () => {
  const answers = { [META_URL]: ok(META) };

  test("renders the deployment's name and its app icon resolved against the base", async () => {
    const model = modelOver(fakeGet(answers), null);
    await model.submit("capybara.example.com");
    expect(model.state()).toMatchObject({
      phase: "found",
      found: {
        base: "https://capybara.example.com",
        name: "Acme",
        iconUrl: "https://capybara.example.com/api/v1/meta/icon.png?v=1",
      },
    });
  });

  test("passes through checking before the answer", async () => {
    const phases: string[] = [];
    const model = modelOver(fakeGet(answers), null);
    model.subscribe((s) => phases.push(s.phase));
    await model.submit("capybara.example.com");
    expect(phases).toEqual(["checking", "found"]);
  });

  test("a failure shows the error kind and the host", async () => {
    const model = modelOver(fakeGet({}), null);
    await model.submit("capybara.example.com");
    expect(model.state()).toMatchObject({
      phase: "error",
      error: "unreachable",
      host: "capybara.example.com",
    });
  });

  test("locked: another address is refused with locked, without asking the network", async () => {
    const httpGet = fakeGet(answers);
    const model = modelOver(httpGet, "https://acme.example.com");
    await model.submit("capybara.example.com");
    expect(model.state()).toMatchObject({ phase: "error", error: "locked" });
    expect(httpGet.urls).toEqual([]);
  });

  test("locked: the preset itself is accepted", async () => {
    const httpGet = fakeGet({ "https://acme.example.com/api/v1/meta": ok(META) });
    const model = modelOver(httpGet, "https://acme.example.com");
    await model.submit("https://acme.example.com/");
    expect(model.state().phase).toBe("found");
  });

  test("a newer submit wins over a slower older one", async () => {
    let release: (r: HttpGetResult) => void = () => {};
    const slow = new Promise<HttpGetResult>((r) => (release = r));
    const httpGet: HttpGetPort = {
      get: (url) => (url.includes("slow") ? slow : Promise.resolve(ok({ ...META, name: "Fast" }))),
    };
    const model = modelOver(httpGet, null);
    const first = model.submit("slow.example.com");
    await model.submit("fast.example.com");
    release(ok({ ...META, name: "Slow" }));
    await first;
    expect(model.state()).toMatchObject({ phase: "found", found: { name: "Fast" } });
  });
});

describe("resolveIcon", () => {
  const base = "https://capybara.example.com/prefix";
  test("resolves relative icons, prefers icons.app, ignores non-http(s)", () => {
    expect(resolveIcon(base, { ...META, icons: { ...META.icons, app: "/i.png" } } as never)).toBe(
      "https://capybara.example.com/i.png",
    );
    expect(resolveIcon(base, { ...META, icons: undefined, icon: "x.png" } as never)).toBe(
      "https://capybara.example.com/x.png",
    );
    expect(
      resolveIcon(base, { ...META, icon: "javascript:alert(1)", icons: undefined } as never),
    ).toBe(null);
    expect(resolveIcon(base, { ...META, icon: null, icons: undefined } as never)).toBeNull();
  });

  test("an http icon is dropped on an https base and kept on an http (loopback) one", () => {
    const icon = { ...META, icons: undefined, icon: "http://cdn.example.com/i.png" } as never;
    expect(resolveIcon(base, icon)).toBeNull();
    expect(resolveIcon("http://127.0.0.1:8080", icon)).toBe("http://cdn.example.com/i.png");
    expect(
      resolveIcon("http://127.0.0.1:8080", { ...META, icon: "/i.png", icons: undefined } as never),
    ).toBe("http://127.0.0.1:8080/i.png");
  });
});
