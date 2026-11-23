import { describe, expect, test, vi } from "vitest";
import {
  createProfileStore,
  partitionFor,
  sweepAfterLoad,
  sweepOrphanPartitions,
} from "../src/main/profiles.ts";
import { fakeSession, memoryFs } from "./fakes.ts";

const FILE = "/user-data/profiles.json";

function setup(initial: Record<string, string> = {}) {
  const fs = memoryFs(initial);
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const sessionFor = (partition: string) => {
    let s = sessions.get(partition);
    if (!s) {
      s = fakeSession();
      sessions.set(partition, s);
    }
    return s;
  };
  let n = 0;
  const store = createProfileStore({
    file: FILE,
    fs,
    sessionFor,
    newId: () => `p${++n}`,
  });
  return { fs, store, sessions, sessionFor };
}

const example = {
  base: "https://capybara.example.com",
  origin: "https://capybara.example.com",
  name: "Example",
};

describe("profiles", () => {
  test("create and list, persisted with an atomic write", () => {
    const { fs, store } = setup();
    const p = store.add(example);
    expect(p).toEqual({ id: "p1", ...example, signedIn: false });
    expect(store.list()).toEqual([p]);
    const saved = JSON.parse(fs.files.get(FILE) as string);
    expect(saved.profiles).toEqual([p]);
    // Only the final file remains: the temporary file was renamed over it.
    expect([...fs.files.keys()]).toEqual([FILE]);
  });

  test("a second store over the same file reads the profiles back", () => {
    const { fs, store } = setup();
    store.add(example);
    const again = createProfileStore({
      file: FILE,
      fs,
      sessionFor: () => fakeSession(),
      newId: () => "x",
    });
    expect(again.list().map((p) => p.base)).toEqual([example.base]);
  });

  test("adding the same base again returns the existing profile", () => {
    const { store } = setup();
    const a = store.add(example);
    const b = store.add({ ...example, name: "Other" });
    expect(b.id).toBe(a.id);
    expect(store.list()).toHaveLength(1);
  });

  test("a provisional profile is saved under its own id (its partition holds the cookies)", () => {
    const { store } = setup();
    const p = store.add({ ...example, id: "prov-1", signedIn: true });
    expect(p).toMatchObject({ id: "prov-1", signedIn: true });
    expect(store.get("prov-1")?.base).toBe(example.base);
    expect(() =>
      store.add({
        ...example,
        base: "https://z.example.com",
        origin: "https://z.example.com",
        id: "prov-1",
      }),
    ).toThrow();
    expect(() =>
      store.add({
        ...example,
        base: "https://y.example.com",
        origin: "https://y.example.com",
        id: "../x",
      }),
    ).toThrow();
  });

  test("partition per profile", () => {
    expect(partitionFor("p1")).toBe("persist:profile-p1");
  });

  test("remove clears the partition through the injected session", async () => {
    const { store, sessions } = setup();
    const p = store.add(example);
    await store.remove(p.id);
    const s = sessions.get("persist:profile-p1");
    expect(s?.clearStorageData).toHaveBeenCalledTimes(1);
    expect(store.list()).toEqual([]);
  });

  test("a profile being removed reads as gone while its partition is cleared", async () => {
    const { store, sessionFor, fs } = setup();
    const a = store.add(example);
    const b = store.add({
      ...example,
      base: "https://b.example.com",
      origin: "https://b.example.com",
    });
    store.setLastUsed(a.id);
    let finish = () => {};
    vi.spyOn(sessionFor(partitionFor(a.id)), "clearStorageData").mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const removing = store.remove(a.id);
    // Nothing finds it to open a window on the partition being cleared.
    expect(store.get(a.id)).toBeUndefined();
    expect(store.list().map((p) => p.id)).toEqual([b.id]);
    expect(store.lastUsed()?.id).toBe(b.id);
    expect(store.update(a.id, { name: "Again" })).toBeUndefined();
    store.setLastUsed(a.id);
    expect(store.lastUsed()?.id).toBe(b.id);
    // Re-adding its address meanwhile is refused, not answered with the profile going away.
    expect(() => store.add(example)).toThrow("profile is being removed");
    // A second removal does not clear twice.
    await store.remove(a.id);
    // Still on disk until the clearing is done.
    expect(JSON.parse(fs.files.get(FILE) as string).profiles).toHaveLength(2);
    finish();
    await removing;
    expect(JSON.parse(fs.files.get(FILE) as string).profiles).toHaveLength(1);
    expect(store.get(a.id)).toBeUndefined();
  });

  test("a removal whose clearing fails gives the profile back", async () => {
    const { store, sessionFor } = setup();
    const a = store.add(example);
    vi.spyOn(sessionFor(partitionFor(a.id)), "clearStorageData").mockRejectedValue(
      new Error("disk full"),
    );
    await expect(store.remove(a.id)).rejects.toThrow("disk full");
    expect(store.get(a.id)?.id).toBe(a.id);
    expect(store.update(a.id, { name: "Kept" })?.name).toBe("Kept");
  });

  test("the last used profile is remembered and forgotten on remove", async () => {
    const { store, fs } = setup();
    const a = store.add(example);
    const b = store.add({
      ...example,
      base: "https://b.example.com",
      origin: "https://b.example.com",
    });
    expect(store.lastUsed()?.id).toBe(a.id);
    store.setLastUsed(b.id);
    expect(store.lastUsed()?.id).toBe(b.id);
    expect(JSON.parse(fs.files.get(FILE) as string).lastUsedId).toBe(b.id);
    await store.remove(b.id);
    expect(store.lastUsed()?.id).toBe(a.id);
  });

  test("a missing or corrupt file reads as empty, never throws", () => {
    expect(setup().store.list()).toEqual([]);
    expect(setup({ [FILE]: "{not json" }).store.list()).toEqual([]);
    expect(setup({ [FILE]: JSON.stringify({ profiles: "x" }) }).store.list()).toEqual([]);
  });

  test("a corrupt file is moved aside, never overwritten by the next save", () => {
    const { fs, store } = setup({ [FILE]: "{not json" });
    expect(fs.files.get(`${FILE}.corrupt`)).toBe("{not json");
    store.add(example);
    expect(fs.files.get(`${FILE}.corrupt`)).toBe("{not json");
    expect(JSON.parse(fs.files.get(FILE) as string).profiles).toHaveLength(1);
  });

  test("a missing file is not moved aside", () => {
    const { fs } = setup();
    expect(fs.files.has(`${FILE}.corrupt`)).toBe(false);
    expect(fs.log).toEqual([]);
  });

  test("the temporary file is synced before the rename", () => {
    const { fs, store } = setup();
    store.add(example);
    expect(fs.log).toEqual([
      `write ${FILE}.tmp`,
      `fsync ${FILE}.tmp`,
      `close ${FILE}.tmp`,
      `rename ${FILE}.tmp ${FILE}`,
    ]);
  });

  test("invalid entries are dropped on read", () => {
    const file = JSON.stringify({
      version: 1,
      lastUsedId: "evil",
      profiles: [
        { id: "ok1", ...example },
        {
          id: "../evil",
          ...example,
          base: "https://x.example.com",
          origin: "https://x.example.com",
        },
        { id: "o2", base: "http://10.0.0.5", origin: "http://10.0.0.5", name: "x" },
        { id: "o3", base: "https://a.example.com", origin: "https://b.example.com", name: "x" },
        { id: "o4", base: "https://c.example.com", origin: "https://c.example.com", name: 3 },
      ],
    });
    const { store } = setup({ [FILE]: file });
    expect(store.list().map((p) => p.id)).toEqual(["ok1"]);
    expect(store.lastUsed()?.id).toBe("ok1");
  });
});

describe("profile fields", () => {
  const stored = (p: Record<string, unknown>) =>
    JSON.stringify({ version: 1, profiles: [{ id: "a", ...example, ...p }], lastUsedId: null });
  const read = (p: Record<string, unknown>) => setup({ [FILE]: stored(p) }).store.get("a");

  test("an older file reads as signed in; a new profile starts signed out", () => {
    expect(read({})?.signedIn).toBe(true);
    expect(setup().store.add(example).signedIn).toBe(false);
  });

  test("valid optional fields are kept", () => {
    const tokens = {
      bg: "#000",
      panel: "#111",
      ink: "#fff",
      muted: "#888",
      line: "#222",
      accent: "#0f0",
      onAccent: "#000",
    };
    const p = read({
      signedIn: false,
      account: { name: "Ann", login: "ann" },
      bounds: { x: 1, y: 2, width: 800, height: 600 },
      appearance: { scheme: "dark", tokens, singleScheme: true },
    });
    expect(p).toMatchObject({
      signedIn: false,
      account: { name: "Ann", login: "ann" },
      bounds: { x: 1, y: 2, width: 800, height: 600 },
      appearance: { scheme: "dark", tokens, singleScheme: true },
    });
  });

  test("malformed optional fields are dropped, the profile stays", () => {
    const p = read({
      signedIn: "yes",
      account: { name: 1 },
      bounds: { x: 1, y: 2, width: -5, height: 600 },
      appearance: { scheme: "blue" },
    });
    expect(p).toEqual({ id: "a", ...example, signedIn: true });
    // Malformed tokens drop only the tokens: the scheme stays.
    expect(read({ appearance: { scheme: "light", tokens: { bg: "#fff" } } })?.appearance).toEqual({
      scheme: "light",
    });
    expect(
      read({ appearance: { scheme: "dark", tokens: { bg: "red", panel: "#111" } } })?.appearance,
    ).toEqual({ scheme: "dark" });
  });

  test("update: undefined deletes optional fields only", () => {
    const { store } = setup();
    const a = store.add({
      ...example,
      iconHash: "h",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      appearance: { scheme: "dark" },
    });
    store.update(a.id, { signedIn: true });
    const u = store.update(a.id, {
      // The type disallows undefined for these; at runtime it still means no change.
      ...({ name: undefined, signedIn: undefined } as object),
      iconHash: undefined,
      bounds: undefined,
      appearance: undefined,
    });
    expect(u?.name).toBe(example.name);
    expect(u?.signedIn).toBe(true);
    expect(u).not.toHaveProperty("iconHash");
    expect(u).not.toHaveProperty("bounds");
    expect(u).not.toHaveProperty("appearance");
  });

  test("update merges, removes undefined keys, ignores identity and persists", () => {
    const { fs, store } = setup();
    const a = store.add(example);
    const u = store.update(a.id, {
      signedIn: true,
      account: { name: "Ann", login: "ann" },
      // biome-ignore lint/suspicious/noExplicitAny: identity keys are not in the patch type
      ...({ base: "https://evil.example.com" } as any),
    });
    expect(u).toMatchObject({ signedIn: true, base: example.base });
    expect(store.update(a.id, { account: undefined })?.account).toBeUndefined();
    expect(JSON.parse(fs.files.get(FILE) as string).profiles[0].account).toBeUndefined();
    expect(store.update("nope", { signedIn: false })).toBeUndefined();
  });
});

describe("sweepOrphanPartitions", () => {
  const known = "11111111-2222-4333-8444-555555555555";
  const orphan = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  function fakeFs(names: string[]) {
    const removed: string[] = [];
    return {
      removed,
      readdirSync: (_p: string) => names,
      rmSync: (p: string, _o: { recursive: true; force: true }) => {
        removed.push(p);
      },
    };
  }
  const join = (...parts: string[]) => parts.join("/");

  test("removes only unsaved profile partitions; never local or anything else", () => {
    const fs = fakeFs([
      `profile-${known}`,
      `profile-${orphan}`,
      `profile-${orphan.toUpperCase()}`,
      "local",
      "profile-not-a-uuid",
      "something-else",
      `xprofile-${orphan}`,
    ]);
    const removed = sweepOrphanPartitions({
      partitionsDir: "/u/Partitions",
      knownIds: [known],
      fs,
      join,
    });
    expect(removed).toEqual([`profile-${orphan}`, `profile-${orphan.toUpperCase()}`]);
    expect(fs.removed).toEqual([
      `/u/Partitions/profile-${orphan}`,
      `/u/Partitions/profile-${orphan.toUpperCase()}`,
    ]);
  });

  test("no Partitions directory: nothing", () => {
    const fs = {
      readdirSync: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      rmSync: vi.fn(),
    };
    expect(
      sweepOrphanPartitions({ partitionsDir: "/u/Partitions", knownIds: [], fs, join }),
    ).toEqual([]);
    expect(fs.rmSync).not.toHaveBeenCalled();
  });
});

describe("sweepAfterLoad (the start-up guard)", () => {
  const saved = "11111111-2222-4333-8444-555555555555";
  const dropped = "22222222-3333-4444-8555-666666666666";
  const orphan = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const dirs = [`profile-${saved}`, `profile-${dropped}`, `profile-${orphan}`, "local"];
  const sweepFs = () => {
    const removed: string[] = [];
    return {
      removed,
      readdirSync: () => dirs,
      rmSync: (p: string) => {
        removed.push(p);
      },
    };
  };
  const join = (...parts: string[]) => parts.join("/");
  const run = (store: Parameters<typeof sweepAfterLoad>[0]) => {
    const fs = sweepFs();
    sweepAfterLoad(store, { partitionsDir: "/p", fs, join });
    return fs.removed;
  };

  test("a clean load: only the id the file never held is removed; a dropped entry's stays", () => {
    const file = JSON.stringify({
      version: 1,
      lastUsedId: null,
      profiles: [
        { id: saved, ...example },
        // Dropped on read (not normalized), but its partition is not an orphan.
        { id: dropped, base: "http://10.0.0.5", origin: "http://10.0.0.5", name: "x" },
      ],
    });
    const { store } = setup({ [FILE]: file });
    expect(store.list().map((p) => p.id)).toEqual([saved]);
    expect(store.loadReport()).toEqual({ loadedCleanly: true, seenIds: [saved, dropped] });
    expect(run(store)).toEqual([`/p/profile-${orphan}`]);
  });

  test("a missing file is clean: every profile partition is an orphan", () => {
    const { store } = setup();
    expect(store.loadReport().loadedCleanly).toBe(true);
    expect(run(store)).toHaveLength(3);
  });

  test("an unreadable file whose set-aside rename fails: nothing is deleted", () => {
    const fs = memoryFs();
    const broken = {
      ...fs,
      readFileSync: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      renameSync: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    const store = createProfileStore({
      file: FILE,
      fs: broken,
      sessionFor: () => fakeSession(),
      newId: () => "x",
    });
    expect(store.list()).toEqual([]);
    expect(store.loadReport().loadedCleanly).toBe(false);
    expect(run(store)).toEqual([]);
  });

  test("a corrupt file (set aside): nothing is deleted", () => {
    const { store, fs } = setup({ [FILE]: "{not json" });
    expect(fs.files.has(`${FILE}.corrupt`)).toBe(true);
    expect(run(store)).toEqual([]);
  });

  test("a profile added after start counts as known", () => {
    const { store } = setup();
    const added = store.add({ ...example, id: orphan });
    expect(store.loadReport().seenIds).toContain(added.id);
  });
});
