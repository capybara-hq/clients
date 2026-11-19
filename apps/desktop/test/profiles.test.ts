import { describe, expect, test } from "vitest";
import { createProfileStore, partitionFor } from "../src/main/profiles.ts";
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
    expect(p).toEqual({ id: "p1", ...example });
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
