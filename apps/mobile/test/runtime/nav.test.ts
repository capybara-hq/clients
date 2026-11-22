// nav@1 (mobile spec §5.2, §6.1; interaction model §10, minor version of 2026-11-22): the strip's
// pill on the iPhone Duo (the action, the sections, search) and the account avatar. The shape
// check, the badge text, availability and `side` that follow the strip, and native taps reaching
// the page's listeners. Fakes only: no WebView, no native.
import type { CapybaraShell } from "@capybara-hq/plugin-sdk";
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
  type NavState,
  navNativeFrom,
  stripAtStart,
  validateNavState,
} from "../../src/runtime/capabilities/nav.ts";
import type { HostPort } from "../../src/runtime/host-port.ts";
import type { ShellCallMessage, ShellCallResult } from "../../src/runtime/protocol.ts";
import { type CapabilityImpl, createRegistry } from "../../src/runtime/registry.ts";

const ORIGIN = "https://a.example";
const profile = { id: "p1", origin: ORIGIN };
const EVENTS = ["onSelect", "onAction", "onAccount"];

const full: NavState = {
  items: [
    { id: "chats", label: "对话" },
    { id: "inbox", label: "收件箱", count: 3 },
    { id: "agents", label: "智能体" },
    { id: "schedules", label: "定时任务" },
    { id: "search", label: "搜索" },
  ],
  current: "chats",
  action: { id: "new-conversation", label: "新会话", icon: "square-pen" },
  account: {
    name: "Grace Hopper",
    avatarUrl: "https://cdn.example/a.png",
    initial: "G",
    badge: 2,
  },
};

function withState(over: Record<string, unknown>): Record<string, unknown> {
  return { ...full, ...over };
}

const valid = (v: unknown, origin = ORIGIN) => validateNavState(v, origin);

describe("validateNavState", () => {
  test("accepts the full shape, without account, a guest without schedules, search last", () => {
    expect(valid(full)).toEqual(full);
    const { account: _a, ...noAccount } = full;
    expect(valid(noAccount)).toEqual(noAccount);
    const guest = withState({
      items: full.items.filter((i) => i.id !== "schedules"),
      current: "agents",
      action: { id: "new-agent", label: "新建智能体", icon: "plus" },
    });
    expect(valid(guest)).toEqual(guest);
    const noSearch = withState({ items: full.items.slice(0, 4) });
    expect(valid(noSearch)).toEqual(noSearch);
    const more = withState({
      items: [{ id: "inbox", label: "收件箱", count: 9999, countMore: true }],
      current: "inbox",
    });
    expect(valid(more)).toEqual(more);
  });

  test("current null (no section highlighted) is accepted", () => {
    expect(valid(withState({ current: null }))?.current).toBeNull();
  });

  test("rejects menu, unknown keys and a missing items, current or action", () => {
    expect(valid(withState({ menu: null }))).toBeNull();
    expect(valid(withState({ menu: { label: "菜单" } }))).toBeNull();
    expect(valid(withState({ visible: true }))).toBeNull();
    for (const key of ["items", "current", "action"]) {
      const copy = withState({});
      delete copy[key];
      expect(valid(copy), key).toBeNull();
    }
    expect(valid(withState({ action: null }))).toBeNull();
    expect(valid(null)).toBeNull();
    expect(valid([])).toBeNull();
  });

  test("rejects unknown ids, duplicates, items out of order and search before a section", () => {
    expect(valid(withState({ items: [{ id: "me", label: "我" }], current: null }))).toBeNull();
    const dup = [full.items[0], full.items[0]];
    expect(valid(withState({ items: dup }))).toBeNull();
    const swapped = [full.items[1], full.items[0]];
    expect(valid(withState({ items: swapped, current: null }))).toBeNull();
    const searchFirst = [full.items[4], full.items[0]];
    expect(valid(withState({ items: searchFirst, current: null }))).toBeNull();
    const six = [...full.items, { id: "chats", label: "x" }];
    expect(valid(withState({ items: six }))).toBeNull();
  });

  test("rejects an empty or 33-character label; counts code points like the web", () => {
    for (const label of ["", "x".repeat(33)]) {
      expect(valid(withState({ items: [{ id: "chats", label }] }))).toBeNull();
    }
    expect(valid(withState({ items: [{ id: "chats", label: "x".repeat(32) }] }))).not.toBeNull();
    // 32 emoji: 64 UTF-16 units, 32 characters.
    expect(valid(withState({ items: [{ id: "chats", label: "😀".repeat(32) }] }))).not.toBeNull();
    const item = { id: "chats", label: "对话", icon: "x" };
    expect(valid(withState({ items: [item] }))).toBeNull();
  });

  test("rejects out-of-range counts and a countMore that is not a boolean", () => {
    for (const count of [-1, 1.5, 10000, Number.NaN, "3"]) {
      const items = [{ id: "inbox", label: "收件箱", count }];
      expect(valid(withState({ items, current: null }))).toBeNull();
      expect(valid(withState({ account: { name: "A", initial: "A", badge: count } }))).toBeNull();
    }
    const items = [{ id: "inbox", label: "收件箱", countMore: "yes" }];
    expect(valid(withState({ items, current: null }))).toBeNull();
  });

  test("rejects current search, an id not among the items, or undefined", () => {
    expect(valid(withState({ current: "search" }))).toBeNull();
    expect(valid(withState({ current: "me" }))).toBeNull();
    const guest = full.items.filter((i) => i.id !== "schedules");
    expect(valid(withState({ items: guest, current: "schedules" }))).toBeNull();
    expect(valid(withState({ current: undefined }))).toBeNull();
  });

  test("rejects a bad action id, label or icon, and extra action keys", () => {
    const action = (over: Record<string, unknown>) =>
      withState({ action: { ...full.action, ...over } });
    for (const id of ["", "has space", "x".repeat(65), "a/b", 3]) {
      expect(valid(action({ id })), String(id)).toBeNull();
    }
    expect(valid(action({ id: "A.b_c-9" }))).not.toBeNull();
    for (const label of ["", "x".repeat(33)]) expect(valid(action({ label }))).toBeNull();
    for (const icon of ["pencil", "", undefined]) expect(valid(action({ icon }))).toBeNull();
    expect(valid(action({ glyph: "plus" }))).toBeNull();
  });

  test("account: name 1..64, initial 1..2, extra keys rejected", () => {
    const acct = (over: Record<string, unknown>) =>
      withState({ account: { name: "Grace", initial: "G", ...over } });
    expect(valid(acct({}))).not.toBeNull();
    expect(valid(acct({ name: "x".repeat(64), initial: "GH" }))).not.toBeNull();
    expect(valid(acct({ name: "" }))).toBeNull();
    expect(valid(acct({ name: "x".repeat(65) }))).toBeNull();
    expect(valid(acct({ initial: "" }))).toBeNull();
    expect(valid(acct({ initial: "GHI" }))).toBeNull();
    expect(valid(acct({ email: "g@example.com" }))).toBeNull();
    expect(valid(withState({ account: null }))).toBeNull();
  });

  test("avatarUrl: absolute https anywhere, plain http only on the profile's origin, or null", () => {
    const acct = (avatarUrl: unknown) =>
      withState({ account: { name: "Grace", initial: "G", avatarUrl } });
    expect(valid(acct("https://cdn.example/a.png"))?.account?.avatarUrl).toBe(
      "https://cdn.example/a.png",
    );
    expect(valid(acct(null))?.account?.avatarUrl).toBeNull();
    const local = "http://10.0.0.5:3000";
    expect(valid(acct(`${local}/api/avatar`), local)?.account?.avatarUrl).toBe(
      `${local}/api/avatar`,
    );
    for (const bad of [
      "http://evil.example/a.png",
      "http://a.example/a.png",
      "/api/avatar",
      "avatar.png",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "blob:https://a.example/x",
      `https://cdn.example/${"x".repeat(2048)}`,
      "",
      3,
    ]) {
      expect(valid(acct(bad)), String(bad).slice(0, 40)).toBeNull();
    }
    // Plain http on another port of the same host is another origin.
    expect(valid(acct("http://10.0.0.5:4000/a.png"), local)).toBeNull();
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

function setup(
  opts: {
    platform?: "ios" | "android";
    strip?: boolean | { visible: boolean; side: "left" | "right" };
  } = {},
) {
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

describe("availability and side follow the strip", () => {
  test("stripChanged(true) offers nav@1 with one change; false takes it away with one change", () => {
    const { host, registry, nav } = setup();
    expect(registry.descriptors(profile).capabilities[NAV_KEY]).toBeUndefined();
    expect(registry.descriptors(profile).fields).toBeUndefined();

    nav.stripChanged(true);
    const shown = registry.descriptors(profile);
    expect(shown.capabilities[NAV_KEY]).toEqual(["set"]);
    expect(shown.events[NAV_KEY]).toEqual(EVENTS);
    expect(shown.fields).toEqual({ [NAV_KEY]: { side: "right" } });
    expect(host.pushState).toHaveBeenCalledTimes(1);
    const [id, state] = host.pushState.mock.calls[0] ?? [];
    expect(id).toBe(profile.id);
    expect(state).toMatchObject({
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      capabilities: { [NAV_KEY]: ["set"] },
      events: { [NAV_KEY]: EVENTS },
      fields: { [NAV_KEY]: { side: "right" } },
    });

    nav.stripChanged(true);
    nav.stripChanged(true, "right");
    expect(host.pushState).toHaveBeenCalledTimes(1);

    nav.stripChanged(false);
    expect(host.pushState).toHaveBeenCalledTimes(2);
    const after = host.pushState.mock.calls[1]?.[1] as Record<string, object>;
    expect(after.capabilities).not.toHaveProperty(NAV_KEY);
    expect(after.events).not.toHaveProperty(NAV_KEY);
    expect(after).not.toHaveProperty("fields");
  });

  test("a split side change sends one change with the new side; nav@1 stays", () => {
    const { host, nav } = setup({ strip: { visible: true, side: "right" } });
    nav.stripChanged(true, "left");
    expect(host.pushState).toHaveBeenCalledTimes(1);
    expect(host.pushState.mock.calls[0]?.[1]).toMatchObject({
      capabilities: { [NAV_KEY]: ["set"] },
      fields: { [NAV_KEY]: { side: "left" } },
    });
    // The side without a strip is kept for when it returns.
    nav.stripChanged(false);
    nav.stripChanged(true);
    expect(host.pushState.mock.calls.at(-1)?.[1]).toMatchObject({
      fields: { [NAV_KEY]: { side: "left" } },
    });
    nav.stripChanged(true, "right");
    expect(host.pushState.mock.calls.at(-1)?.[1]).toMatchObject({
      fields: { [NAV_KEY]: { side: "right" } },
    });
  });

  test("a set while unavailable fails and reaches no native", async () => {
    const { native, registry } = setup();
    expect(await registry.dispatch(call("set", [full]))).toEqual({ ok: false, code: "failed" });
    expect(native.set).not.toHaveBeenCalled();
  });

  test("a set with the strip draws the items, the action and the account with badge text", async () => {
    const { native, registry } = setup({ strip: true });
    expect(await registry.dispatch(call("set", [full]))).toEqual({ ok: true, value: null });
    expect(native.set).toHaveBeenCalledWith({
      items: [
        { id: "chats", label: "对话", badge: null },
        { id: "inbox", label: "收件箱", badge: "3" },
        { id: "agents", label: "智能体", badge: null },
        { id: "schedules", label: "定时任务", badge: null },
        { id: "search", label: "搜索", badge: null },
      ],
      current: "chats",
      action: { id: "new-conversation", label: "新会话", icon: "square-pen" },
      account: {
        name: "Grace Hopper",
        avatarUrl: "https://cdn.example/a.png",
        initial: "G",
        badge: "2",
      },
    });
  });

  test("current null reaches native as null (the highlight clears), a later section selects", async () => {
    const { native, registry } = setup({ strip: true });
    await registry.dispatch(call("set", [withState({ current: "agents" })]));
    await registry.dispatch(call("set", [withState({ current: null })]));
    await registry.dispatch(call("set", [withState({ current: "inbox" })]));
    expect(native.set.mock.calls.map((c) => (c[0] as { current: unknown }).current)).toEqual([
      "agents",
      null,
      "inbox",
    ]);
  });

  test("no account draws none; an avatar left out is null natively", async () => {
    const { native, registry } = setup({ strip: true });
    const { account: _a, ...noAccount } = full;
    await registry.dispatch(call("set", [noAccount]));
    expect(native.set.mock.lastCall?.[0]).toMatchObject({ account: null });
    await registry.dispatch(call("set", [withState({ account: { name: "G", initial: "G" } })]));
    expect(native.set.mock.lastCall?.[0]).toMatchObject({
      account: { name: "G", initial: "G", avatarUrl: null, badge: null },
    });
  });

  test("an invalid set (the old shape with menu) fails and reaches no native", async () => {
    const { native, registry } = setup({ strip: true });
    const old = {
      items: full.items.slice(0, 4),
      current: "chats",
      menu: { label: "菜单", count: 3 },
    };
    expect(await registry.dispatch(call("set", [old]))).toEqual({ ok: false, code: "failed" });
    expect(native.set).not.toHaveBeenCalled();
  });

  test("a set from a profile that is not shown is kept and drawn when it shows", async () => {
    const { native, registry, nav, show } = setup({ strip: true });
    show(null);
    expect(await registry.dispatch(call("set", [full]))).toEqual({ ok: true, value: null });
    expect(native.set).not.toHaveBeenCalled();
    show(profile.id);
    nav.profileShown(profile.id);
    expect(native.set).toHaveBeenCalledTimes(1);
  });

  test("Android never registers nav@1, strip or not", () => {
    const { registry, nav } = setup({ platform: "android", strip: true });
    expect(registry.descriptors(profile).capabilities[NAV_KEY]).toBeUndefined();
    nav.stripChanged(true, "left");
    expect(registry.descriptors(profile).capabilities[NAV_KEY]).toBeUndefined();
    expect(registry.descriptors(profile).fields).toBeUndefined();
  });
});

describe("native taps reach the page", () => {
  test("sectionSelected reaches onSelect, also for the current section and search", () => {
    const { host, nav, registry } = setup({ strip: true });
    registry.descriptors(profile);
    nav.sectionSelected("agents");
    nav.sectionSelected("chats");
    nav.sectionSelected("search");
    expect(host.event.mock.calls).toEqual([
      [profile.id, NAV_KEY, "onSelect", "agents"],
      [profile.id, NAV_KEY, "onSelect", "chats"],
      [profile.id, NAV_KEY, "onSelect", "search"],
    ]);
  });

  test("actionTapped reaches onAction, accountTapped reaches onAccount", () => {
    const { host, nav } = setup({ strip: true });
    nav.actionTapped();
    nav.accountTapped();
    expect(host.event.mock.calls).toEqual([
      [profile.id, NAV_KEY, "onAction", null],
      [profile.id, NAV_KEY, "onAccount", null],
    ]);
  });

  test("an unknown item, no shown profile, or no strip sends nothing", () => {
    const { host, nav, show } = setup({ strip: true });
    nav.sectionSelected("me");
    nav.sectionSelected("menu");
    show(null);
    nav.sectionSelected("agents");
    nav.actionTapped();
    nav.accountTapped();
    show(profile.id);
    nav.stripChanged(false);
    nav.sectionSelected("agents");
    nav.actionTapped();
    nav.accountTapped();
    expect(host.event).not.toHaveBeenCalled();
  });
});

type PageNav = {
  set(state: unknown): Promise<unknown>;
  onSelect(l: (id: string) => void): () => void;
  onAction(l: () => void): () => void;
  onAccount(l: () => void): () => void;
  onMenu?: unknown;
  readonly side?: string;
};

describe("the page's capability object", () => {
  const init: InjectInit = {
    origin: ORIGIN,
    platform: "ios",
    shellVersion: "0.1.0",
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    capabilities: { [NAV_KEY]: ["set"] },
    events: { [NAV_KEY]: EVENTS },
    fields: { [NAV_KEY]: { side: "right" } },
  };

  function boot() {
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
    const navOf = () => target.capybaraShell?.capabilities[NAV_KEY] as PageNav | undefined;
    const send = (p: { type: string; [k: string]: unknown }) => push?.(p);
    return { navOf, send, target };
  }

  test("has set, onSelect, onAction, onAccount and side; no onMenu", () => {
    const { navOf, target } = boot();
    const nav = navOf();
    expect(typeof nav?.set).toBe("function");
    expect(typeof nav?.onSelect).toBe("function");
    expect(typeof nav?.onAction).toBe("function");
    expect(typeof nav?.onAccount).toBe("function");
    expect(nav?.side).toBe("right");
    expect(nav).not.toHaveProperty("onMenu");
    expect(target.capybaraShell?.kind).toBe("mobile");
  });

  test("each subscription delivers its event and stops after unsubscribe", () => {
    const { navOf, send } = boot();
    const nav = navOf();
    const select = vi.fn();
    const act = vi.fn();
    const acct = vi.fn();
    const offSelect = nav?.onSelect(select);
    const offAction = nav?.onAction(act);
    const offAccount = nav?.onAccount(acct);
    const event = (event: string, payload: unknown) =>
      send({ type: "event", key: NAV_KEY, event, payload });
    event("onSelect", "search");
    event("onAction", null);
    event("onAccount", null);
    expect(select).toHaveBeenCalledWith("search");
    expect(act).toHaveBeenCalledTimes(1);
    expect(acct).toHaveBeenCalledTimes(1);
    offSelect?.();
    offAction?.();
    offAccount?.();
    event("onSelect", "inbox");
    event("onAction", null);
    event("onAccount", null);
    expect(select).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledTimes(1);
    expect(acct).toHaveBeenCalledTimes(1);
  });

  test("a change updates side on a new object and fires change; the listeners stay", () => {
    const { navOf, send, target } = boot();
    const changed = vi.fn();
    target.capybaraShell?.on("change", changed);
    const act = vi.fn();
    navOf()?.onAction(act);
    send({
      type: "state",
      state: { ...init, fields: { [NAV_KEY]: { side: "left" } } },
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(navOf()?.side).toBe("left");
    send({ type: "event", key: NAV_KEY, event: "onAction", payload: null });
    expect(act).toHaveBeenCalledTimes(1);
  });

  test("a field never replaces a function, and a non-primitive field state is ignored", () => {
    const { navOf, send } = boot();
    send({
      type: "state",
      state: { ...init, fields: { [NAV_KEY]: { side: "left", set: "x", onAction: 1 } } },
    });
    expect(typeof navOf()?.set).toBe("function");
    expect(typeof navOf()?.onAction).toBe("function");
    send({ type: "state", state: { ...init, fields: { [NAV_KEY]: { side: { x: 1 } } } } });
    // Rejected whole: the last good state stays.
    expect(navOf()?.side).toBe("left");
  });

  test("a change without nav@1 drops its listeners; a strip that returns fires only new ones", () => {
    const { navOf, send } = boot();
    const old = vi.fn();
    const oldAction = vi.fn();
    navOf()?.onSelect(old);
    navOf()?.onAction(oldAction);
    const select = (id: string) =>
      send({ type: "event", key: NAV_KEY, event: "onSelect", payload: id });

    select("inbox");
    expect(old).toHaveBeenCalledWith("inbox");

    const insets = init.insets;
    send({ type: "state", state: { insets, capabilities: {}, events: {} } });
    expect(navOf()).toBeUndefined();
    send({ type: "state", state: init });
    const fresh = vi.fn();
    navOf()?.onSelect(fresh);
    select("agents");
    send({ type: "event", key: NAV_KEY, event: "onAction", payload: null });
    expect(old).toHaveBeenCalledTimes(1);
    expect(oldAction).not.toHaveBeenCalled();
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
    const nav = {
      stripChanged: vi.fn(),
      sectionSelected: vi.fn(),
      actionTapped: vi.fn(),
      accountTapped: vi.fn(),
    };
    const stop = connectStrip(plugin, nav);
    listeners.get("stripChanged")?.({ visible: true });
    listeners.get("stripChanged")?.({ visible: true, side: "left" });
    listeners.get("stripChanged")?.({ visible: true, side: "top" });
    listeners.get("stripChanged")?.({ visible: "yes" });
    listeners.get("sectionSelected")?.({ id: "inbox" });
    listeners.get("sectionSelected")?.({ id: 3 });
    listeners.get("actionTapped")?.({});
    listeners.get("accountTapped")?.({});
    expect(nav.stripChanged.mock.calls).toEqual([[true], [true, "left"], [true]]);
    expect(nav.sectionSelected.mock.calls).toEqual([["inbox"]]);
    expect(nav.actionTapped).toHaveBeenCalledTimes(1);
    expect(nav.accountTapped).toHaveBeenCalledTimes(1);
    expect(listeners.has("menuTapped")).toBe(false);
    stop();
    listeners.get("actionTapped")?.({});
    listeners.get("accountTapped")?.({});
    expect(nav.actionTapped).toHaveBeenCalledTimes(1);
    expect(nav.accountTapped).toHaveBeenCalledTimes(1);
  });

  test("stripAtStart reports the side, right when absent, none when native cannot say", async () => {
    expect(await stripAtStart({ stripState: async () => ({ visible: true }) })).toEqual({
      visible: true,
      side: "right",
    });
    expect(
      await stripAtStart({ stripState: async () => ({ visible: true, side: "left" as const }) }),
    ).toEqual({ visible: true, side: "left" });
    expect(await stripAtStart({ stripState: async () => Promise.reject(new Error("x")) })).toEqual({
      visible: false,
      side: "right",
    });
  });

  test("navNativeFrom hands the plugin the state", async () => {
    const navSet = vi.fn(async (_o: unknown) => {});
    const state = { items: [], current: null, action: null, account: null };
    await navNativeFrom({ navSet }).set(state);
    expect(navSet).toHaveBeenCalledWith({ state });
  });
});

describe("switching profiles", () => {
  const a = { id: "a", origin: "https://a.example" };
  const b = { id: "b", origin: "https://b.example" };
  const empty = { items: [], current: null, action: null, account: null };

  function twoProfiles() {
    const native = fakeNative();
    let list = [a, b];
    let shown: string | null = a.id;
    const registry = createRegistry({ host: fakeHost(), profiles: { list: () => list } });
    const nav = createNav({
      registry,
      native,
      profiles: () => list,
      shown: () => shown,
      strip: true,
    });
    const set = (p: typeof a) =>
      nav.capability.functions.set?.(
        {
          profile: p,
          origin: p.origin,
          docId: "d",
          activation: false,
          signal: new AbortController().signal,
        },
        full,
      );
    return {
      native,
      nav,
      set,
      show(id: string) {
        shown = id;
        nav.profileShown(id);
      },
      remove(id: string) {
        list = list.filter((p) => p.id !== id);
      },
    };
  }

  test("a profile that has not set its state shows an empty strip, not the previous one's", async () => {
    const { native, set, show } = twoProfiles();
    await set(a);
    show(b.id);
    expect(native.set).toHaveBeenLastCalledWith(empty);
    show(a.id);
    expect(native.set.mock.lastCall?.[0]).toMatchObject({ current: "chats" });
  });

  test("a removed profile's saved state is dropped", async () => {
    const { native, set, show, remove } = twoProfiles();
    await set(a);
    show(b.id);
    remove(a.id);
    show(b.id);
    // Re-added under the same id (a fresh profile): nothing of the old page is drawn.
    show(a.id);
    expect(native.set).toHaveBeenLastCalledWith(empty);
  });
});
