import { describe, expect, test, vi } from "vitest";
import {
  createPlistReader,
  ensureManagedProfiles,
  isAddressAllowed,
  parseManagedConfig,
  readManagedConfig,
} from "../src/main/managed.ts";
import { setupUpdates } from "../src/main/updates.ts";

const DIR = "/Library/Managed Preferences";
const APP = "com.capybarahq.desktop";

describe("parseManagedConfig", () => {
  test("reads every field of a valid dictionary", () => {
    expect(
      parseManagedConfig({
        profiles: ["capybara.example.com", "https://b.example.com/team/", "http://localhost:3000"],
        lockDeployments: true,
        autoUpdate: false,
        updateFeed: "https://updates.example.com/capybara",
        connectThisMachine: false,
      }),
    ).toEqual({
      profiles: [
        "https://capybara.example.com",
        "https://b.example.com/team",
        "http://localhost:3000",
      ],
      lockDeployments: true,
      autoUpdate: false,
      updateFeed: "https://updates.example.com/capybara",
      connectThisMachine: false,
    });
  });

  test("malformed values are dropped field by field", () => {
    expect(
      parseManagedConfig({
        profiles: ["ok.example.com", 5, null, "http://evil.example.com", "", "ok.example.com/"],
        lockDeployments: "yes",
        autoUpdate: 0,
        updateFeed: "http://updates.example.com",
        connectThisMachine: true,
      }),
    ).toEqual({
      profiles: ["https://ok.example.com"],
      autoUpdate: false,
      connectThisMachine: true,
    });
    expect(parseManagedConfig({ profiles: "a.example.com" })).toEqual({});
  });

  test("anything that is not a dictionary reads as empty", () => {
    for (const v of [undefined, null, "x", 3, [], [{ lockDeployments: true }]]) {
      expect(parseManagedConfig(v)).toEqual({});
    }
  });
});

describe("an invalid updateFeed turns updates off (R9)", () => {
  const managedUpdates = (
    raw: unknown,
    over: Parameters<typeof setupUpdates>[0]["managed"] = {},
  ) => {
    const setFeedURL = vi.fn();
    const handle = setupUpdates({
      autoUpdater: {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        setFeedURL,
        checkForUpdates: vi.fn(async () => undefined),
        on: vi.fn(),
      },
      managed: { ...parseManagedConfig(raw), ...over },
    });
    return { handle, setFeedURL };
  };

  test.each([
    "not a url",
    "http://updates.example.com",
    "https://u:p@updates.example.com",
    "ftp://updates.example.com",
    "",
    42,
    { url: "https://x" },
  ])("%j: no updates, never the GitHub feed", (feed) => {
    expect(parseManagedConfig({ updateFeed: feed })).toEqual({ autoUpdate: false });
    const { handle, setFeedURL } = managedUpdates({ updateFeed: feed });
    expect(handle).toMatchObject({ enabled: false, feed: null });
    expect(setFeedURL).not.toHaveBeenCalled();
  });

  test("a valid feed is used; an absent one means the default", () => {
    expect(managedUpdates({ updateFeed: "https://u.example.com/f" }).handle.feed).toEqual({
      provider: "generic",
      url: "https://u.example.com/f",
    });
    expect(managedUpdates({}).handle.feed).toMatchObject({ provider: "github" });
  });

  test("the per-user file cannot turn updates back on after an invalid system feed", () => {
    const files: Record<string, unknown> = {
      [`${DIR}/${APP}.plist`]: { updateFeed: "http://bad.example.com" },
      [`${DIR}/grant/${APP}.plist`]: { autoUpdate: true },
    };
    const config = readManagedConfig({ appId: APP, user: "grant", readPlist: (f) => files[f] });
    expect(config.autoUpdate).toBe(false);
    expect(managedUpdates({}, config).handle.enabled).toBe(false);
  });
});

describe("readManagedConfig", () => {
  test("a missing file is {}", () => {
    const readPlist = vi.fn((_file: string): unknown => undefined);
    expect(readManagedConfig({ appId: APP, user: "grant", readPlist })).toEqual({});
    expect(readPlist.mock.calls.map((c) => c[0])).toEqual([
      `${DIR}/${APP}.plist`,
      `${DIR}/grant/${APP}.plist`,
    ]);
  });

  test("the per-user file overrides the system one, but cannot lift a lock", () => {
    const files: Record<string, unknown> = {
      [`${DIR}/${APP}.plist`]: {
        lockDeployments: true,
        autoUpdate: true,
        profiles: ["a.example.com"],
      },
      [`${DIR}/grant/${APP}.plist`]: { lockDeployments: false, autoUpdate: false },
    };
    expect(readManagedConfig({ appId: APP, user: "grant", readPlist: (f) => files[f] })).toEqual({
      lockDeployments: true,
      autoUpdate: false,
      profiles: ["https://a.example.com"],
    });
  });

  test("the per-user file cannot replace the profiles of a system-wide lock", () => {
    const files: Record<string, unknown> = {
      [`${DIR}/${APP}.plist`]: { lockDeployments: true, profiles: ["a.example.com"] },
      [`${DIR}/grant/${APP}.plist`]: { profiles: ["evil.example.com"] },
    };
    const config = readManagedConfig({ appId: APP, user: "grant", readPlist: (f) => files[f] });
    expect(config.profiles).toEqual(["https://a.example.com"]);
    // Without a system lock the per-user list applies.
    const open = readManagedConfig({
      appId: APP,
      user: "grant",
      readPlist: (f) =>
        f.includes("/grant/") ? { profiles: ["b.example.com"] } : { profiles: ["a.example.com"] },
    });
    expect(open.profiles).toEqual(["https://b.example.com"]);
  });

  test("a user name that is not a plain name never reaches a path", () => {
    const readPlist = vi.fn(() => undefined);
    readManagedConfig({ appId: APP, user: "../etc", readPlist });
    expect(readPlist).toHaveBeenCalledTimes(1);
  });
});

describe("createPlistReader", () => {
  test("converts through plutil and parses the JSON", () => {
    const execFileSync = vi.fn(() => '{"autoUpdate":false}');
    const read = createPlistReader({ existsSync: () => true, execFileSync });
    expect(read("/x.plist")).toEqual({ autoUpdate: false });
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "/x.plist"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  test("no file, a failing plutil or bad JSON is undefined", () => {
    const execFileSync = vi.fn(() => "{}");
    expect(createPlistReader({ existsSync: () => false, execFileSync })("/x")).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
    const boom = () => {
      throw new Error("plutil failed");
    };
    expect(createPlistReader({ existsSync: () => true, execFileSync: boom })("/x")).toBeUndefined();
    expect(
      createPlistReader({ existsSync: () => true, execFileSync: () => "not json" })("/x"),
    ).toBeUndefined();
  });
});

describe("isAddressAllowed", () => {
  test("everything is allowed without a lock", () => {
    expect(isAddressAllowed({}, "anything.example.com")).toBe(true);
    expect(isAddressAllowed({ profiles: ["https://a.example.com"] }, "b.example.com")).toBe(true);
  });

  test("with a lock only the listed addresses, however they are typed", () => {
    const managed = { lockDeployments: true, profiles: ["https://a.example.com/team"] };
    expect(isAddressAllowed(managed, "a.example.com/team/")).toBe(true);
    expect(isAddressAllowed(managed, "https://A.example.com/team?x=1")).toBe(true);
    expect(isAddressAllowed(managed, "a.example.com")).toBe(false);
    expect(isAddressAllowed(managed, "evil.example.com")).toBe(false);
    expect(isAddressAllowed(managed, "")).toBe(false);
  });

  test("a lock with no list allows nothing", () => {
    expect(isAddressAllowed({ lockDeployments: true }, "a.example.com")).toBe(false);
  });
});

describe("ensureManagedProfiles", () => {
  const found = (base: string) => ({
    result: { ok: true as const, name: "N", host: "h", icon: null },
    candidate: { base, origin: new URL(base).origin, name: "N" },
  });

  test("adds each managed profile that is not saved yet, once it answers", async () => {
    const add = vi.fn();
    const discover = vi.fn(async (base: string) => found(base));
    const n = await ensureManagedProfiles(["https://a.example.com", "https://b.example.com"], {
      has: (b) => b === "https://a.example.com",
      discover,
      add,
    });
    expect(n).toBe(1);
    expect(discover).toHaveBeenCalledExactlyOnceWith("https://b.example.com");
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ base: "https://b.example.com" }));
  });

  test("an unreachable or too old deployment is skipped and does not stop the others", async () => {
    const add = vi.fn();
    const n = await ensureManagedProfiles(
      ["https://down.example.com", "https://old.example.com", "https://ok.example.com"],
      {
        has: () => false,
        discover: async (base) => {
          if (base.includes("down")) throw new Error("offline");
          if (base.includes("old")) return { result: { ok: false, error: "too_old" } };
          return found(base);
        },
        add,
      },
    );
    expect(n).toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  test("a deployment that answers with another address is not saved", async () => {
    const add = vi.fn();
    const n = await ensureManagedProfiles(["https://a.example.com"], {
      has: () => false,
      discover: async () => found("https://other.example.com"),
      add,
    });
    expect(n).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });
});
