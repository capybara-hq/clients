import { describe, expect, test } from "vitest";
import { brand as officialBrand } from "../../brand.ts";
import type { LoaderProfile } from "../../src/runtime/loader.ts";
import { createManagedPolicy, type ManagedSource } from "../../src/runtime/managed.ts";
import { createProfileAccess } from "../../src/runtime/profile-access.ts";
import {
  createProfileStore,
  type DataStorePort,
  type PrefsPort,
} from "../../src/runtime/profiles.ts";

const A = "https://a.example";
const B = "https://b.example";

function fakeLoader(allowed: () => LoaderProfile[]) {
  let shown: string | null = null;
  const log: string[] = [];
  return {
    log,
    loader: {
      shown: () => shown,
      async open(p: LoaderProfile) {
        if (!allowed().some((q) => q.id === p.id)) {
          log.push(`refused ${p.base}`);
          return;
        }
        shown = p.id;
        log.push(`open ${p.base}`);
      },
      async close(id: string) {
        if (shown === id) shown = null;
        log.push(`close ${id}`);
      },
    },
  };
}

async function setup(
  opts: {
    managed?: unknown;
    createFails?: () => boolean;
    single?: boolean;
    clearAllFails?: () => boolean;
  } = {},
) {
  const values = new Map<string, string>();
  const prefs: PrefsPort = {
    get: (k) => values.get(k) ?? null,
    set: async (k, v) => void values.set(k, v),
  };
  const storeCalls: string[] = [];
  const stores: DataStorePort = {
    mode: async () => (opts.single ? "single" : "multi"),
    create: async (id) => {
      if (opts.createFails?.()) throw new Error("native down");
      storeCalls.push(`create:${id}`);
    },
    remove: async (id) => void storeCalls.push(`remove:${id}`),
    clearAll: async () => {
      if (opts.clearAllFails?.()) throw new Error("clear failed");
      storeCalls.push("clearAll");
    },
  };
  let n = 0;
  const store = createProfileStore({
    prefs,
    stores,
    confirm: async () => true,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    now: () => n,
  });
  const b = await store.add({ base: B, name: "B", iconUrl: null });
  let listener: ((raw: unknown) => void) | null = null;
  const source: ManagedSource = {
    read: async () => opts.managed ?? {},
    onChange: (l) => {
      listener = l;
      return () => {};
    },
  };
  let reconcile: () => Promise<void> = async () => {};
  const policy = await createManagedPolicy({
    brand: { ...officialBrand, presetUrl: null, lockToPreset: false },
    source,
    profiles: store,
    changed: () => reconcile(),
  });
  const { loader, log } = fakeLoader(() => policy.visible());
  let addressShown = 0;
  const access = createProfileAccess({
    store,
    policy,
    loader,
    showAddress: () => {
      addressShown++;
    },
  });
  reconcile = () => access.reconcile();
  const emit = async (raw: unknown) => {
    listener?.(raw);
    await policy.settled();
  };
  return { store, policy, access, loader, log, b, emit, storeCalls, address: () => addressShown };
}

describe("profile access", () => {
  test("switching to a hidden id returns null and never switches", async () => {
    const { access, store, b, emit } = await setup();
    const a = await store.add({ base: A, name: "A", iconUrl: null });
    await store.setCurrent(a.id);
    await emit({ presetUrl: A, lockToPreset: true });
    expect(await access.switchTo(b.id)).toBeNull();
    expect(store.current()?.id).toBe(a.id);
    expect(await access.switchTo(a.id)).toMatchObject({ id: a.id });
  });

  test("add is refused under a lock that arrived after discovery", async () => {
    const { access, store, emit } = await setup();
    await emit({ presetUrl: A, lockToPreset: true });
    await expect(
      access.add({ base: "https://c.example", name: null, iconUrl: null }),
    ).rejects.toThrow("locked");
    expect(store.list().some((p) => p.base === "https://c.example")).toBe(false);
  });

  test("list follows a runtime change", async () => {
    const { access, emit } = await setup();
    expect(access.list().map((p) => p.base)).toEqual([B]);
    await emit({ presetUrl: A, lockToPreset: true });
    expect(access.list().map((p) => p.base)).toEqual([A]);
    await emit({});
    expect(
      access
        .list()
        .map((p) => p.base)
        .sort(),
    ).toEqual([A, B]);
  });

  test("a lock takes the shown hidden profile off screen and opens the preset", async () => {
    const { access, loader, log, b, emit, storeCalls } = await setup();
    await loader.open(b);
    await emit({ presetUrl: A, lockToPreset: true });
    expect(log).toEqual([`open ${B}`, `close ${b.id}`, `open ${A}`]);
    expect(storeCalls.some((c) => c.startsWith("remove:"))).toBe(false);
    expect(access.list().map((p) => p.base)).toEqual([A]);
  });

  test("a lock whose enforcement fails still takes the hidden profile off screen", async () => {
    let fail = false;
    const { loader, log, b, emit, address, store } = await setup({ createFails: () => fail });
    await loader.open(b);
    fail = true;
    await emit({ presetUrl: A, lockToPreset: true });
    expect(store.list().map((p) => p.base)).toEqual([B]);
    expect(loader.shown()).toBeNull();
    expect(log).toEqual([`open ${B}`, `close ${b.id}`]);
    expect(address()).toBe(1);
    // The loader refuses to bring it back (retry / a stale open).
    await loader.open(b);
    expect(loader.shown()).toBeNull();
  });

  test("a failed enforcement: the preset reconcile shows is made current too", async () => {
    let failures = 1;
    const { store, loader, log, b, emit } = await setup({
      single: true,
      clearAllFails: () => failures-- > 0,
    });
    const a = await store.add({ base: A, name: "A", iconUrl: null });
    await loader.open(b);
    // Enforcement's forced switch fails (clearAll); reconcile switches, then opens A.
    await emit({ presetUrl: A, lockToPreset: true });
    expect(store.current()?.id).toBe(a.id);
    expect(log).toEqual([`open ${B}`, `close ${b.id}`, `open ${A}`]);
  });

  test("a preset that cannot be made current is not shown: the address page is", async () => {
    const { store, loader, log, b, emit, address } = await setup({
      single: true,
      clearAllFails: () => true,
    });
    await store.add({ base: A, name: "A", iconUrl: null });
    await loader.open(b);
    await emit({ presetUrl: A, lockToPreset: true });
    expect(store.current()?.id).toBe(b.id);
    expect(log).toEqual([`open ${B}`, `close ${b.id}`]);
    expect(address()).toBe(1);
  });

  test("a lock with nothing on screen opens the preset", async () => {
    const { loader, log, emit } = await setup();
    await emit({ presetUrl: A, lockToPreset: true });
    expect(log.at(-1)).toBe(`open ${A}`);
    expect(loader.shown()).not.toBeNull();
  });

  test("lifting the lock closes nothing and moves nothing", async () => {
    const { log, emit } = await setup();
    await emit({ presetUrl: A, lockToPreset: true });
    const before = log.length;
    await emit({});
    expect(log.slice(before)).toEqual([]);
  });

  test("removing a profile closes its WebView before its store is deleted", async () => {
    const { store, b, log, storeCalls } = await setup();
    const order: string[] = [];
    store.onRemoved(() => {
      order.push(`log:${log.join(",")}`, `stores:${storeCalls.join(",")}`);
    });
    await store.remove(b.id);
    expect(log).toEqual([`close ${b.id}`]);
    expect(order[1]).not.toContain("remove:");
    expect(storeCalls).toContain(`remove:${b.dataStoreId}`);
  });

  describe("start", () => {
    test("opens the route's profile while visible", async () => {
      const { access, b } = await setup();
      expect(await access.start({ profileId: b.id })).toEqual({
        profile: expect.objectContaining({ id: b.id }),
        open: true,
      });
    });

    test("a route to a profile hidden during start falls back to the visible current one", async () => {
      const { access, store, b, emit } = await setup();
      const a = await store.add({ base: A, name: "A", iconUrl: null });
      await emit({ presetUrl: A, lockToPreset: true });
      const r = await access.start({ profileId: b.id });
      expect(r?.profile.id).toBe(a.id);
    });

    test("a profile a change already opened is not reopened", async () => {
      const { access, emit } = await setup();
      await emit({ presetUrl: A, lockToPreset: true });
      const r = await access.start("address");
      expect(r).toMatchObject({ profile: { base: A }, open: false });
    });

    test("the address route stays the address page", async () => {
      const { access } = await setup();
      expect(await access.start("address")).toBeNull();
    });
  });
});
