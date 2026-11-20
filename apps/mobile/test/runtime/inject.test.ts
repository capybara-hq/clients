// The shell environment script against fake documents (no WebView in vitest): the top frame on
// the profile origin gets a frozen `capybaraShell`; every other document gets nothing.
import { fileURLToPath } from "node:url";
import type { CapybaraShell } from "@capybara-hq/plugin-sdk";
import { build } from "esbuild";
import { describe, expect, test, vi } from "vitest";
import {
  androidTransport,
  bootShellEnvironment,
  type InjectDeps,
  type InjectInit,
  iosTransport,
  type NativeTransport,
} from "../../src/inject/shell-environment.ts";
import { createHostPort } from "../../src/runtime/host-port.ts";
import { createRegistry, serveCalls } from "../../src/runtime/registry.ts";

const ORIGIN = "https://a.example";

const init: InjectInit = {
  origin: ORIGIN,
  platform: "ios",
  shellVersion: "0.1.0",
  insets: { top: 0, right: 0, bottom: 49, left: 0 },
  capabilities: { "haptics@1": ["impact"], "nav@1": ["set"] },
  events: { "nav@1": ["onSelect"] },
};

function fakeTransport() {
  let push: ((p: { type: string; [k: string]: unknown }) => void) | undefined;
  const transport = {
    call: vi.fn(async (_post: unknown) => ({ ok: true, value: "pong" }) as const),
    hello: vi.fn((_doc: string) => {}),
    onPush(listener: (p: { type: string; [k: string]: unknown }) => void) {
      push = listener;
    },
    push(p: { type: string; [k: string]: unknown }) {
      push?.(p);
    },
  } satisfies NativeTransport & { push(p: unknown): void };
  return transport;
}

function boot(over: Partial<InjectDeps> = {}) {
  const transport = fakeTransport();
  const target: { capybaraShell?: CapybaraShell; Capacitor?: unknown } = {};
  let active = false;
  const installed = bootShellEnvironment({
    init,
    target,
    isTopFrame: true,
    windowOrigin: ORIGIN,
    randomId: () => "doc-1234-5678",
    userActivation: () => active,
    transport,
    ...over,
  });
  return {
    installed,
    transport,
    target,
    setActive(v: boolean) {
      active = v;
    },
  };
}

describe("where the script installs", () => {
  test("in an iframe nothing is defined", () => {
    const { installed, target, transport } = boot({ isTopFrame: false });
    expect(installed).toBe(false);
    expect(target.capybaraShell).toBeUndefined();
    expect(transport.hello).not.toHaveBeenCalled();
  });

  test("on another origin nothing is defined", () => {
    for (const windowOrigin of ["https://b.example", "https://a.example:444", "http://a.example"]) {
      const { installed, target } = boot({ windowOrigin });
      expect(installed).toBe(false);
      expect(target.capybaraShell).toBeUndefined();
    }
  });

  test("in an opaque-origin document (a sandbox CSP on the profile's URL) nothing is defined", () => {
    const { installed, target } = boot({ windowOrigin: "null" });
    expect(installed).toBe(false);
    expect(target.capybaraShell).toBeUndefined();
  });

  test("without the native endpoint, or with a malformed init, nothing is defined", () => {
    expect(boot({ transport: null }).target.capybaraShell).toBeUndefined();
    expect(boot({ init: { ...init, platform: "macos" } }).target.capybaraShell).toBeUndefined();
    expect(boot({ init: { ...init, insets: null } }).target.capybaraShell).toBeUndefined();
    expect(boot({ init: undefined }).target.capybaraShell).toBeUndefined();
  });
});

describe("a restored or restarted document", () => {
  test("a restart request and a bfcache restore each send a hello with a fresh id", async () => {
    let restart: (() => void) | undefined;
    let restore: (() => void) | undefined;
    const ids = ["doc-1", "doc-2", "doc-3"];
    const restored = vi.fn();
    const transport = Object.assign(fakeTransport(), {
      onRestart(l: () => void) {
        restart = l;
      },
      restored,
    });
    const { target } = boot({
      transport,
      randomId: () => ids.shift() ?? "x",
      onRestore: (l) => {
        restore = l;
      },
    });
    restart?.();
    restore?.();
    expect(transport.hello.mock.calls.map(([d]) => d)).toEqual(["doc-1", "doc-2", "doc-3"]);
    // Only the bfcache restore resets the transport's restart budget.
    expect(restored).toHaveBeenCalledTimes(1);
    const haptics = (target.capybaraShell as CapybaraShell).capabilities["haptics@1"] as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    await haptics.impact?.("light");
    expect(transport.call.mock.calls[0]?.[0]).toMatchObject({ docId: "doc-3" });
  });
});

describe("the top frame on the profile origin", () => {
  test("gets a frozen, unreplaceable global with the mobile values and no controls", () => {
    const { installed, target, transport } = boot();
    expect(installed).toBe(true);
    const shell = target.capybaraShell as CapybaraShell;
    expect(shell.kind).toBe("mobile");
    expect(shell.version).toBe(1);
    expect(shell.platform).toBe("ios");
    expect(shell.shellVersion).toBe("0.1.0");
    expect(shell.insets).toEqual({ top: 0, right: 0, bottom: 49, left: 0 });
    expect("controls" in shell).toBe(false);
    expect(Object.isFrozen(shell)).toBe(true);
    expect(() => {
      (target as Record<string, unknown>).capybaraShell = {};
    }).toThrow();
    expect(target.capybaraShell).toBe(shell);
    expect(transport.hello).toHaveBeenCalledWith("doc-1234-5678");
  });

  test("capability functions post key, fn, args and the activation read at call time", async () => {
    const { target, transport, setActive } = boot();
    const caps = (target.capybaraShell as CapybaraShell).capabilities as Record<
      string,
      Record<string, (...a: unknown[]) => Promise<unknown>>
    >;
    expect(await caps["haptics@1"]?.impact?.("light")).toBe("pong");
    setActive(true);
    await caps["nav@1"]?.set?.({ visible: true });
    expect(transport.call.mock.calls.map(([p]) => p)).toEqual([
      {
        type: "call",
        docId: "doc-1234-5678",
        callId: "1",
        key: "haptics@1",
        fn: "impact",
        args: ["light"],
        activation: false,
      },
      {
        type: "call",
        docId: "doc-1234-5678",
        callId: "2",
        key: "nav@1",
        fn: "set",
        args: [{ visible: true }],
        activation: true,
      },
    ]);
  });

  test("a failed result rejects with its code; a transport error is failed", async () => {
    const { target, transport } = boot();
    const haptics = (target.capybaraShell as CapybaraShell).capabilities["haptics@1"] as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    transport.call.mockResolvedValueOnce({ ok: false, code: "busy" } as never);
    await expect(haptics.impact?.("light")).rejects.toMatchObject({ code: "busy" });
    transport.call.mockRejectedValueOnce(new Error("gone"));
    await expect(haptics.impact?.("light")).rejects.toMatchObject({ code: "failed" });
  });

  test("native state pushes become change events; event pushes reach subscribers", () => {
    const { target, transport } = boot();
    const shell = target.capybaraShell as CapybaraShell;
    const changed = vi.fn();
    shell.on("change", changed);
    transport.push({
      type: "state",
      state: { insets: { top: 0, right: 0, bottom: 0, left: 0 }, capabilities: {} },
    });
    transport.push({ type: "state", state: { insets: "bad" } });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(shell.insets.bottom).toBe(0);
    expect(Object.keys(shell.capabilities)).toEqual([]);
  });

  test("event pushes reach the subscribers of that key and event", () => {
    const { target, transport } = boot();
    const nav = (target.capybaraShell as CapybaraShell).capabilities["nav@1"] as Record<
      string,
      (l: (p: unknown) => void) => () => void
    >;
    const seen = vi.fn();
    const stop = nav.onSelect?.(seen);
    transport.push({ type: "event", key: "nav@1", event: "onSelect", payload: { id: "me" } });
    transport.push({ type: "event", key: "nav@1", event: "onOther", payload: 1 });
    stop?.();
    transport.push({ type: "event", key: "nav@1", event: "onSelect", payload: { id: "x" } });
    expect(seen.mock.calls).toEqual([[{ id: "me" }]]);
  });

  test("window.Capacitor is never touched", () => {
    const target = new Proxy<Record<string, unknown>>(
      {},
      {
        get(t, p) {
          if (p === "Capacitor") throw new Error("read Capacitor");
          return t[p as string];
        },
        defineProperty(t, p, d) {
          if (p === "Capacitor") throw new Error("defined Capacitor");
          return Reflect.defineProperty(t, p, d);
        },
        has(t, p) {
          if (p === "Capacitor") throw new Error("checked Capacitor");
          return p in t;
        },
      },
    );
    expect(boot({ target }).installed).toBe(true);
  });

  test("the bundle never names Capacitor and pulls in no Node module", async () => {
    const out = await build({
      entryPoints: [
        fileURLToPath(new URL("../../src/inject/shell-environment.ts", import.meta.url)),
      ],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      minify: true,
      logLevel: "silent",
    });
    const code = out.outputFiles[0]?.text ?? "";
    expect(code.length).toBeGreaterThan(1000);
    expect(code).not.toMatch(/Capacitor/);
    expect(code).not.toMatch(/node:|require\(/);
  });
});

describe("the iOS transport", () => {
  function fakeWebkit(reply: (m: unknown) => Promise<unknown>) {
    const posted: unknown[] = [];
    const win = {
      webkit: {
        messageHandlers: {
          capybaraShell: {
            postMessage: (m: unknown) => {
              posted.push(m);
              return reply(m);
            },
          },
        },
      },
    };
    return { win, posted };
  }

  test("is null without the handler", () => {
    expect(iosTransport({})).toBeNull();
  });

  test("resolves native results, and a drop (rejection) as failed", async () => {
    const { win } = fakeWebkit(async (m) => {
      if ((m as { key?: string }).key === "denied@1") throw new Error("denied");
      return { ok: true, value: 1 };
    });
    const t = iosTransport(win);
    const base = { type: "call", docId: "doc-1234-5678", callId: "1", fn: "f" } as const;
    expect(await t?.call({ ...base, args: [], key: "a@1", activation: false })).toEqual({
      ok: true,
      value: 1,
    });
    expect(await t?.call({ ...base, args: [], key: "denied@1", activation: false })).toEqual({
      ok: false,
      code: "failed",
    });
  });

  test("after hello it keeps one listen outstanding and delivers what native answers", async () => {
    const listens: ((v: unknown) => void)[] = [];
    const { win, posted } = fakeWebkit((m) => {
      const type = (m as { type: string }).type;
      if (type === "hello") return Promise.resolve(true);
      return new Promise((resolve) => listens.push(resolve));
    });
    const t = iosTransport(win);
    const seen = vi.fn();
    t?.onPush(seen);
    t?.hello("doc-1234-5678");
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    expect(posted).toEqual([
      { type: "hello", docId: "doc-1234-5678" },
      { type: "listen", docId: "doc-1234-5678" },
    ]);
    listens[0]?.([{ type: "state", state: 1 }, null, { type: "event", key: "a@1" }]);
    await vi.waitFor(() => expect(listens).toHaveLength(2));
    expect(seen.mock.calls).toEqual([
      [{ type: "state", state: 1 }],
      [{ type: "event", key: "a@1" }],
    ]);
    // Only one listen is ever outstanding.
    expect(posted.filter((p) => (p as { type: string }).type === "listen")).toHaveLength(2);
  });

  test("a rejected listen asks for a fresh hello, at most three times in a row", async () => {
    const posted: { type: string; docId: string }[] = [];
    const { win } = fakeWebkit((m) => {
      posted.push(m as { type: string; docId: string });
      if ((m as { type: string }).type === "hello") return Promise.resolve(true);
      return Promise.reject(new Error("gone"));
    });
    const t = iosTransport(win);
    let n = 0;
    t?.onRestart?.(() => {
      n += 1;
      t.hello(`doc-${n}`);
    });
    t?.hello("doc-0");
    await vi.waitFor(() => expect(posted.filter((p) => p.type === "listen")).toHaveLength(4));
    await new Promise((r) => setImmediate(r));
    expect(n).toBe(3);
    expect(posted.filter((p) => p.type === "hello").map((p) => p.docId)).toEqual([
      "doc-0",
      "doc-1",
      "doc-2",
      "doc-3",
    ]);
  });

  test("a bfcache restore resets the restart budget", async () => {
    const posted: { type: string; docId: string }[] = [];
    const { win } = fakeWebkit((m) => {
      posted.push(m as { type: string; docId: string });
      if ((m as { type: string }).type === "hello") return Promise.resolve(true);
      return Promise.reject(new Error("gone"));
    });
    const t = iosTransport(win);
    let n = 0;
    t?.onRestart?.(() => {
      n += 1;
      t.hello(`doc-${n}`);
    });
    t?.hello("doc-0");
    await vi.waitFor(() => expect(posted.filter((p) => p.type === "listen")).toHaveLength(4));
    await new Promise((r) => setImmediate(r));
    expect(n).toBe(3);
    // The page came back from the back/forward cache: a fresh hello gets a fresh budget.
    t?.restored?.();
    t?.hello("doc-r");
    await vi.waitFor(() => expect(posted.filter((p) => p.type === "listen")).toHaveLength(8));
    await new Promise((r) => setImmediate(r));
    expect(n).toBe(6);
  });

  test("a superseded document id's listen stops without restarting", async () => {
    const listens: ((v: unknown) => void)[] = [];
    const { win } = fakeWebkit((m) => {
      if ((m as { type: string }).type === "hello") return Promise.resolve(true);
      return new Promise((resolve) => listens.push(resolve));
    });
    const t = iosTransport(win);
    const restart = vi.fn();
    t?.onRestart?.(restart);
    t?.onPush(vi.fn());
    t?.hello("doc-a");
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    t?.hello("doc-b");
    await vi.waitFor(() => expect(listens).toHaveLength(2));
    listens[0]?.([]);
    await new Promise((r) => setImmediate(r));
    expect(listens).toHaveLength(2);
    expect(restart).not.toHaveBeenCalled();
  });

  test("a rejected listen (the document ended, or a drop) ends the loop", async () => {
    let listens = 0;
    const { win } = fakeWebkit((m) => {
      if ((m as { type: string }).type === "hello") return Promise.resolve(true);
      listens += 1;
      return Promise.reject(new Error("gone"));
    });
    const t = iosTransport(win);
    t?.onPush(vi.fn());
    t?.hello("doc-1234-5678");
    await vi.waitFor(() => expect(listens).toBe(1));
    await new Promise((r) => setImmediate(r));
    expect(listens).toBe(1);
  });

  test("defines no global receiver a page could imitate", () => {
    const { win } = fakeWebkit(async () => true);
    iosTransport(win)?.hello("doc-1234-5678");
    expect(Object.keys(win)).toEqual(["webkit"]);
  });
});

/**
 * The whole hop a call takes on iOS, with JSON at both native crossings: page script → native
 * (adds profile, origin, its own call id) → the CapybaraHost plugin's `call` event → registry →
 * plugin `reply` → native → the page's promise; and a push through the listen loop.
 */
describe("the host hop end to end", () => {
  function fakeNative() {
    const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    let pluginListener: ((m: unknown) => void) | undefined;
    const pending = new Map<string, (v: unknown) => void>();
    let listen: ((v: unknown) => void) | undefined;
    const queue: unknown[] = [];
    let n = 0;
    const flush = () => {
      if (listen && queue.length > 0) {
        const answer = listen;
        listen = undefined;
        answer(json(queue.splice(0)));
      }
    };
    const plugin = {
      addListener: async (_e: "call", l: (m: unknown) => void) => {
        pluginListener = l;
        return { remove: async () => {} };
      },
      reply: async (o: { profileId: string; callId: string; result: unknown }) => {
        const r = json(o);
        pending.get(r.callId)?.(r.result);
        pending.delete(r.callId);
      },
      pushState: async (o: { profileId: string; state: unknown }) => {
        queue.push({ type: "state", state: json(o).state });
        flush();
      },
      event: async () => {},
    };
    const handler = {
      postMessage: (raw: unknown) => {
        const m = json(raw) as Record<string, unknown>;
        if (m.type === "hello") return Promise.resolve(true);
        if (m.type === "listen") {
          return new Promise((resolve) => {
            listen = resolve;
            flush();
          });
        }
        n += 1;
        const callId = `abcd1234-${n}`;
        return new Promise((resolve) => {
          pending.set(callId, resolve);
          pluginListener?.(
            json({ ...m, type: undefined, profileId: "p1", origin: ORIGIN, callId }),
          );
        });
      },
    };
    return { plugin, win: { webkit: { messageHandlers: { capybaraShell: handler } } } };
  }

  test("a void implementation resolves null in the page, and a push reaches it", async () => {
    const native = fakeNative();
    const host = createHostPort(native.plugin);
    const registry = createRegistry({
      host,
      profiles: { list: () => [{ id: "p1", origin: ORIGIN }] },
    });
    registry.register("haptics@1", { functions: { impact: async () => undefined } });
    registry.register("nav@1", { functions: { set: async (_c, a) => (a as number) + 1 } });
    serveCalls(host, registry);
    const target: { capybaraShell?: CapybaraShell } = {};
    bootShellEnvironment({
      init,
      target,
      isTopFrame: true,
      windowOrigin: ORIGIN,
      randomId: () => "doc-1234-5678",
      userActivation: () => false,
      transport: iosTransport(native.win),
    });
    const shell = target.capybaraShell as CapybaraShell;
    const caps = shell.capabilities as Record<
      string,
      Record<string, (...a: unknown[]) => Promise<unknown>>
    >;
    await expect(caps["haptics@1"]?.impact?.("light")).resolves.toBeNull();
    await expect(caps["nav@1"]?.set?.(41)).resolves.toBe(42);
    const changed = new Promise<void>((resolve) => shell.on("change", () => resolve()));
    await host.pushState("p1", {
      insets: { top: 0, right: 0, bottom: 3, left: 0 },
      capabilities: {},
    });
    await changed;
    expect(shell.insets.bottom).toBe(3);
  });
});

describe("window.open on Android (R14: every new window goes to the browser sheet)", () => {
  test("the profile document's window.open posts the resolved URL and opens nothing", () => {
    const opened: string[] = [];
    const transport = Object.assign(fakeTransport(), {
      open: (post: { type: "open"; docId: string; url: string }) => {
        expect(post).toMatchObject({ type: "open", docId: "doc-1234-5678" });
        opened.push(post.url);
      },
    });
    const target: { open?: unknown; capybaraShell?: unknown } = { open: () => "native window" };
    bootShellEnvironment({
      init: { ...init, platform: "android" },
      target,
      isTopFrame: true,
      windowOrigin: ORIGIN,
      randomId: () => "doc-1234-5678",
      userActivation: () => true,
      transport,
      baseUrl: () => "https://a.example/chat/1",
    });
    const open = target.open as (url?: unknown) => unknown;
    expect(open("/files/2")).toBeNull();
    expect(open("https://b.example/x")).toBeNull();
    expect(open()).toBeNull();
    expect(open("javascript:alert(1)")).toBeNull();
    expect(opened).toEqual(["https://a.example/files/2", "https://b.example/x"]);
  });

  test("on iOS window.open is left to WebKit (createWebViewWith routes it)", () => {
    const original = () => "native window";
    const target: { open?: unknown } = { open: original };
    const transport = Object.assign(fakeTransport(), { open: vi.fn() });
    bootShellEnvironment({
      init,
      target,
      isTopFrame: true,
      windowOrigin: ORIGIN,
      randomId: () => "doc-1234-5678",
      userActivation: () => true,
      transport,
    });
    expect(target.open).toBe(original);
  });
});

describe("the Android transport", () => {
  function fakePort() {
    const sent: string[] = [];
    let listener: ((e: { data: unknown }) => void) | undefined;
    const port = {
      postMessage: (m: string) => sent.push(m),
      addEventListener: (_t: "message", l: (e: { data: unknown }) => void) => {
        listener = l;
      },
    };
    return {
      win: { capybaraShellPort: port },
      sent,
      fire: (data: unknown) => listener?.({ data }),
    };
  }

  test("is null without the port", () => {
    expect(androidTransport({})).toBeNull();
    const { win, sent } = fakePort();
    const post = { type: "open", docId: "doc-1234-5678", url: "https://b.example/x" } as const;
    androidTransport(win)?.open?.(post);
    expect(sent.map((m) => JSON.parse(m))).toEqual([post]);
  });

  test("a reply resolves its call; a denied drop resolves failed instead of hanging", async () => {
    const { win, sent, fire } = fakePort();
    const t = androidTransport(win);
    const base = { type: "call", docId: "doc-1234-5678", fn: "f", key: "a@1" } as const;
    const one = t?.call({ ...base, args: [], callId: "1", activation: false });
    const two = t?.call({ ...base, args: [], callId: "2", activation: true });
    expect(sent.map((s) => JSON.parse(s))).toEqual([
      { ...base, args: [], callId: "1", activation: false },
      { ...base, args: [], callId: "2", activation: true },
    ]);
    fire("not json");
    fire(JSON.stringify({ type: "denied", callId: "2" }));
    fire(JSON.stringify({ type: "reply", callId: "1", result: { ok: true, value: "pong" } }));
    expect(await one).toEqual({ ok: true, value: "pong" });
    expect(await two).toEqual({ ok: false, code: "failed" });
  });

  test("hello posts the document id; other messages are pushes", () => {
    const { win, sent, fire } = fakePort();
    const t = androidTransport(win);
    const seen = vi.fn();
    t?.onPush(seen);
    t?.hello("doc-1234-5678");
    expect(JSON.parse(sent[0] ?? "")).toEqual({ type: "hello", docId: "doc-1234-5678" });
    fire(JSON.stringify({ type: "event", key: "nav@1", event: "onSelect", payload: 1 }));
    expect(seen).toHaveBeenCalledWith({
      type: "event",
      key: "nav@1",
      event: "onSelect",
      payload: 1,
    });
  });
});
