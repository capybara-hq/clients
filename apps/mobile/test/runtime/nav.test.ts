// nav@1 (mobile spec §5.2, §6.1): the strip's sections and menu button on the iPhone Duo. The
// shape check, the badge text, availability that follows the strip, and native taps reaching the
// page's listeners. Fakes only: no WebView, no native.
import type { CapybaraShell, NavStateV1 } from "@capybara-hq/plugin-sdk";
import { describe, expect, test, vi } from "vitest";
import {
  bootShellEnvironment,
  type InjectInit,
  type NativeTransport,
} from "../../src/inject/shell-environment.ts";
import { registerMobileCapabilities } from "../../src/runtime/capabilities/index.ts";
import {
  badgeText,
  connectStrip,
  createNav,
  NAV_KEY,
  type NavNativePort,
  navNativeFrom,
  stripAtStart,
  validateNavState,
} from "../../src/runtime/capabilities/nav.ts";
import type { HostPort } from "../../src/runtime/host-port.ts";
import type { ShellCallMessage, ShellCallResult } from "../../src/runtime/protocol.ts";
import { type CapabilityImpl, createRegistry } from "../../src/runtime/registry.ts";

const ORIGIN = "https://a.example";
const profile = { id: "p1", origin: ORIGIN };

const four: NavStateV1 = {
  items: [
    { id: "chats", label: "对话" },
    { id: "inbox", label: "收件箱", count: 3 },
    { id: "agents", label: "智能体" },
    { id: "schedules", label: "定时任务" },
  ],
  current: "chats",
  menu: { label: "菜单", count: 3 },
};

function withState(over: Record<string, unknown>): unknown {
  return { ...four, ...over };
}

describe("validateNavState", () => {
  test("accepts four items, three (a guest) and menu null", () => {
    expect(validateNavState(four)).toEqual(four);
    const guest = withState({ items: four.items.slice(0, 3), current: "agents" });
    expect(validateNavState(guest)).toEqual(guest);
    const noMenu = withState({ menu: null, current: null });
    expect(validateNavState(noMenu)).toEqual(noMenu);
    const more = withState({
      items: [{ id: "inbox", label: "收件箱", count: 9999, countMore: true }],
      current: "inbox",
    });
    expect(validateNavState(more)).toEqual(more);
  });

  test("rejects unknown ids, duplicates and items out of order", () => {
    expect(validateNavState(withState({ items: [{ id: "me", label: "我" }] }))).toBeNull();
    expect(validateNavState(withState({ items: [{ id: "files", label: "文件" }] }))).toBeNull();
    const dup = [four.items[0], four.items[0]];
    expect(validateNavState(withState({ items: dup }))).toBeNull();
    const swapped = [four.items[1], four.items[0]];
    expect(validateNavState(withState({ items: swapped, current: null }))).toBeNull();
  });

  test("rejects five items", () => {
    const five = [...four.items, { id: "chats", label: "x" }];
    expect(validateNavState(withState({ items: five }))).toBeNull();
  });

  test("rejects an empty or 33-character label", () => {
    for (const label of ["", "x".repeat(33)]) {
      const items = [{ id: "chats", label }];
      expect(validateNavState(withState({ items, current: null }))).toBeNull();
    }
    const items = [{ id: "chats", label: "x".repeat(32) }];
    expect(validateNavState(withState({ items, current: null }))).not.toBeNull();
  });

  test("rejects a count of -1, 1.5 or 10000, and a countMore that is not a boolean", () => {
    for (const count of [-1, 1.5, 10000, Number.NaN, "3"]) {
      const items = [{ id: "inbox", label: "收件箱", count }];
      expect(validateNavState(withState({ items, current: null }))).toBeNull();
      expect(validateNavState(withState({ menu: { label: "菜单", count } }))).toBeNull();
    }
    const items = [{ id: "inbox", label: "收件箱", countMore: "yes" }];
    expect(validateNavState(withState({ items, current: null }))).toBeNull();
  });

  test("rejects a current that is neither null nor an item's id", () => {
    expect(validateNavState(withState({ current: "me" }))).toBeNull();
    const guest = four.items.slice(0, 3);
    expect(validateNavState(withState({ items: guest, current: "schedules" }))).toBeNull();
    expect(validateNavState(withState({ current: undefined }))).toBeNull();
  });

  test("rejects a missing menu, an empty menu label and unknown keys", () => {
    const { menu: _menu, ...noMenu } = four;
    expect(validateNavState(noMenu)).toBeNull();
    expect(validateNavState(withState({ menu: { label: "" } }))).toBeNull();
    expect(validateNavState(withState({ visible: true }))).toBeNull();
    expect(validateNavState(withState({ menu: { label: "菜单", icon: "x" } }))).toBeNull();
    const items = [{ id: "chats", label: "对话", icon: "x" }];
    expect(validateNavState(withState({ items, current: null }))).toBeNull();
    expect(validateNavState(null)).toBeNull();
    expect(validateNavState([])).toBeNull();
  });
});

describe("badgeText", () => {
  test("caps at 99+, marks countMore, and shows nothing for 0 or no count", () => {
    expect(badgeText({ count: 120 })).toBe("99+");
    expect(badgeText({ count: 99 })).toBe("99");
    expect(badgeText({ count: 3, countMore: true })).toBe("3+");
    expect(badgeText({ count: 120, countMore: true })).toBe("99+");
    expect(badgeText({ count: 0 })).toBeNull();
    expect(badgeText({ count: 0, countMore: true })).toBeNull();
    expect(badgeText({})).toBeNull();
  });
});

function fakeHost() {
  return {
    onCall: vi.fn(() => () => {}),
    reply: vi.fn(async (_p: string, _c: string, _r: ShellCallResult) => {}),
    pushState: vi.fn(async (_p: string, _s: unknown) => {}),
    event: vi.fn(async (_p: string, _k: string, _e: string, _payload: unknown) => {}),
  } satisfies HostPort;
}

function fakeNative() {
  return { set: vi.fn(async (_state: unknown) => {}) } satisfies NavNativePort;
}

const noop: CapabilityImpl = { functions: { run: async () => "ok" } };

function setup(opts: { platform?: "ios" | "android"; strip?: boolean } = {}) {
  const host = fakeHost();
  const native = fakeNative();
  const registry = createRegistry({ host, profiles: { list: () => [profile] } });
  let shown: string | null = profile.id;
  const nav = createNav({
    registry,
    native,
    profiles: () => [profile],
    shown: () => shown,
    strip: opts.strip ?? false,
  });
  const fake = (): CapabilityImpl => noop;
  registerMobileCapabilities(registry, {
    platform: opts.platform ?? "ios",
    signIn: { capability: fake(), available: () => true },
    chrome: fake(),
    haptics: {
      impact: async () => {},
      notification: async () => {},
      selectionChanged: async () => {},
    },
    share: { share: async () => ({}) },
    menu: { show: async () => null, cancel: () => {} },
    openExternal: { open: async () => {} },
    nav,
  });
  return {
    host,
    native,
    registry,
    nav,
    show(id: string | null) {
      shown = id;
    },
  };
}

function call(fn: string, args: unknown[]): ShellCallMessage {
  return {
    profileId: profile.id,
    origin: ORIGIN,
    docId: "doc-0001-aaaa",
    callId: "1",
    key: NAV_KEY,
    fn,
    args,
    activation: false,
  };
}

describe("availability follows the strip", () => {
  test("stripChanged(true) offers nav@1 with one change; false takes it away with one change", () => {
    const { host, registry, nav } = setup();
    expect(registry.descriptors(profile).capabilities[NAV_KEY]).toBeUndefined();

    nav.stripChanged(true);
    const shown = registry.descriptors(profile);
    expect(shown.capabilities[NAV_KEY]).toEqual(["set"]);
    expect(shown.events[NAV_KEY]).toEqual(["onSelect", "onMenu"]);
    expect(host.pushState).toHaveBeenCalledTimes(1);
    const [id, state] = host.pushState.mock.calls[0] ?? [];
    expect(id).toBe(profile.id);
    expect(state).toMatchObject({
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      capabilities: { [NAV_KEY]: ["set"] },
      events: { [NAV_KEY]: ["onSelect", "onMenu"] },
    });

    nav.stripChanged(true);
    expect(host.pushState).toHaveBeenCalledTimes(1);

    nav.stripChanged(false);
    expect(host.pushState).toHaveBeenCalledTimes(2);
    const after = host.pushState.mock.calls[1]?.[1] as { capabilities: object; events: object };
    expect(after.capabilities).not.toHaveProperty(NAV_KEY);
    expect(after.events).not.toHaveProperty(NAV_KEY);
  });

  test("a set while unavailable fails and reaches no native", async () => {
    const { native, registry } = setup();
    expect(await registry.dispatch(call("set", [four]))).toEqual({ ok: false, code: "failed" });
    expect(native.set).not.toHaveBeenCalled();
  });

  test("a set with the strip draws the sections with their badge text", async () => {
    const { native, registry } = setup({ strip: true });
    expect(await registry.dispatch(call("set", [four]))).toEqual({ ok: true, value: null });
    expect(native.set).toHaveBeenCalledWith({
      items: [
        { id: "chats", label: "对话", badge: null },
        { id: "inbox", label: "收件箱", badge: "3" },
        { id: "agents", label: "智能体", badge: null },
        { id: "schedules", label: "定时任务", badge: null },
      ],
      current: "chats",
      menu: { label: "菜单", badge: "3" },
    });
  });

  test("an invalid set fails and reaches no native", async () => {
    const { native, registry } = setup({ strip: true });
    const bad = withState({ visible: true });
    expect(await registry.dispatch(call("set", [bad]))).toEqual({ ok: false, code: "failed" });
    expect(native.set).not.toHaveBeenCalled();
  });

  test("a set from a profile that is not shown is kept and drawn when it shows", async () => {
    const { native, registry, nav, show } = setup({ strip: true });
    show(null);
    expect(await registry.dispatch(call("set", [four]))).toEqual({ ok: true, value: null });
    expect(native.set).not.toHaveBeenCalled();
    show(profile.id);
    nav.profileShown(profile.id);
    expect(native.set).toHaveBeenCalledTimes(1);
  });

  test("Android never registers nav@1, strip or not", () => {
    const { registry, nav } = setup({ platform: "android", strip: true });
    expect(registry.descriptors(profile).capabilities[NAV_KEY]).toBeUndefined();
    nav.stripChanged(true);
    expect(registry.descriptors(profile).capabilities[NAV_KEY]).toBeUndefined();
  });
});

describe("native taps reach the page", () => {
  test("sectionSelected reaches onSelect, also for the current section", () => {
    const { host, nav, registry } = setup({ strip: true });
    registry.descriptors(profile);
    nav.sectionSelected("agents");
    nav.sectionSelected("chats");
    expect(host.event.mock.calls).toEqual([
      [profile.id, NAV_KEY, "onSelect", "agents"],
      [profile.id, NAV_KEY, "onSelect", "chats"],
    ]);
  });

  test("menuTapped reaches onMenu", () => {
    const { host, nav } = setup({ strip: true });
    nav.menuTapped();
    expect(host.event).toHaveBeenCalledWith(profile.id, NAV_KEY, "onMenu", null);
  });

  test("an unknown section, no shown profile, or no strip sends nothing", () => {
    const { host, nav, show } = setup({ strip: true });
    nav.sectionSelected("me");
    show(null);
    nav.sectionSelected("agents");
    nav.menuTapped();
    show(profile.id);
    nav.stripChanged(false);
    nav.sectionSelected("agents");
    nav.menuTapped();
    expect(host.event).not.toHaveBeenCalled();
  });
});

describe("the page's listeners", () => {
  const init: InjectInit = {
    origin: ORIGIN,
    platform: "ios",
    shellVersion: "0.1.0",
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    capabilities: { [NAV_KEY]: ["set"] },
    events: { [NAV_KEY]: ["onSelect", "onMenu"] },
  };

  test("a change without nav@1 drops its listeners; a strip that returns fires only new ones", () => {
    let push: ((p: { type: string; [k: string]: unknown }) => void) | undefined;
    const transport: NativeTransport = {
      call: async () => ({ ok: true, value: null }),
      hello: () => {},
      onPush: (l) => {
        push = l;
      },
    };
    const target: { capybaraShell?: CapybaraShell } = {};
    bootShellEnvironment({
      init,
      target,
      isTopFrame: true,
      windowOrigin: ORIGIN,
      randomId: () => "doc-1",
      userActivation: () => false,
      transport,
    });
    const navOf = () =>
      target.capybaraShell?.capabilities[NAV_KEY] as
        | { onSelect(l: (id: string) => void): () => void; onMenu(l: () => void): () => void }
        | undefined;
    const old = vi.fn();
    const oldMenu = vi.fn();
    navOf()?.onSelect(old);
    navOf()?.onMenu(oldMenu);
    const select = (id: string) =>
      push?.({ type: "event", key: NAV_KEY, event: "onSelect", payload: id });

    select("inbox");
    expect(old).toHaveBeenCalledWith("inbox");

    const insets = init.insets;
    push?.({ type: "state", state: { insets, capabilities: {}, events: {} } });
    expect(navOf()).toBeUndefined();
    push?.({
      type: "state",
      state: { insets, capabilities: init.capabilities, events: init.events },
    });
    const fresh = vi.fn();
    navOf()?.onSelect(fresh);
    select("agents");
    push?.({ type: "event", key: NAV_KEY, event: "onMenu", payload: null });
    expect(old).toHaveBeenCalledTimes(1);
    expect(oldMenu).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledWith("agents");
  });
});

describe("the native strip events", () => {
  test("connectStrip forwards well-formed events and stops on request", async () => {
    const listeners = new Map<string, (e: unknown) => void>();
    const plugin = {
      addListener: vi.fn(async (name: string, l: (e: unknown) => void) => {
        listeners.set(name, l);
        return { remove: async () => {} };
      }),
    };
    const nav = { stripChanged: vi.fn(), sectionSelected: vi.fn(), menuTapped: vi.fn() };
    const stop = connectStrip(plugin, nav);
    listeners.get("stripChanged")?.({ visible: true });
    listeners.get("stripChanged")?.({ visible: "yes" });
    listeners.get("sectionSelected")?.({ id: "inbox" });
    listeners.get("sectionSelected")?.({ id: 3 });
    listeners.get("menuTapped")?.({});
    expect(nav.stripChanged.mock.calls).toEqual([[true]]);
    expect(nav.sectionSelected.mock.calls).toEqual([["inbox"]]);
    expect(nav.menuTapped).toHaveBeenCalledTimes(1);
    stop();
    listeners.get("menuTapped")?.({});
    expect(nav.menuTapped).toHaveBeenCalledTimes(1);
  });

  test("stripAtStart is false when native cannot say", async () => {
    expect(await stripAtStart({ stripState: async () => ({ visible: true }) })).toBe(true);
    expect(await stripAtStart({ stripState: async () => Promise.reject(new Error("x")) })).toBe(
      false,
    );
  });

  test("navNativeFrom hands the plugin the state", async () => {
    const navSet = vi.fn(async (_o: unknown) => {});
    const state = { items: [], current: null, menu: null };
    await navNativeFrom({ navSet }).set(state);
    expect(navSet).toHaveBeenCalledWith({ state });
  });
});
