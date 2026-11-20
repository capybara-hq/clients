import { t } from "@capybara-hq/shell";
import { describe, expect, test } from "vitest";
import {
  createProfileStore,
  type DataStorePort,
  dataStorePortFrom,
  PROFILES_PREF_KEY,
  type PrefsPort,
  preloadPrefs,
} from "../../src/runtime/profiles.ts";

function fakePrefs(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const prefs: PrefsPort = {
    get: (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
  };
  return { prefs, values };
}

function fakeStores(mode: "multi" | "single" = "multi") {
  const calls: string[] = [];
  const stores: DataStorePort = {
    mode: async () => mode,
    create: async (id) => {
      calls.push(`create:${id}`);
    },
    remove: async (id) => {
      calls.push(`remove:${id}`);
    },
    clearAll: async () => {
      calls.push("clearAll");
    },
  };
  return { stores, calls };
}

function setup(
  opts: {
    mode?: "multi" | "single";
    prefs?: Record<string, string>;
    confirm?: boolean;
    locale?: "zh" | "en";
  } = {},
) {
  const { prefs, values } = fakePrefs(opts.prefs);
  const { stores, calls } = fakeStores(opts.mode);
  const asked: { message: string; ok: string; cancel: string }[] = [];
  let n = 0;
  const store = createProfileStore({
    prefs,
    stores,
    confirm: async (text) => {
      asked.push(text);
      calls.push("confirm");
      return opts.confirm ?? true;
    },
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    now: () => 1_000 + n,
    ...(opts.locale ? { locale: () => opts.locale as "zh" | "en" } : {}),
  });
  return { store, prefs, values, calls, asked };
}

const A = { base: "https://a.example", name: "A", iconUrl: null };
const B = { base: "https://b.example/team", name: null, iconUrl: "https://b.example/icon.png" };
const C = { base: "https://c.example", name: "C", iconUrl: null };

describe("add", () => {
  test("creates the profile's store right away and persists the entry", async () => {
    const { store, calls, values } = setup();
    const p = await store.add(A);
    expect(p).toMatchObject({ base: "https://a.example", origin: "https://a.example", name: "A" });
    expect(p.dataStoreId).not.toBe(p.id);
    expect(calls).toEqual([`create:${p.dataStoreId}`]);
    expect(JSON.parse(values.get(PROFILES_PREF_KEY) ?? "null").profiles).toHaveLength(1);
  });

  test("the same base twice returns the first profile", async () => {
    const { store, calls } = setup();
    const first = await store.add(A);
    const second = await store.add({ base: "a.example/", name: "Other", iconUrl: null });
    expect(second).toEqual(first);
    expect(store.list()).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("create:"))).toHaveLength(1);
  });

  test("keeps the base path and derives the origin", async () => {
    const { store } = setup();
    const p = await store.add(B);
    expect(p.base).toBe("https://b.example/team");
    expect(p.origin).toBe("https://b.example");
  });

  test("rejects an address that does not normalize", async () => {
    const { store, calls } = setup();
    await expect(
      store.add({ base: "http://insecure.example", name: null, iconUrl: null }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  test("the first profile becomes current; later ones do not switch", async () => {
    const { store } = setup();
    const a = await store.add(A);
    await store.add(B);
    expect(store.current()?.id).toBe(a.id);
  });

  test("survives a reload from prefs", async () => {
    const { store, values } = setup();
    const a = await store.add(A);
    const b = await store.add(B);
    await store.setCurrent(b.id);
    const again = setup({ prefs: Object.fromEntries(values) });
    expect(again.store.list().map((p) => p.id)).toEqual([a.id, b.id]);
    expect(again.store.current()?.id).toBe(b.id);
  });
});

describe("remove", () => {
  test("runs the onRemoved listeners, then removes the store, then drops the entry", async () => {
    const { store, calls } = setup();
    const a = await store.add(A);
    const seen: string[] = [];
    store.onRemoved(async (p) => {
      seen.push(p.id);
      calls.push(`listener:${p.id}`);
      expect(store.list().some((q) => q.id === p.id)).toBe(true);
    });
    await store.remove(a.id);
    expect(seen).toEqual([a.id]);
    expect(calls.slice(-2)).toEqual([`listener:${a.id}`, `remove:${a.dataStoreId}`]);
    expect(store.list()).toEqual([]);
  });

  test("a listener that throws does not stop the removal", async () => {
    const { store, calls } = setup();
    const a = await store.add(A);
    store.onRemoved(() => {
      throw new Error("push down");
    });
    await store.remove(a.id);
    expect(calls).toContain(`remove:${a.dataStoreId}`);
    expect(store.list()).toEqual([]);
  });

  test("an unsubscribed listener is not called", async () => {
    const { store } = setup();
    const a = await store.add(A);
    let called = false;
    const off = store.onRemoved(() => {
      called = true;
    });
    off();
    await store.remove(a.id);
    expect(called).toBe(false);
  });

  test("removing the current profile makes the next one current", async () => {
    const { store } = setup();
    const a = await store.add(A);
    const b = await store.add(B);
    await store.add(C);
    await store.remove(a.id);
    expect(store.current()?.id).toBe(b.id);
  });

  test("removing the current last profile makes the previous one current", async () => {
    const { store } = setup();
    const a = await store.add(A);
    const b = await store.add(B);
    await store.setCurrent(b.id);
    await store.remove(b.id);
    expect(store.current()?.id).toBe(a.id);
  });

  test("removing the only profile leaves no current one", async () => {
    const { store } = setup();
    const a = await store.add(A);
    await store.remove(a.id);
    expect(store.current()).toBeNull();
  });

  test("removing an unknown id does nothing", async () => {
    const { store, calls } = setup();
    await store.add(A);
    await store.remove("nope");
    expect(store.list()).toHaveLength(1);
    expect(calls.some((c) => c.startsWith("remove:"))).toBe(false);
  });
});

describe("setCurrent", () => {
  test("multi mode switches without asking", async () => {
    const { store, asked, calls } = setup();
    await store.add(A);
    const b = await store.add(B);
    expect(await store.setCurrent(b.id)).toBe("switched");
    expect(store.current()?.id).toBe(b.id);
    expect(asked).toEqual([]);
    expect(calls).not.toContain("clearAll");
  });

  test("single mode asks with the Decision 9 copy; on cancel nothing changes", async () => {
    const { store, asked, calls, values } = setup({ mode: "single", confirm: false, locale: "zh" });
    const a = await store.add(A);
    const b = await store.add(B);
    const before = values.get(PROFILES_PREF_KEY);
    expect(await store.setCurrent(b.id)).toBe("cancelled");
    expect(asked).toEqual([
      {
        message: t("zh", "profile.switch_confirm.message"),
        ok: t("zh", "profile.switch_confirm.confirm"),
        cancel: t("zh", "profile.switch_confirm.cancel"),
      },
    ]);
    expect(asked[0]).toEqual({
      message: "切换平台会退出当前平台的登录",
      ok: "切换",
      cancel: "取消",
    });
    expect(store.current()?.id).toBe(a.id);
    expect(calls).not.toContain("clearAll");
    expect(values.get(PROFILES_PREF_KEY)).toBe(before);
  });

  test("single mode on ok clears the store before the switch", async () => {
    const { store, calls, values } = setup({ mode: "single", confirm: true });
    await store.add(A);
    const b = await store.add(B);
    const before = calls.length;
    expect(await store.setCurrent(b.id)).toBe("switched");
    expect(calls.slice(before)).toEqual(["confirm", "clearAll"]);
    expect(JSON.parse(values.get(PROFILES_PREF_KEY) ?? "{}").currentId).toBe(b.id);
    expect(store.current()?.id).toBe(b.id);
  });

  test("single mode clears before the new current profile is stored", async () => {
    const { prefs, values } = fakePrefs();
    const order: string[] = [];
    let n = 0;
    const store = createProfileStore({
      prefs: {
        get: prefs.get,
        set: async (k, v) => {
          order.push(`set:${JSON.parse(v).currentId}`);
          await prefs.set(k, v);
        },
      },
      stores: {
        mode: async () => "single",
        create: async () => {},
        remove: async () => {},
        clearAll: async () => {
          order.push("clearAll");
        },
      },
      confirm: async () => true,
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      now: () => 0,
    });
    const a = await store.add(A);
    const b = await store.add(B);
    order.length = 0;
    await store.setCurrent(b.id);
    expect(order).toEqual(["clearAll", `set:${b.id}`]);
    expect(values.size).toBe(1);
    expect(a.id).not.toBe(b.id);
  });

  test("single mode uses the English copy by default", async () => {
    const { store, asked } = setup({ mode: "single", confirm: false });
    await store.add(A);
    const b = await store.add(B);
    await store.setCurrent(b.id);
    expect(asked[0]?.message).toBe(t("en", "profile.switch_confirm.message"));
  });

  test("the current profile again switches without asking", async () => {
    const { store, asked } = setup({ mode: "single" });
    const a = await store.add(A);
    expect(await store.setCurrent(a.id)).toBe("switched");
    expect(asked).toEqual([]);
  });

  test("an unknown id rejects", async () => {
    const { store } = setup();
    await expect(store.setCurrent("nope")).rejects.toThrow();
  });

  test("single mode: removing the current profile clears the shared store", async () => {
    const { store, calls } = setup({ mode: "single" });
    const a = await store.add(A);
    await store.add(B);
    await store.remove(a.id);
    expect(calls).toContain("clearAll");
    expect(calls).not.toContain(`remove:${a.dataStoreId}`);
  });

  test("single mode: removing another profile leaves the shared store alone", async () => {
    const { store, calls } = setup({ mode: "single" });
    await store.add(A);
    const b = await store.add(B);
    await store.remove(b.id);
    expect(calls).not.toContain("clearAll");
  });
});

describe("prefs", () => {
  test.each([
    ["not JSON", "{not json"],
    ["a JSON string", '"profiles"'],
    ["no profiles array", '{"version":1}'],
    ["profiles not an array", '{"version":1,"profiles":{}}'],
  ])("a corrupt value (%s) reads as no profiles", (_label, raw) => {
    const { store } = setup({ prefs: { [PROFILES_PREF_KEY]: raw } });
    expect(store.list()).toEqual([]);
    expect(store.current()).toBeNull();
  });

  test("a prefs read that throws reads as no profiles", () => {
    const store = createProfileStore({
      prefs: {
        get: () => {
          throw new Error("broken");
        },
        set: async () => {},
      },
      stores: fakeStores().stores,
      confirm: async () => true,
      newId: () => "x",
      now: () => 0,
    });
    expect(store.list()).toEqual([]);
  });

  test("invalid entries are skipped, valid ones kept", () => {
    const good = {
      id: "p1",
      base: "https://a.example",
      origin: "https://a.example",
      name: null,
      iconUrl: null,
      dataStoreId: "11111111-1111-4111-8111-111111111111",
      addedAt: 5,
    };
    const raw = JSON.stringify({
      version: 1,
      profiles: [
        good,
        { ...good, id: "p2", base: "http://evil.example", origin: "http://evil.example" },
        {
          ...good,
          id: "p3",
          base: "https://c.example",
          origin: "https://c.example",
          dataStoreId: "x",
        },
        { ...good, id: "p4", base: "https://d.example", origin: "https://x.example" },
        { ...good, id: "p5" },
        "nonsense",
      ],
      currentId: "p9",
    });
    const { store } = setup({ prefs: { [PROFILES_PREF_KEY]: raw } });
    expect(store.list()).toEqual([good]);
    expect(store.current()?.id).toBe("p1");
  });

  test("list returns copies", async () => {
    const { store } = setup();
    await store.add(A);
    const [p] = store.list();
    if (p) p.name = "changed";
    expect(store.list()[0]?.name).toBe("A");
  });

  test("preloadPrefs reads the keys once and writes through", async () => {
    const backing = new Map([["profiles", "x"]]);
    const reads: string[] = [];
    const prefs = await preloadPrefs(
      {
        get: async (k) => {
          reads.push(k);
          return backing.get(k) ?? null;
        },
        set: async (k, v) => {
          backing.set(k, v);
        },
      },
      ["profiles", "other"],
    );
    expect(prefs.get("profiles")).toBe("x");
    expect(prefs.get("other")).toBeNull();
    await prefs.set("other", "y");
    expect(prefs.get("other")).toBe("y");
    expect(backing.get("other")).toBe("y");
    expect(reads).toEqual(["profiles", "other"]);
  });
});

describe("dataStorePortFrom", () => {
  test("maps the native plugin's calls", async () => {
    const calls: unknown[] = [];
    const port = dataStorePortFrom({
      mode: async () => ({ mode: "single" }),
      create: async (o) => void calls.push(["create", o]),
      remove: async (o) => void calls.push(["remove", o]),
      clearAll: async () => void calls.push(["clearAll"]),
    });
    expect(await port.mode()).toBe("single");
    await port.create("a");
    await port.remove("b");
    await port.clearAll();
    expect(calls).toEqual([["create", { id: "a" }], ["remove", { id: "b" }], ["clearAll"]]);
  });

  test("an unexpected mode reads as single (the conservative store)", async () => {
    const port = dataStorePortFrom({
      mode: async () => ({ mode: "weird" as "multi" }),
      create: async () => {},
      remove: async () => {},
      clearAll: async () => {},
    });
    expect(await port.mode()).toBe("single");
  });
});
