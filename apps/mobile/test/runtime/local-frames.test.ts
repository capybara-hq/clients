import { describe, expect, test, vi } from "vitest";
import { createRuntimeLink } from "../../src/runtime/local-channel.ts";
import { createLocalFrames, LOCAL_PORT_MESSAGE } from "../../src/runtime/local-frames.ts";

interface FakeFrame {
  src: string;
  removed: boolean;
  posted: { message: unknown; transfer: MessagePort[] }[];
  load(): void;
}

function fakeDom() {
  const made: FakeFrame[] = [];
  return {
    made,
    create: vi.fn((src: string) => {
      const listeners: (() => void)[] = [];
      const frame: FakeFrame = {
        src,
        removed: false,
        posted: [],
        load: () => {
          for (const l of listeners) l();
        },
      };
      made.push(frame);
      return {
        post: (message: unknown, transfer: MessagePort[]) =>
          frame.posted.push({ message, transfer }),
        onLoad: (listener: () => void) => listeners.push(listener),
        remove: () => {
          frame.removed = true;
        },
      };
    }),
  };
}

/** The port the runtime handed the frame's latest document. */
function portOf(frame: FakeFrame | undefined): MessagePort {
  const last = frame?.posted.at(-1);
  expect(last?.message).toEqual({ type: LOCAL_PORT_MESSAGE });
  const port = last?.transfer[0];
  if (!port) throw new Error("no port");
  return port;
}

/** Waits for the next message on `port`. */
const next = (port: MessagePort) =>
  new Promise<unknown>((resolve) => {
    port.onmessage = (e) => resolve(e.data);
  });

describe("local pages framed over the runtime document (I4)", () => {
  test("one page at a time: showing the address page replaces the error page", () => {
    const dom = fakeDom();
    const frames = createLocalFrames({ create: dom.create, onMessage: () => {} });
    frames.show("error", "error/index.html");
    frames.show("address", "address/index.html");
    expect(dom.made.map((f) => [f.src, f.removed])).toEqual([
      ["error/index.html", true],
      ["address/index.html", false],
    ]);
    expect(frames.current()).toBe("address");
    frames.hide();
  });

  test("a loaded frame gets its own port; messages on it are the shown page's", async () => {
    const dom = fakeDom();
    const got: [string, unknown][] = [];
    let arrived: () => void = () => {};
    const frames = createLocalFrames({
      create: dom.create,
      onMessage: (page, data) => {
        got.push([page, data]);
        arrived();
      },
    });
    frames.show("address", "address/index.html");
    expect(dom.made[0]?.posted).toEqual([]);
    dom.made[0]?.load();
    const port = portOf(dom.made[0]);
    const seen = new Promise<void>((r) => (arrived = r));
    port.postMessage({ hi: 1 });
    await seen;
    expect(got).toEqual([["address", { hi: 1 }]]);
    const reply = next(port);
    frames.post({ back: 2 });
    expect(await reply).toEqual({ back: 2 });
    port.close();
    frames.hide();
  });

  test("a hidden page's port is closed: nothing it sends counts any more", async () => {
    const dom = fakeDom();
    const onMessage = vi.fn();
    const frames = createLocalFrames({ create: dom.create, onMessage });
    frames.show("error", "error/index.html");
    dom.made[0]?.load();
    const oldPort = portOf(dom.made[0]);
    frames.show("address", "address/index.html");
    dom.made[1]?.load();
    const newPort = portOf(dom.made[1]);
    let arrived: () => void = () => {};
    onMessage.mockImplementation(() => arrived());
    const seen = new Promise<void>((r) => (arrived = r));
    oldPort.postMessage({ from: "old" });
    newPort.postMessage({ from: "new" });
    await seen;
    expect(onMessage.mock.calls).toEqual([["address", { from: "new" }]]);
    oldPort.close();
    newPort.close();
    frames.hide();
  });

  test("showing the same page again keeps its frame", () => {
    const dom = fakeDom();
    const frames = createLocalFrames({ create: dom.create, onMessage: () => {} });
    frames.show("error", "error/index.html");
    frames.show("error", "error/index.html");
    expect(dom.create).toHaveBeenCalledTimes(1);
    frames.hide();
  });

  test("hide removes the frame; there is no way to navigate the runtime document", () => {
    const dom = fakeDom();
    const frames = createLocalFrames({ create: dom.create, onMessage: () => {} });
    frames.show("address", "address/index.html");
    frames.hide();
    expect(dom.made[0]?.removed).toBe(true);
    expect(frames.current()).toBeNull();
    expect(Object.keys(frames).sort()).toEqual(["current", "hide", "post", "show"]);
  });
});

describe("the framed page's link to the runtime", () => {
  const ORIGIN = "capacitor://localhost";

  test("takes its port only from its parent on the local origin, and queues until then", async () => {
    const parent = {};
    const received: unknown[] = [];
    let arrived: () => void = () => {};
    const link = createRuntimeLink({
      parent,
      origin: ORIGIN,
      onMessage: (d) => {
        received.push(d);
        arrived();
      },
    });
    link.post({ type: "ready" });
    const forged = new MessageChannel();
    const portMessage = { type: LOCAL_PORT_MESSAGE };
    link.receive({
      origin: "https://evil.example",
      source: parent,
      data: portMessage,
      ports: [forged.port2],
    });
    link.receive({ origin: ORIGIN, source: {}, data: portMessage, ports: [forged.port2] });
    link.receive({ origin: ORIGIN, source: null, data: portMessage, ports: [forged.port2] });
    link.receive({
      origin: ORIGIN,
      source: parent,
      data: { type: "other" },
      ports: [forged.port2],
    });
    link.receive({ origin: ORIGIN, source: parent, data: portMessage, ports: [] });
    const real = new MessageChannel();
    const first = next(real.port1);
    link.receive({ origin: ORIGIN, source: parent, data: portMessage, ports: [real.port2] });
    // The queued message goes out on the real port, never on the forged one.
    expect(await first).toEqual({ type: "ready" });
    const second = next(real.port1);
    link.post({ type: "choice" });
    expect(await second).toEqual({ type: "choice" });
    const seen = new Promise<void>((r) => (arrived = r));
    real.port1.postMessage({ type: "state" });
    await seen;
    expect(received).toEqual([{ type: "state" }]);
    for (const p of [forged.port1, forged.port2, real.port1, real.port2]) p.close();
  });
});
