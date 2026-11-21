import { describe, expect, test } from "vitest";
import { brand as officialBrand } from "../../brand.ts";
import {
  applyPolicy,
  createManagedPolicy,
  effectivePreset,
  type ManagedConfigNative,
  type ManagedSource,
  managedSourceFrom,
  parseManaged,
} from "../../src/runtime/managed.ts";
import {
  createProfileStore,
  type DataStorePort,
  type PrefsPort,
} from "../../src/runtime/profiles.ts";

const A = "https://a.example";
const B = "https://b.example";

describe("parseManaged", () => {
  test("a bare host becomes an https base", () => {
    expect(parseManaged({ presetUrl: "cap.example" })).toEqual({
      presetUrl: "https://cap.example",
    });
  });

  test("keeps the path prefix, drops a trailing slash", () => {
    expect(parseManaged({ presetUrl: "https://cap.example/team/" })).toEqual({
      presetUrl: "https://cap.example/team",
    });
  });

  test.each([
    ["plain http", "http://cap.example"],
    ["loopback http (typing only, never a preset)", "http://localhost:3000"],
    ["a number", 42],
    ["userinfo", "https://u:p@x"],
    ["another scheme", "javascript:alert(1)"],
    ["an empty string", ""],
    ["null", null],
  ])("drops a presetUrl that is %s", (_name, presetUrl) => {
    expect(parseManaged({ presetUrl })).toEqual({});
  });

  test("lockToPreset must be a real boolean", () => {
    expect(parseManaged({ lockToPreset: "yes" })).toEqual({});
    expect(parseManaged({ lockToPreset: 1 })).toEqual({});
    expect(parseManaged({ lockToPreset: true })).toEqual({ lockToPreset: true });
    expect(parseManaged({ lockToPreset: false })).toEqual({ lockToPreset: false });
  });

  test("a bad field does not take the good one with it", () => {
    expect(parseManaged({ presetUrl: "http://x", lockToPreset: true })).toEqual({
      lockToPreset: true,
    });
  });

  test.each([undefined, null, "cap.example", 7, ["cap.example"]])(
    "a non-object (%s) is empty",
    (raw) => {
      expect(parseManaged(raw)).toEqual({});
    },
  );

  test("unknown keys are ignored", () => {
    expect(parseManaged({ presetUrl: "cap.example", other: "x" })).toEqual({
      presetUrl: "https://cap.example",
    });
  });
});

describe("effectivePreset", () => {
  const brand = (presetUrl: string | null, lockToPreset: boolean) => ({
    ...officialBrand,
    presetUrl,
    lockToPreset,
  });

  test("a locked brand wins over a managed preset", () => {
    expect(effectivePreset(brand(A, true), { presetUrl: B })).toEqual({
      presetUrl: A,
      locked: true,
    });
    expect(effectivePreset(brand(A, true), { presetUrl: B, lockToPreset: false })).toEqual({
      presetUrl: A,
      locked: true,
    });
  });

  test("an unlocked brand: a managed preset with a lock overrides it", () => {
    expect(effectivePreset(brand(A, false), { presetUrl: B, lockToPreset: true })).toEqual({
      presetUrl: B,
      locked: true,
    });
  });

  test("a managed preset without a lock replaces the brand's, unlocked", () => {
    expect(effectivePreset(brand(A, false), { presetUrl: B })).toEqual({
      presetUrl: B,
      locked: false,
    });
  });

  test("a managed lock without any preset locks nothing", () => {
    expect(effectivePreset(brand(null, false), { lockToPreset: true })).toEqual({
      presetUrl: null,
      locked: false,
    });
  });

  test("a managed lock with only the brand's preset locks to the brand's", () => {
    expect(effectivePreset(brand(A, false), { lockToPreset: true })).toEqual({
      presetUrl: A,
      locked: true,
    });
  });

  test("no preset anywhere", () => {
    expect(effectivePreset(brand(null, false), null)).toEqual({ presetUrl: null, locked: false });
  });

  test("an unparsed managed preset is still checked (https only)", () => {
    expect(effectivePreset(brand(null, false), { presetUrl: "http://evil.example" })).toEqual({
      presetUrl: null,
      locked: false,
    });
  });
});

describe("applyPolicy", () => {
  const profiles = [
    { id: "a", base: A },
    { id: "b", base: B },
  ];

  test("unlocked: everything shows and anything can be added", () => {
    const r = applyPolicy({ presetUrl: A, locked: false }, profiles);
    expect(r.visible.map((p) => p.id)).toEqual(["a", "b"]);
    expect(r.canAdd(B)).toBe(true);
    expect(r.canAdd("c.example")).toBe(true);
  });

  test("locked to A hides B and refuses adding B", () => {
    const r = applyPolicy({ presetUrl: A, locked: true }, profiles);
    expect(r.visible.map((p) => p.id)).toEqual(["a"]);
    expect(r.canAdd(B)).toBe(false);
    expect(r.canAdd("a.example")).toBe(true);
    expect(r.canAdd(`${A}/`)).toBe(true);
    expect(r.canAdd("not an address at all ::")).toBe(false);
  });
});

// ---- The runtime: a change event re-runs the policy over the real profile store ----

function fakeStores() {
  const calls: string[] = [];
  const stores: DataStorePort = {
    mode: async () => "multi",
    create: async (id) => void calls.push(`create:${id}`),
    remove: async (id) => void calls.push(`remove:${id}`),
    clearAll: async () => void calls.push("clearAll"),
  };
  return { stores, calls };
}

function fakeSource(initial: unknown) {
  let listener: ((raw: unknown) => void) | null = null;
  const source: ManagedSource = {
    read: async () => initial,
    onChange: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  return { source, emit: (raw: unknown) => listener?.(raw), listening: () => listener !== null };
}

async function setup(managed: unknown, mode: "multi" | "single" = "multi") {
  const values = new Map<string, string>();
  const prefs: PrefsPort = {
    get: (k) => values.get(k) ?? null,
    set: async (k, v) => void values.set(k, v),
  };
  const { stores, calls } = fakeStores();
  if (mode === "single") stores.mode = async () => "single";
  let n = 0;
  const asked: string[] = [];
  const profiles = createProfileStore({
    prefs,
    stores,
    confirm: async (text) => {
      asked.push(text.message);
      return true;
    },
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    now: () => n,
  });
  const b = await profiles.add({ base: B, name: "B", iconUrl: null });
  const { source, emit, listening } = fakeSource(managed);
  // What `changed` saw: the current profile after each change was applied.
  const changed: (string | null)[] = [];
  const logs: string[] = [];
  const policy = await createManagedPolicy({
    brand: { ...officialBrand, presetUrl: null, lockToPreset: false },
    source,
    profiles,
    changed: () => void changed.push(profiles.current()?.base ?? null),
    log: (m) => void logs.push(m),
  });
  return { profiles, policy, emit, listening, calls, changed, b, asked, logs, stores };
}

describe("createManagedPolicy", () => {
  test("locked to A at start: B is hidden, never removed, adding B is refused", async () => {
    const { policy, profiles, calls } = await setup({ presetUrl: A, lockToPreset: true });
    expect(policy.policy()).toEqual({ presetUrl: A, locked: true });
    expect(policy.visible().map((p) => p.base)).toEqual([]);
    expect(policy.canAdd(B)).toBe(false);
    expect(profiles.list().map((p) => p.base)).toEqual([B]);
    expect(calls.some((c) => c.startsWith("remove:"))).toBe(false);
  });

  test("a change to a lock moves the current profile to A, then runs changed", async () => {
    const { policy, profiles, emit, changed, calls } = await setup({});
    expect(policy.visible().map((p) => p.base)).toEqual([B]);
    emit({ presetUrl: "a.example", lockToPreset: true });
    await policy.settled();
    expect(profiles.current()?.base).toBe(A);
    expect(policy.visible().map((p) => p.base)).toEqual([A]);
    expect(changed).toEqual([A]);
    expect(calls.some((c) => c.startsWith("remove:"))).toBe(false);
  });

  test("changed runs even when the enforcement fails", async () => {
    const { policy, profiles, emit, changed, stores } = await setup({});
    stores.create = async () => {
      throw new Error("native down");
    };
    emit({ presetUrl: A, lockToPreset: true });
    await policy.settled();
    expect(profiles.current()?.base).toBe(B);
    expect(changed).toEqual([B]);
    expect(policy.visible()).toEqual([]);
  });

  test("a lock without a usable preset is logged", async () => {
    const { policy, emit, logs } = await setup({});
    emit({ presetUrl: "http://x.example", lockToPreset: true });
    await policy.settled();
    expect(policy.policy().locked).toBe(false);
    expect(logs.join("\n")).toMatch(/lockToPreset/);
  });

  test("lifting the lock shows B again, its store intact", async () => {
    const { policy, profiles, emit, calls, b } = await setup({ presetUrl: A, lockToPreset: true });
    emit({ presetUrl: A, lockToPreset: true });
    await policy.settled();
    emit({});
    await policy.settled();
    expect(policy.policy()).toEqual({ presetUrl: null, locked: false });
    expect(
      policy
        .visible()
        .map((p) => p.base)
        .sort(),
    ).toEqual([A, B]);
    expect(profiles.list().find((p) => p.id === b.id)?.dataStoreId).toBe(b.dataStoreId);
    expect(calls.some((c) => c.startsWith("remove:"))).toBe(false);
    expect(policy.canAdd("c.example")).toBe(true);
  });

  test("a lock in single mode switches without asking (the shared store is still cleared)", async () => {
    const { policy, profiles, emit, asked, calls } = await setup({}, "single");
    emit({ presetUrl: A, lockToPreset: true });
    await policy.settled();
    expect(profiles.current()?.base).toBe(A);
    expect(asked).toEqual([]);
    expect(calls).toContain("clearAll");
  });

  test("an unlocked managed preset changes nothing about the current profile", async () => {
    const { policy, profiles, emit, changed } = await setup({});
    emit({ presetUrl: A });
    await policy.settled();
    expect(profiles.current()?.base).toBe(B);
    expect(changed).toEqual([B]);
  });

  test("a malformed change event reads as no managed config", async () => {
    const { policy, emit } = await setup({ presetUrl: A, lockToPreset: true });
    emit("garbage");
    await policy.settled();
    expect(policy.policy()).toEqual({ presetUrl: null, locked: false });
  });

  test("a source that fails to read starts with no managed config", async () => {
    const { profiles } = await setup({});
    const logs: string[] = [];
    const policy = await createManagedPolicy({
      brand: officialBrand,
      source: { read: () => Promise.reject(new Error("no plugin")), onChange: () => () => {} },
      profiles,
      changed: async () => {},
      log: (m) => void logs.push(m),
    });
    expect(policy.policy()).toEqual({ presetUrl: null, locked: false });
    expect(logs).toHaveLength(1);
  });

  test("subscribes before reading; a change during the read wins over it", async () => {
    const { profiles } = await setup({});
    const order: string[] = [];
    let listener: ((raw: unknown) => void) | null = null;
    const policy = await createManagedPolicy({
      brand: officialBrand,
      source: {
        onChange: (l) => {
          order.push("subscribe");
          listener = l;
          return () => {};
        },
        read: async () => {
          order.push("read");
          (listener as ((raw: unknown) => void) | null)?.({ presetUrl: A, lockToPreset: true });
          return {};
        },
      },
      profiles,
      changed: async () => {},
    });
    await policy.settled();
    expect(order).toEqual(["subscribe", "read"]);
    expect(policy.policy()).toEqual({ presetUrl: A, locked: true });
    expect(profiles.current()?.base).toBe(A);
  });

  test("stop unsubscribes from changes", async () => {
    const { policy, listening } = await setup({});
    expect(listening()).toBe(true);
    policy.stop();
    expect(listening()).toBe(false);
  });
});

describe("managedSourceFrom", () => {
  test("a read waits until the change listener is registered natively", async () => {
    const order: string[] = [];
    let register: (() => void) | null = null;
    const native: ManagedConfigNative = {
      get: async () => {
        order.push("get");
        return { config: {} };
      },
      addListener: () =>
        new Promise((resolve) => {
          register = () => {
            order.push("registered");
            resolve({ remove: async () => {} });
          };
        }),
    };
    const source = managedSourceFrom(native);
    source.onChange(() => {});
    const read = source.read();
    await Promise.resolve();
    expect(order).toEqual([]);
    (register as (() => void) | null)?.();
    await read;
    expect(order).toEqual(["registered", "get"]);
  });

  test("a listener registration that rejects is handled (no plugin)", async () => {
    const native: ManagedConfigNative = {
      get: async () => ({ config: { lockToPreset: true } }),
      addListener: () => Promise.reject(new Error("plugin not implemented")),
    };
    const source = managedSourceFrom(native);
    const stop = source.onChange(() => {});
    expect(await source.read()).toEqual({ lockToPreset: true });
    stop();
  });

  test("reads the native config and forwards change events' config", async () => {
    let handler: ((e: unknown) => void) | null = null;
    let removed = false;
    const native: ManagedConfigNative = {
      get: async () => ({ config: { presetUrl: "x.example" } }),
      addListener: async (_name, l) => {
        handler = l;
        return {
          remove: async () => {
            removed = true;
          },
        };
      },
    };
    const source = managedSourceFrom(native);
    expect(await source.read()).toEqual({ presetUrl: "x.example" });
    const seen: unknown[] = [];
    const stop = source.onChange((raw) => seen.push(raw));
    await Promise.resolve();
    (handler as ((e: unknown) => void) | null)?.({ config: { lockToPreset: true } });
    (handler as ((e: unknown) => void) | null)?.("not an event");
    expect(seen).toEqual([{ lockToPreset: true }, undefined]);
    stop();
    await Promise.resolve();
    (handler as ((e: unknown) => void) | null)?.({ config: {} });
    expect(seen).toHaveLength(2);
    await Promise.resolve();
    expect(removed).toBe(true);
  });
});
