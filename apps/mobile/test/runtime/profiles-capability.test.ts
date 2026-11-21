import { describe, expect, test, vi } from "vitest";
import type { MenuHostPort, MenuShowInput } from "../../src/runtime/capabilities/menu.ts";
import { createProfilesCapability, PROFILES_KEY } from "../../src/runtime/capabilities/profiles.ts";
import type { HostPort } from "../../src/runtime/host-port.ts";
import type { Profile, ProfileStore } from "../../src/runtime/profiles.ts";
import type { ShellCallMessage } from "../../src/runtime/protocol.ts";
import { createRegistry } from "../../src/runtime/registry.ts";

function profile(id: string, name: string | null): Profile {
  return {
    id,
    base: `https://${id}.example`,
    origin: `https://${id}.example`,
    name,
    iconUrl: null,
    dataStoreId: `store-${id}`,
    addedAt: 1,
  };
}

function setup(
  opts: { locked?: boolean; picks?: (m: MenuShowInput) => string | null; confirm?: boolean } = {},
) {
  const all = [profile("p1", "Acme"), profile("p2", "Beta"), profile("p3", null)];
  let current = all[0] as Profile;
  const store = {
    list: () => all,
    current: () => current,
    setCurrent: vi.fn(async (id: string) => {
      current = all.find((p) => p.id === id) as Profile;
      return "switched" as const;
    }),
    remove: vi.fn(async () => {}),
  } as unknown as ProfileStore;
  const shown: MenuShowInput[] = [];
  let release: (id: string | null) => void = () => {};
  const menu: MenuHostPort = {
    show: (input) => {
      shown.push(input);
      if (opts.picks) return Promise.resolve(opts.picks(input));
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    cancel: vi.fn(),
  };
  const openAddress = vi.fn(async () => {});
  const afterSwitch = vi.fn(async () => {});
  const afterRemove = vi.fn(async () => {});
  const confirm = vi.fn(async () => opts.confirm ?? true);
  const policy = { locked: opts.locked ?? false };
  const impl = createProfilesCapability({
    profiles: store,
    visible: () => [all[0] as Profile, all[1] as Profile, all[2] as Profile],
    menu,
    openAddress,
    policy: () => policy,
    confirm,
    afterSwitch,
    afterRemove,
  });
  const events: unknown[] = [];
  const replies: unknown[] = [];
  const host: HostPort = {
    onCall: () => () => {},
    reply: async (...a) => void replies.push(a),
    pushState: async () => {},
    event: async (...a) => void events.push(a),
  };
  const registry = createRegistry({
    host,
    profiles: { list: () => [{ id: "p1", origin: "https://p1.example" }] },
  });
  registry.register(PROFILES_KEY, impl, { available: () => !policy.locked });
  let n = 0;
  const call = (activation = true) =>
    registry.dispatch({
      profileId: "p1",
      origin: "https://p1.example",
      docId: "doc-0001-aaaa",
      callId: `c${++n}`,
      key: PROFILES_KEY,
      fn: "show",
      args: [],
      activation,
    } satisfies ShellCallMessage);
  return {
    registry,
    call,
    store,
    shown,
    release: (id: string | null) => release(id),
    openAddress,
    afterSwitch,
    afterRemove,
    confirm,
    events,
    replies,
    impl,
  };
}

describe("profiles@1", () => {
  test("show is confirming", () => {
    expect(setup().impl.confirming).toEqual(["show"]);
  });

  test("no activation is refused, a second show while open is busy", async () => {
    const s = setup();
    expect(await s.call(false)).toEqual({ ok: false, code: "no_activation" });
    const first = s.call();
    await vi.waitFor(() => expect(s.shown).toHaveLength(1));
    expect(await s.call()).toEqual({ ok: false, code: "busy" });
    s.release(null);
    expect(await first).toEqual({ ok: true, value: null });
  });

  test("a locked policy leaves profiles@1 out of the descriptors", () => {
    expect(
      setup({ locked: true }).registry.descriptors({ id: "p1", origin: "https://p1.example" })
        .capabilities,
    ).not.toHaveProperty(PROFILES_KEY);
    expect(
      setup().registry.descriptors({ id: "p1", origin: "https://p1.example" }).capabilities,
    ).toHaveProperty(PROFILES_KEY);
  });

  test("the sheet lists visible profiles, marks the current one, then add and remove", async () => {
    const s = setup({ picks: () => null });
    await s.call();
    const items = (s.shown[0] as MenuShowInput).items;
    expect(items.map((i) => i.label)).toEqual([
      "✓ Acme",
      "Beta",
      "p3.example",
      "Add a platform",
      "Remove this platform",
    ]);
    expect(items.at(-1)?.destructive).toBe(true);
  });

  test("picking another profile switches and tells the host", async () => {
    const s = setup({ picks: () => "profile-p2" });
    expect(await s.call()).toEqual({ ok: true, value: null });
    expect(s.store.setCurrent).toHaveBeenCalledWith("p2");
    expect(s.afterSwitch).toHaveBeenCalledTimes(1);
  });

  test("picking the current profile does nothing", async () => {
    const s = setup({ picks: () => "profile-p1" });
    await s.call();
    expect(s.store.setCurrent).not.toHaveBeenCalled();
  });

  test("a cancelled single-store switch opens nothing", async () => {
    const s = setup({ picks: () => "profile-p2" });
    (s.store.setCurrent as ReturnType<typeof vi.fn>).mockResolvedValueOnce("cancelled");
    await s.call();
    expect(s.afterSwitch).not.toHaveBeenCalled();
  });

  test("picking add opens the address page", async () => {
    const s = setup({ picks: () => "add" });
    expect(await s.call()).toEqual({ ok: true, value: null });
    expect(s.openAddress).toHaveBeenCalledTimes(1);
  });

  test("remove confirms first, then removes the current profile through the store", async () => {
    const s = setup({ picks: () => "remove" });
    expect(await s.call()).toEqual({ ok: true, value: null });
    expect(s.confirm).toHaveBeenCalledTimes(1);
    expect(s.store.remove).toHaveBeenCalledWith("p1");
    expect(s.afterRemove).toHaveBeenCalledTimes(1);
  });

  test("a declined remove keeps the profile", async () => {
    const s = setup({ picks: () => "remove", confirm: false });
    await s.call();
    expect(s.store.remove).not.toHaveBeenCalled();
  });

  test("dismissing does nothing", async () => {
    const s = setup({ picks: () => null });
    expect(await s.call()).toEqual({ ok: true, value: null });
    expect(s.store.setCurrent).not.toHaveBeenCalled();
    expect(s.openAddress).not.toHaveBeenCalled();
    expect(s.store.remove).not.toHaveBeenCalled();
  });

  test("whatever is picked, no profile data reaches the page", async () => {
    for (const pick of ["profile-p2", "add", "remove", null]) {
      const s = setup({ picks: () => pick });
      const result = JSON.stringify(await s.call());
      expect(result).toBe(JSON.stringify({ ok: true, value: null }));
      expect(JSON.stringify([s.events, s.replies])).not.toMatch(/p2|Beta|Acme|example/);
    }
  });

  test("a failing action answers failed without leaking", async () => {
    const s = setup({ picks: () => "add" });
    s.openAddress.mockRejectedValueOnce(new Error("Acme boom"));
    const r = await s.call();
    expect(r).toEqual({ ok: false, code: "failed" });
  });
});
