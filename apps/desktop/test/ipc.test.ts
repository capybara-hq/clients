import { describe, expect, test, vi } from "vitest";
import { createConfirmGate, createShellBridge, guardIpc } from "../src/main/ipc.ts";
import type { Profile } from "../src/main/profiles.ts";
import { fakeFrame } from "./fakes.ts";

const profile: Profile = {
  id: "p1",
  base: "https://capybara.example.com",
  origin: "https://capybara.example.com",
  name: "Example",
};

describe("guardIpc", () => {
  test("accepts the top frame of the exact origin", () => {
    expect(guardIpc({ senderFrame: fakeFrame(profile.origin) }, profile)).toBe(true);
  });

  test("refuses a sub-frame of the same origin (/plugin-ui embeds)", () => {
    const top = fakeFrame(profile.origin);
    expect(guardIpc({ senderFrame: fakeFrame(profile.origin, top) }, profile)).toBe(false);
  });

  test("refuses another origin, a look-alike and an app:// frame", () => {
    for (const origin of [
      "https://evil.example.com",
      "https://capybara.example.com:8443",
      "http://capybara.example.com",
      "app://address",
      "null",
    ]) {
      expect(guardIpc({ senderFrame: fakeFrame(origin) }, profile)).toBe(false);
    }
  });

  test("refuses a missing frame or a missing profile", () => {
    expect(guardIpc({ senderFrame: null }, profile)).toBe(false);
    expect(guardIpc({ senderFrame: undefined }, profile)).toBe(false);
    expect(guardIpc({ senderFrame: fakeFrame(profile.origin) }, undefined)).toBe(false);
  });
});

describe("the confirming-call gate", () => {
  test("no activation, busy while open, ok after release", () => {
    const gate = createConfirmGate();
    expect(gate.isConfirmingCallAllowed("p1", false)).toBe("no_activation");
    expect(gate.isConfirmingCallAllowed("p1", true)).toBe("ok");
    expect(gate.isConfirmingCallAllowed("p1", true)).toBe("busy");
    // Another profile has its own slot.
    expect(gate.isConfirmingCallAllowed("p2", true)).toBe("ok");
    gate.release("p1");
    expect(gate.isConfirmingCallAllowed("p1", true)).toBe("ok");
  });
});

function bridgeFor(
  target: { profile: Profile } | null = { profile },
  sendEvent?: (t: { profile: Profile }, message: unknown) => void,
) {
  return createShellBridge({
    resolveSender: () => target ?? undefined,
    ...(sendEvent && { sendEvent }),
    stateFor: () => ({
      insets: { top: 28, right: 0, bottom: 0, left: 0 },
      controls: { x: 0, y: 0, width: 80, height: 28 },
    }),
    platform: "macos",
    shellVersion: "1.2.3",
  });
}

const topEvent = (origin = profile.origin) => ({
  sender: { id: 1 },
  senderFrame: fakeFrame(origin),
});

describe("capability calls", () => {
  test("a registered function receives the caller's context and arguments", async () => {
    const b = bridgeFor();
    const open = vi.fn(async (_ctx: unknown, url: unknown) => `opened ${String(url)}`);
    b.registerCapability("openExternal@1", { open });
    const r = await b.handleCall(topEvent(), {
      key: "openExternal@1",
      fn: "open",
      args: ["https://x.example.com"],
      activation: false,
    });
    expect(r).toEqual({ ok: true, value: "opened https://x.example.com" });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ profile }),
      "https://x.example.com",
    );
  });

  test("unknown keys, unknown functions and prototype names are failed", async () => {
    const b = bridgeFor();
    b.registerCapability("notify@1", { notify: async () => undefined });
    for (const [key, fn] of [
      ["nope@1", "notify"],
      ["notify@1", "nope"],
      ["notify@1", "toString"],
      ["notify@1", "constructor"],
      ["notify@1", "__proto__"],
      ["__proto__", "notify"],
    ]) {
      expect(await b.handleCall(topEvent(), { key, fn, args: [], activation: true })).toEqual({
        ok: false,
        code: "failed",
      });
    }
  });

  test("a malformed request is failed", async () => {
    const b = bridgeFor();
    b.registerCapability("notify@1", { notify: async () => undefined });
    for (const raw of [
      null,
      "x",
      { key: "notify@1", fn: "notify" },
      { key: 1, fn: "n", args: [] },
    ]) {
      expect(await b.handleCall(topEvent(), raw)).toEqual({ ok: false, code: "failed" });
    }
  });

  test("a call from a sub-frame, another origin or an unknown window never runs", async () => {
    const notify = vi.fn(async () => undefined);
    const b = bridgeFor();
    b.registerCapability("notify@1", { notify });
    const req = { key: "notify@1", fn: "notify", args: [], activation: true };
    const sub = { sender: { id: 1 }, senderFrame: fakeFrame(profile.origin, {}) };
    expect(await b.handleCall(sub, req)).toEqual({ ok: false, code: "failed" });
    expect(await b.handleCall(topEvent("https://evil.example.com"), req)).toEqual({
      ok: false,
      code: "failed",
    });
    const orphan = bridgeFor(null);
    orphan.registerCapability("notify@1", { notify });
    expect(await orphan.handleCall(topEvent(), req)).toEqual({ ok: false, code: "failed" });
    expect(notify).not.toHaveBeenCalled();
  });

  test("errors cross as codes: a known code is kept, anything else is failed", async () => {
    const b = bridgeFor();
    b.registerCapability("x@1", {
      cancel: async () => {
        throw { code: "cancelled" };
      },
      boom: async () => {
        throw new Error("secret detail");
      },
      weird: async () => {
        throw { code: "something-else" };
      },
    });
    const call = (fn: string) =>
      b.handleCall(topEvent(), { key: "x@1", fn, args: [], activation: true });
    expect(await call("cancel")).toEqual({ ok: false, code: "cancelled" });
    expect(await call("boom")).toEqual({ ok: false, code: "failed" });
    expect(await call("weird")).toEqual({ ok: false, code: "failed" });
  });

  test("confirming calls need an activation and run one at a time per profile", async () => {
    const b = bridgeFor();
    let answer: (v: string) => void = () => {};
    const connect = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    b.registerCapability(
      "device@1",
      { connect, status: async () => "s" },
      { confirming: ["connect"] },
    );
    const req = (activation: boolean) => ({ key: "device@1", fn: "connect", args: [], activation });

    expect(await b.handleCall(topEvent(), req(false))).toEqual({
      ok: false,
      code: "no_activation",
    });
    expect(connect).not.toHaveBeenCalled();

    const first = b.handleCall(topEvent(), req(true));
    expect(await b.handleCall(topEvent(), req(true))).toEqual({ ok: false, code: "busy" });
    // A non-confirming function of the same capability is not gated.
    expect(await b.handleCall(topEvent(), { ...req(false), fn: "status" })).toEqual({
      ok: true,
      value: "s",
    });
    answer("connected");
    expect(await first).toEqual({ ok: true, value: "connected" });
    const second = b.handleCall(topEvent(), req(true));
    answer("cancelled");
    expect(await second).toEqual({ ok: true, value: "cancelled" });
  });

  test("activation-only calls need an activation but are not one-at-a-time (signIn@1)", async () => {
    const b = bridgeFor();
    let finish: (v: string) => void = () => {};
    const start = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    b.registerCapability("signIn@1", { start }, { activation: ["start"] });
    const req = (activation: boolean) => ({ key: "signIn@1", fn: "start", args: [], activation });
    expect(await b.handleCall(topEvent(), req(false))).toEqual({
      ok: false,
      code: "no_activation",
    });
    expect(start).not.toHaveBeenCalled();
    const first = b.handleCall(topEvent(), req(true));
    // No busy gate: a second start runs (and replaces the first attempt in the sign-in module).
    const second = b.handleCall(topEvent(), req(true));
    expect(start).toHaveBeenCalledTimes(2);
    finish("signedIn");
    expect(await second).toEqual({ ok: true, value: "signedIn" });
    void first;
  });

  test("activation names must be functions of the capability", () => {
    const b = bridgeFor();
    expect(() =>
      b.registerCapability("x@1", { a: async () => undefined }, { activation: ["b"] }),
    ).toThrow();
  });

  test("the busy flag is cleared when a confirming call rejects", async () => {
    const b = bridgeFor();
    b.registerCapability(
      "device@1",
      {
        connect: async () => {
          throw new Error("x");
        },
      },
      { confirming: ["connect"] },
    );
    const req = { key: "device@1", fn: "connect", args: [], activation: true };
    expect(await b.handleCall(topEvent(), req)).toEqual({ ok: false, code: "failed" });
    expect(await b.handleCall(topEvent(), req)).toEqual({ ok: false, code: "failed" });
  });

  test("registering a key twice is a programming error", () => {
    const b = bridgeFor();
    b.registerCapability("notify@1", { notify: async () => undefined });
    expect(() => b.registerCapability("notify@1", { notify: async () => undefined })).toThrow();
  });

  test("confirming names must be functions of the capability", () => {
    const b = bridgeFor();
    expect(() =>
      b.registerCapability("x@1", { a: async () => undefined }, { confirming: ["b"] }),
    ).toThrow();
  });
});

describe("descriptors and availability", () => {
  test("the preload sees only keys and function names", () => {
    const b = bridgeFor();
    b.registerCapability("notify@1", { notify: async () => undefined });
    b.registerCapability("chrome@1", { setAppearance: async () => undefined });
    expect(b.describe(profile)).toEqual({
      "notify@1": ["notify"],
      "chrome@1": ["setAppearance"],
    });
  });

  test("an unavailable capability is absent and refused", async () => {
    let available = false;
    const status = vi.fn(async () => "s");
    const b = bridgeFor();
    b.registerCapability("device@1", { status }, { available: () => available });
    expect(b.describe(profile)).toEqual({});
    const req = { key: "device@1", fn: "status", args: [], activation: false };
    expect(await b.handleCall(topEvent(), req)).toEqual({ ok: false, code: "failed" });
    available = true;
    expect(b.describe(profile)).toEqual({ "device@1": ["status"] });
    expect(await b.handleCall(topEvent(), req)).toEqual({ ok: true, value: "s" });
  });
});

describe("init", () => {
  test("the top frame of the profile origin gets the environment values", () => {
    const b = bridgeFor();
    b.registerCapability("notify@1", { notify: async () => undefined });
    expect(b.handleInit(topEvent())).toEqual({
      origin: profile.origin,
      platform: "macos",
      shellVersion: "1.2.3",
      insets: { top: 28, right: 0, bottom: 0, left: 0 },
      controls: { x: 0, y: 0, width: 80, height: 28 },
      capabilities: { "notify@1": ["notify"] },
    });
  });

  test("a sub-frame, another origin or an unknown window gets null", () => {
    const b = bridgeFor();
    expect(
      b.handleInit({ sender: { id: 1 }, senderFrame: fakeFrame(profile.origin, {}) }),
    ).toBeNull();
    expect(b.handleInit(topEvent("https://idp.example.com"))).toBeNull();
    expect(bridgeFor(null).handleInit(topEvent())).toBeNull();
  });
});

describe("confirming only when it turns out to need it", () => {
  test("ctx.confirm takes the slot: activation needed, busy while held, released after", async () => {
    const b = bridgeFor();
    let answer: (v: string) => void = () => {};
    b.registerCapability("device@1", {
      requestCeiling: (ctx: { confirm<T>(run: () => Promise<T>): Promise<T> }, widen: boolean) =>
        widen
          ? ctx.confirm(
              () =>
                new Promise<string>((resolve) => {
                  answer = resolve;
                }),
            )
          : Promise.resolve("applied"),
    });
    const req = (widen: boolean, activation: boolean) => ({
      key: "device@1",
      fn: "requestCeiling",
      args: [widen],
      activation,
    });
    // A narrowing needs neither an activation nor the slot.
    expect(await b.handleCall(topEvent(), req(false, false))).toEqual({
      ok: true,
      value: "applied",
    });
    expect(await b.handleCall(topEvent(), req(true, false))).toEqual({
      ok: false,
      code: "no_activation",
    });
    const first = b.handleCall(topEvent(), req(true, true));
    await Promise.resolve();
    expect(await b.handleCall(topEvent(), req(true, true))).toEqual({ ok: false, code: "busy" });
    answer("applied");
    expect(await first).toEqual({ ok: true, value: "applied" });
    const again = b.handleCall(topEvent(), req(true, true));
    await Promise.resolve();
    answer("cancelled");
    expect(await again).toEqual({ ok: true, value: "cancelled" });
  });

  test("ctx.confirm inside a statically confirming call reuses its slot", async () => {
    const b = bridgeFor();
    b.registerCapability(
      "device@1",
      {
        resume: (ctx: { confirm<T>(run: () => Promise<T>): Promise<T> }) =>
          ctx.confirm(async () => "resumed"),
      },
      { confirming: ["resume"] },
    );
    const req = { key: "device@1", fn: "resume", args: [], activation: true };
    expect(await b.handleCall(topEvent(), req)).toEqual({ ok: true, value: "resumed" });
    expect(await b.handleCall(topEvent(), req)).toEqual({ ok: true, value: "resumed" });
  });
});

describe("events (device@1.onStatus)", () => {
  function eventBridge() {
    const sent: { message: unknown }[] = [];
    const offs: string[] = [];
    let emitters: ((p: unknown) => void)[] = [];
    let available = true;
    const b = bridgeFor({ profile }, (_t, message) => sent.push({ message }));
    b.registerCapability(
      "device@1",
      { status: async () => "s" },
      {
        available: () => available,
        events: {
          onStatus: (_ctx, emit) => {
            emitters.push(emit);
            const n = emitters.length;
            return () => offs.push(`off${n}`);
          },
        },
      },
    );
    return {
      b,
      sent,
      offs,
      emit: (i: number, p: unknown) => emitters[i]?.(p),
      setAvailable: (v: boolean) => {
        available = v;
      },
      reset: () => {
        emitters = [];
      },
    };
  }
  const sub = (id: number, doc = "doc-aaaaaaaa", event = "onStatus") => ({
    key: "device@1",
    event,
    id,
    doc,
  });

  test("events are described apart from functions", () => {
    const { b } = eventBridge();
    expect(b.describe(profile)).toEqual({ "device@1": ["status"] });
    expect(b.describeEvents(profile)).toEqual({ "device@1": ["onStatus"] });
    expect(b.handleInit(topEvent())).toMatchObject({ events: { "device@1": ["onStatus"] } });
  });

  test("a subscription delivers to the calling document; unsubscribe ends it", () => {
    const e = eventBridge();
    expect(e.b.handleSubscribe(topEvent(), sub(1))).toBe(true);
    e.emit(0, { state: "not_connected" });
    expect(e.sent).toEqual([
      { message: { doc: "doc-aaaaaaaa", id: 1, payload: { state: "not_connected" } } },
    ]);
    e.b.handleUnsubscribe(topEvent(), { id: 1, doc: "doc-aaaaaaaa" });
    expect(e.offs).toEqual(["off1"]);
    e.emit(0, { state: "x" });
    expect(e.sent).toHaveLength(1);
  });

  test("a sub-frame, another origin, an unknown event or an unavailable capability is refused", () => {
    const e = eventBridge();
    expect(
      e.b.handleSubscribe(
        { sender: { id: 1 }, senderFrame: fakeFrame(profile.origin, {}) },
        sub(1),
      ),
    ).toBe(false);
    expect(e.b.handleSubscribe(topEvent("https://evil.example.com"), sub(2))).toBe(false);
    expect(e.b.handleSubscribe(topEvent(), sub(3, "doc-aaaaaaaa", "status"))).toBe(false);
    expect(e.b.handleSubscribe(topEvent(), sub(4, "doc-aaaaaaaa", "toString"))).toBe(false);
    for (const raw of [
      null,
      { ...sub(5), id: -1 },
      { ...sub(6), id: 1.5 },
      { ...sub(7), doc: "x" },
    ]) {
      expect(e.b.handleSubscribe(topEvent(), raw)).toBe(false);
    }
    e.setAvailable(false);
    expect(e.b.handleSubscribe(topEvent(), sub(8))).toBe(false);
  });

  test("a new document of the same window ends the old document's subscriptions", () => {
    const e = eventBridge();
    e.b.handleSubscribe(topEvent(), sub(1, "doc-aaaaaaaa"));
    e.b.handleSubscribe(topEvent(), sub(2, "doc-aaaaaaaa"));
    e.b.handleSubscribe(topEvent(), sub(1, "doc-bbbbbbbb"));
    expect(e.offs).toEqual(["off1", "off2"]);
  });

  test("a closed window drops every subscription it had", () => {
    const e = eventBridge();
    e.b.handleSubscribe(topEvent(), sub(1));
    e.b.handleSubscribe(topEvent(), sub(2));
    e.b.dropSubscriptions(1);
    expect(e.offs).toEqual(["off1", "off2"]);
  });

  test("a capability that becomes unavailable loses its subscriptions", () => {
    const e = eventBridge();
    e.b.handleSubscribe(topEvent(), sub(1));
    e.b.pruneSubscriptions();
    expect(e.offs).toEqual([]);
    e.setAvailable(false);
    e.b.pruneSubscriptions();
    expect(e.offs).toEqual(["off1"]);
  });

  test("a new document announcing itself ends the old document's subscriptions", () => {
    const e = eventBridge();
    e.b.handleSubscribe(topEvent(), sub(1, "doc-aaaaaaaa"));
    // The same document announcing again changes nothing.
    e.b.handleUnsubscribe(topEvent(), { doc: "doc-aaaaaaaa" });
    expect(e.offs).toEqual([]);
    e.b.handleUnsubscribe(topEvent(), { doc: "doc-bbbbbbbb" });
    expect(e.offs).toEqual(["off1"]);
  });

  test("an id already in use is refused", () => {
    const e = eventBridge();
    expect(e.b.handleSubscribe(topEvent(), sub(1))).toBe(true);
    expect(e.b.handleSubscribe(topEvent(), sub(1))).toBe(false);
  });
});
