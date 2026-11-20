import { describe, expect, test, vi } from "vitest";
import { createHostPort, type HostPort } from "../../src/runtime/host-port.ts";
import type { ShellCallMessage, ShellCallResult } from "../../src/runtime/protocol.ts";
import { createRegistry, serveCalls } from "../../src/runtime/registry.ts";

const ORIGIN = "https://a.example";
const profile = { id: "p1", origin: ORIGIN };
const other = { id: "p2", origin: "https://b.example" };

function fakeHost() {
  let listener: ((msg: ShellCallMessage) => void) | undefined;
  const host = {
    onCall: vi.fn((l: (msg: ShellCallMessage) => void) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    }),
    reply: vi.fn(async (_p: string, _c: string, _r: ShellCallResult) => {}),
    pushState: vi.fn(async () => {}),
    event: vi.fn(async (_p: string, _k: string, _e: string, _payload: unknown) => {}),
    deliver(msg: ShellCallMessage) {
      listener?.(msg);
    },
  } satisfies HostPort & { deliver(msg: ShellCallMessage): void };
  return host;
}

function setup() {
  const host = fakeHost();
  const registry = createRegistry({ host, profiles: { list: () => [profile, other] } });
  return { host, registry };
}

function msg(over: Partial<ShellCallMessage> = {}): ShellCallMessage {
  return {
    profileId: "p1",
    origin: ORIGIN,
    docId: "doc-0001-aaaa",
    callId: "1",
    key: "test@1",
    fn: "run",
    args: [],
    activation: false,
    ...over,
  };
}

describe("dispatch", () => {
  test("an origin other than the profile's fails, and the impl is never called", async () => {
    const { registry } = setup();
    const run = vi.fn(async () => "v");
    registry.register("test@1", { functions: { run } });
    expect(await registry.dispatch(msg({ origin: "https://a.example:444" }))).toEqual({
      ok: false,
      code: "failed",
    });
    expect(await registry.dispatch(msg({ origin: "https://b.example" }))).toEqual({
      ok: false,
      code: "failed",
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("a call for an unknown profile fails", async () => {
    const { registry } = setup();
    const run = vi.fn(async () => "v");
    registry.register("test@1", { functions: { run } });
    expect(await registry.dispatch(msg({ profileId: "gone" }))).toEqual({
      ok: false,
      code: "failed",
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("passes the profile, origin, document and activation, then the arguments", async () => {
    const { registry } = setup();
    const run = vi.fn(async (..._a: unknown[]) => 42);
    registry.register("test@1", { functions: { run } });
    expect(await registry.dispatch(msg({ args: ["x", 2], activation: true }))).toEqual({
      ok: true,
      value: 42,
    });
    expect(run).toHaveBeenCalledWith(
      { profile, origin: ORIGIN, docId: "doc-0001-aaaa", activation: true },
      "x",
      2,
    );
  });

  test("an unknown key or function fails, prototype names included", async () => {
    const { registry } = setup();
    registry.register("test@1", { functions: { run: async () => 1 } });
    for (const m of [
      msg({ key: "other@1" }),
      msg({ fn: "missing" }),
      msg({ fn: "toString" }),
      msg({ fn: "constructor" }),
    ]) {
      expect(await registry.dispatch(m)).toEqual({ ok: false, code: "failed" });
    }
  });

  test("a malformed message fails", async () => {
    const { registry } = setup();
    const run = vi.fn(async () => 1);
    registry.register("test@1", { functions: { run } });
    const bad = [
      { ...msg(), args: "x" },
      { ...msg(), activation: "yes" },
      { ...msg(), key: "test" },
      { ...msg(), docId: "short" },
      null,
    ];
    for (const m of bad) {
      expect(await registry.dispatch(m as unknown as ShellCallMessage)).toEqual({
        ok: false,
        code: "failed",
      });
    }
    expect(run).not.toHaveBeenCalled();
  });

  test("a confirming function without an activation answers no_activation", async () => {
    const { registry } = setup();
    const show = vi.fn(async () => "id");
    registry.register("menu@1", { functions: { show }, confirming: ["show"] });
    expect(await registry.dispatch(msg({ key: "menu@1", fn: "show" }))).toEqual({
      ok: false,
      code: "no_activation",
    });
    expect(show).not.toHaveBeenCalled();
  });

  test("a second confirming call while the first is open is busy; after it settles one is accepted", async () => {
    const { registry } = setup();
    const resolvers: ((v: string) => void)[] = [];
    const show = vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)));
    registry.register("menu@1", { functions: { show }, confirming: ["show"] });
    const call = msg({ key: "menu@1", fn: "show", activation: true });
    const first = registry.dispatch(call);
    expect(await registry.dispatch({ ...call, callId: "2" })).toEqual({ ok: false, code: "busy" });
    // Another profile has its own slot.
    const otherCall = registry.dispatch({
      ...call,
      profileId: "p2",
      origin: "https://b.example",
      callId: "3",
    });
    expect(show).toHaveBeenCalledTimes(2);
    resolvers[0]?.("a");
    resolvers[1]?.("b");
    expect(await first).toEqual({ ok: true, value: "a" });
    expect(await otherCall).toEqual({ ok: true, value: "b" });
    const third = registry.dispatch({ ...call, callId: "4" });
    expect(show).toHaveBeenCalledTimes(3);
    resolvers[2]?.("c");
    expect(await third).toEqual({ ok: true, value: "c" });
  });

  test("a confirming call that throws releases the slot", async () => {
    const { registry } = setup();
    let fail = true;
    registry.register(
      "menu@1",
      {
        functions: {
          show: async () => {
            if (fail) throw new Error("boom");
            return "ok";
          },
        },
        confirming: ["show"],
      },
      {},
    );
    const call = msg({ key: "menu@1", fn: "show", activation: true });
    expect(await registry.dispatch(call)).toEqual({ ok: false, code: "failed" });
    fail = false;
    expect(await registry.dispatch(call)).toEqual({ ok: true, value: "ok" });
  });

  test("an impl throwing a non-ShellCallError fails; a ShellCallError code passes through", async () => {
    const { registry } = setup();
    registry.register("test@1", {
      functions: {
        plain: async () => {
          throw new Error("boom");
        },
        odd: async () => {
          throw { code: "EACCES" };
        },
        cancelled: async () => {
          throw Object.assign(new Error("x"), { code: "cancelled" });
        },
      },
    });
    expect(await registry.dispatch(msg({ fn: "plain" }))).toEqual({ ok: false, code: "failed" });
    expect(await registry.dispatch(msg({ fn: "odd" }))).toEqual({ ok: false, code: "failed" });
    expect(await registry.dispatch(msg({ fn: "cancelled" }))).toEqual({
      ok: false,
      code: "cancelled",
    });
  });

  test("available false: absent from descriptors and dispatch fails", async () => {
    const { registry } = setup();
    const run = vi.fn(async () => 1);
    registry.register(
      "push@1",
      { functions: { status: run }, events: ["onMessage"] },
      { available: (p) => p.id === "p2" },
    );
    registry.register("nav@1", { functions: { set: run }, events: ["onSelect"] });
    expect(registry.descriptors(profile)).toEqual({
      capabilities: { "nav@1": ["set"] },
      events: { "nav@1": ["onSelect"] },
    });
    expect(registry.descriptors(other)).toEqual({
      capabilities: { "push@1": ["status"], "nav@1": ["set"] },
      events: { "push@1": ["onMessage"], "nav@1": ["onSelect"] },
    });
    expect(await registry.dispatch(msg({ key: "push@1", fn: "status" }))).toEqual({
      ok: false,
      code: "failed",
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("an available() that throws counts as unavailable", async () => {
    const { registry } = setup();
    registry.register(
      "push@1",
      { functions: { status: async () => 1 } },
      {
        available: () => {
          throw new Error("x");
        },
      },
    );
    expect(registry.descriptors(profile).capabilities).toEqual({});
    expect(await registry.dispatch(msg({ key: "push@1", fn: "status" }))).toEqual({
      ok: false,
      code: "failed",
    });
  });
});

describe("emit", () => {
  test("reaches host.event only for declared events of a capability offered to the profile", () => {
    const { host, registry } = setup();
    registry.register("nav@1", { functions: { set: async () => {} }, events: ["onSelect"] });
    registry.register(
      "push@1",
      { functions: { status: async () => {} }, events: ["onMessage"] },
      { available: () => false },
    );
    registry.emit("p1", "nav@1", "onSelect", { id: "chats" });
    registry.emit("p1", "nav@1", "onOther", 1);
    registry.emit("p1", "push@1", "onMessage", 1);
    registry.emit("p1", "unknown@1", "onSelect", 1);
    registry.emit("gone", "nav@1", "onSelect", 1);
    expect(host.event).toHaveBeenCalledTimes(1);
    expect(host.event).toHaveBeenCalledWith("p1", "nav@1", "onSelect", { id: "chats" });
  });
});

describe("serveCalls", () => {
  test("answers each forwarded call through host.reply", async () => {
    const { host, registry } = setup();
    registry.register("test@1", { functions: { run: async () => "pong" } });
    const stop = serveCalls(host, registry);
    host.deliver(msg({ callId: "7" }));
    await vi.waitFor(() => expect(host.reply).toHaveBeenCalled());
    expect(host.reply).toHaveBeenCalledWith("p1", "7", { ok: true, value: "pong" });
    stop();
  });
});

describe("createHostPort", () => {
  test("forwards well-formed call events only and maps the plugin methods", async () => {
    let fire: ((m: unknown) => void) | undefined;
    const remove = vi.fn(async () => {});
    const plugin = {
      addListener: vi.fn(async (_e: "call", l: (m: unknown) => void) => {
        fire = l;
        return { remove };
      }),
      reply: vi.fn(async () => {}),
      pushState: vi.fn(async () => {}),
      event: vi.fn(async () => {}),
    };
    const port = createHostPort(plugin);
    const seen: ShellCallMessage[] = [];
    const stop = port.onCall((m) => seen.push(m));
    fire?.({ junk: true });
    fire?.(msg());
    expect(seen).toEqual([msg()]);
    await port.reply("p1", "1", { ok: false, code: "busy" });
    expect(plugin.reply).toHaveBeenCalledWith({
      profileId: "p1",
      callId: "1",
      result: { ok: false, code: "busy" },
    });
    await port.event("p1", "nav@1", "onSelect", { id: "me" });
    expect(plugin.event).toHaveBeenCalledWith({
      profileId: "p1",
      key: "nav@1",
      event: "onSelect",
      payload: { id: "me" },
    });
    stop();
    fire?.(msg());
    expect(seen).toHaveLength(1);
    await vi.waitFor(() => expect(remove).toHaveBeenCalled());
  });
});
