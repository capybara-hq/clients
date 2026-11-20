import { describe, expect, test, vi } from "vitest";
import {
  appearanceKey,
  createAppearanceStore,
  nativeLook,
  validAppearanceInput,
} from "../../src/runtime/appearance.ts";
import { createChrome } from "../../src/runtime/capabilities/chrome.ts";
import type { HostPort } from "../../src/runtime/host-port.ts";
import { createRegistry } from "../../src/runtime/registry.ts";

const ORIGIN = "https://a.example";
const profile = { id: "p1", origin: ORIGIN };

function memoryPrefs(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

const noHost: HostPort = {
  onCall: () => () => {},
  reply: async () => {},
  pushState: async () => {},
  event: async () => {},
};

function setup(initial: Record<string, string> = {}) {
  const prefs = memoryPrefs(initial);
  const native = { setAppearance: vi.fn(async (_id: string, _look: unknown) => {}) };
  const ready = vi.fn((_id: string) => {});
  const registry = createRegistry({ host: noHost, profiles: { list: () => [profile] } });
  registry.register(
    "chrome@1",
    createChrome({ appearance: createAppearanceStore(prefs), native, ready }),
  );
  let n = 0;
  const call = (fn: string, args: unknown[]) =>
    registry.dispatch({
      profileId: "p1",
      origin: ORIGIN,
      docId: "doc-0001-aaaa",
      callId: String(++n),
      key: "chrome@1",
      fn,
      args,
      activation: false,
    });
  return { prefs, native, ready, registry, call };
}

describe("chrome@1", () => {
  test("offers setAppearance and ready", () => {
    const { registry } = setup();
    expect(registry.descriptors(profile).capabilities["chrome@1"]?.sort()).toEqual([
      "ready",
      "setAppearance",
    ]);
  });

  test.each([
    [{ scheme: "dim", background: "#123456" }],
    [{ scheme: "dark", background: "#12345678" }],
    [{ scheme: "dark", background: "red" }],
    [{ scheme: "dark" }],
    [{ scheme: "dark", background: "#123456", tokens: { bg: "#000" } }],
    [{ scheme: "dark", background: "#123456", singleScheme: "yes" }],
    ["dark"],
    [null],
  ])("setAppearance(%j) fails and changes nothing", async (input) => {
    const { call, native, prefs } = setup();
    expect(await call("setAppearance", [input])).toEqual({ ok: false, code: "failed" });
    expect(native.setAppearance).not.toHaveBeenCalled();
    expect(prefs.set).not.toHaveBeenCalled();
  });

  test("a valid call sets the native background and status bar, and persists them", async () => {
    const { call, native, prefs } = setup();
    expect(await call("setAppearance", [{ scheme: "dark", background: "#123456" }])).toEqual({
      ok: true,
      value: null,
    });
    expect(native.setAppearance).toHaveBeenCalledWith("p1", {
      background: "#123456",
      statusBar: "light",
    });
    expect(JSON.parse(prefs.values.get("appearance.p1") ?? "null")).toEqual({
      scheme: "dark",
      background: "#123456",
    });
  });

  test("rgb() becomes #rrggbb natively; a light scheme asks for dark status bar content", async () => {
    const { call, native } = setup();
    await call("setAppearance", [{ scheme: "light", background: "rgba(250, 249, 246, 0.5)" }]);
    expect(native.setAppearance).toHaveBeenCalledWith("p1", {
      background: "#faf9f6",
      statusBar: "dark",
    });
  });

  test("an unchanged appearance is not written again", async () => {
    const { call, prefs } = setup();
    const input = { scheme: "dark", background: "#123456" };
    await call("setAppearance", [input]);
    await call("setAppearance", [input]);
    expect(prefs.set).toHaveBeenCalledTimes(1);
  });

  test("ready() tells the loader for that profile", async () => {
    const { call, ready } = setup();
    expect(await call("ready", [])).toEqual({ ok: true, value: null });
    expect(ready).toHaveBeenCalledWith("p1");
  });
});

describe("appearance", () => {
  test("is stored per profile under appearance.<profileId>", async () => {
    expect(appearanceKey("p1")).toBe("appearance.p1");
    const prefs = memoryPrefs({
      "appearance.p1": JSON.stringify({ scheme: "light", background: "#fff" }),
      "appearance.p2": "{not json",
      "appearance.p3": JSON.stringify({ scheme: "light", background: "red" }),
    });
    const store = createAppearanceStore(prefs);
    expect(await store.load("p1")).toEqual({ scheme: "light", background: "#fff" });
    expect(await store.load("p2")).toBeNull();
    expect(await store.load("p3")).toBeNull();
    expect(await store.load("missing")).toBeNull();
  });

  test("a throwing backend reads as nothing stored", async () => {
    const store = createAppearanceStore({
      get: async () => {
        throw new Error("x");
      },
      set: async () => {},
    });
    expect(await store.load("p1")).toBeNull();
  });

  test("validAppearanceInput keeps valid tokens and singleScheme, drops unknown fields", () => {
    const tokens = {
      bg: "#000000",
      panel: "#111111",
      ink: "#eeeeee",
      muted: "#888888",
      line: "#222222",
      accent: "#ff6a13",
      onAccent: "#000000",
    };
    expect(
      validAppearanceInput({
        scheme: "dark",
        background: "#000",
        tokens,
        singleScheme: true,
        extra: 1,
      }),
    ).toEqual({ scheme: "dark", background: "#000", tokens, singleScheme: true });
  });

  test("nativeLook expands #rgb", () => {
    expect(nativeLook({ scheme: "light", background: "#AbC" })).toEqual({
      background: "#aabbcc",
      statusBar: "dark",
    });
  });
});
