import { ImpactStyle, NotificationType } from "@capacitor/haptics";
import { describe, expect, test, vi } from "vitest";
import {
  createHapticsCapability,
  type HapticsPort,
} from "../../src/runtime/capabilities/haptics.ts";
import {
  createMenuCapability,
  type MenuHostPort,
  type MenuShowInput,
  menuHostPortFrom,
} from "../../src/runtime/capabilities/menu.ts";
import { createOpenExternalCapability } from "../../src/runtime/capabilities/open-external.ts";
import { createShareCapability, type SharePort } from "../../src/runtime/capabilities/share.ts";
import type { HostPort } from "../../src/runtime/host-port.ts";
import type { ShellCallMessage } from "../../src/runtime/protocol.ts";
import { type CapabilityImpl, createRegistry } from "../../src/runtime/registry.ts";

const ORIGIN = "https://a.example";
const profile = { id: "p1", origin: ORIGIN };

function setup(key: string, impl: CapabilityImpl, prof: { id: string; origin: string } = profile) {
  const host: HostPort = {
    onCall: () => () => {},
    reply: async () => {},
    pushState: async () => {},
    event: async () => {},
  };
  const registry = createRegistry({ host, profiles: { list: () => [prof] } });
  registry.register(key, impl);
  let n = 0;
  const call = (fn: string, args: unknown[], activation = true) =>
    registry.dispatch({
      profileId: prof.id,
      origin: prof.origin,
      docId: "doc-0001-aaaa",
      callId: `c${++n}`,
      key,
      fn,
      args,
      activation,
    } satisfies ShellCallMessage);
  return { registry, call };
}

const FAILED = { ok: false, code: "failed" };

describe("haptics@1", () => {
  function fake() {
    const port = {
      selectionChanged: vi.fn(async () => {}),
      impact: vi.fn(async (_o: { style: ImpactStyle }) => {}),
      notification: vi.fn(async (_o: { type: NotificationType }) => {}),
    } satisfies HapticsPort;
    return port;
  }

  test("is not confirming and offers impact only", () => {
    const impl = createHapticsCapability(fake());
    expect(impl.confirming ?? []).toEqual([]);
    expect(Object.keys(impl.functions)).toEqual(["impact"]);
  });

  test("heavy and other values fail without touching the plugin", async () => {
    const port = fake();
    const { call } = setup("haptics@1", createHapticsCapability(port));
    for (const bad of ["heavy", "", 1, null, undefined, {}]) {
      expect(await call("impact", [bad], false)).toEqual(FAILED);
    }
    expect(await call("impact", [], false)).toEqual(FAILED);
    expect(port.selectionChanged).not.toHaveBeenCalled();
    expect(port.impact).not.toHaveBeenCalled();
    expect(port.notification).not.toHaveBeenCalled();
  });

  test("each valid kind calls its plugin function once", async () => {
    const port = fake();
    const { call } = setup("haptics@1", createHapticsCapability(port));
    expect(await call("impact", ["selection"], false)).toEqual({ ok: true, value: null });
    expect(port.selectionChanged).toHaveBeenCalledTimes(1);
    await call("impact", ["light"], false);
    expect(port.impact).toHaveBeenCalledExactlyOnceWith({ style: ImpactStyle.Light });
    await call("impact", ["success"], false);
    expect(port.notification).toHaveBeenLastCalledWith({ type: NotificationType.Success });
    await call("impact", ["warning"], false);
    expect(port.notification).toHaveBeenLastCalledWith({ type: NotificationType.Warning });
    expect(port.notification).toHaveBeenCalledTimes(2);
    expect(port.selectionChanged).toHaveBeenCalledTimes(1);
    expect(port.impact).toHaveBeenCalledTimes(1);
  });

  test("a plugin failure is a failed call", async () => {
    const port = fake();
    port.selectionChanged.mockRejectedValueOnce(new Error("no taptic engine"));
    const { call } = setup("haptics@1", createHapticsCapability(port));
    expect(await call("impact", ["selection"], false)).toEqual(FAILED);
  });
});

describe("share@1", () => {
  function fake() {
    let release: () => void = () => {};
    const port = {
      share: vi.fn(async (_o: { title?: string; text?: string; url?: string }) => {}),
    } satisfies SharePort;
    return {
      port,
      hold() {
        port.share.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
      },
      release: () => release(),
    };
  }

  test("share is confirming", () => {
    expect(createShareCapability(fake().port).confirming).toEqual(["share"]);
  });

  test("a javascript:, a foreign http and an over-long url fail", async () => {
    const f = fake();
    const { call } = setup("share@1", createShareCapability(f.port));
    for (const url of [
      "javascript:alert(1)",
      "http://other.example",
      `https://a.example/${"x".repeat(2049 - "https://a.example/".length)}`,
      "data:text/html,hi",
      "ftp://a.example/f",
      "//[",
    ]) {
      expect(await call("share", [{ url }])).toEqual(FAILED);
    }
    expect(f.port.share).not.toHaveBeenCalled();
  });

  test("a 2048-character url is the longest allowed", async () => {
    const f = fake();
    const { call } = setup("share@1", createShareCapability(f.port));
    const url = `https://a.example/${"x".repeat(2048 - "https://a.example/".length)}`;
    expect(url).toHaveLength(2048);
    expect(await call("share", [{ url }])).toEqual({ ok: true, value: null });
  });

  test("a relative url resolves against the profile origin, a foreign https url is allowed", async () => {
    const f = fake();
    const { call } = setup("share@1", createShareCapability(f.port));
    await call("share", [{ url: "/chat/c1", title: "T" }]);
    expect(f.port.share).toHaveBeenLastCalledWith({ title: "T", url: "https://a.example/chat/c1" });
    await call("share", [{ url: "https://other.example/x?y=1" }]);
    expect(f.port.share).toHaveBeenLastCalledWith({ url: "https://other.example/x?y=1" });
  });

  test("an http profile may share its own origin only", async () => {
    const f = fake();
    const local = { id: "p1", origin: "http://127.0.0.1:3000" };
    const { call } = setup("share@1", createShareCapability(f.port), local);
    expect(await call("share", [{ url: "/x" }])).toEqual({ ok: true, value: null });
    expect(f.port.share).toHaveBeenLastCalledWith({ url: "http://127.0.0.1:3000/x" });
    expect(await call("share", [{ url: "http://127.0.0.1:3001/x" }])).toEqual(FAILED);
  });

  test("no activation fails with no_activation and shares nothing", async () => {
    const f = fake();
    const { call } = setup("share@1", createShareCapability(f.port));
    expect(await call("share", [{ text: "hi" }], false)).toEqual({
      ok: false,
      code: "no_activation",
    });
    expect(f.port.share).not.toHaveBeenCalled();
  });

  test("two at once: the second is busy, and the slot frees afterwards", async () => {
    const f = fake();
    const { call } = setup("share@1", createShareCapability(f.port));
    f.hold();
    const first = call("share", [{ text: "one" }]);
    expect(await call("share", [{ text: "two" }])).toEqual({ ok: false, code: "busy" });
    f.release();
    expect(await first).toEqual({ ok: true, value: null });
    expect(await call("share", [{ text: "three" }])).toEqual({ ok: true, value: null });
    expect(f.port.share).toHaveBeenCalledTimes(2);
  });

  test("text up to 4000 is allowed, 4001 fails; title over 256 fails", async () => {
    const f = fake();
    const { call } = setup("share@1", createShareCapability(f.port));
    expect(await call("share", [{ text: "x".repeat(4001) }])).toEqual(FAILED);
    expect(await call("share", [{ title: "x".repeat(257) }])).toEqual(FAILED);
    expect(await call("share", [{ text: "x".repeat(4000), title: "x".repeat(256) }])).toEqual({
      ok: true,
      value: null,
    });
  });

  test("a malformed input fails", async () => {
    const f = fake();
    const { call } = setup("share@1", createShareCapability(f.port));
    for (const bad of [undefined, null, "x", [], {}, { text: 1 }, { url: 1 }, { text: "" }]) {
      expect(await call("share", bad === undefined ? [] : [bad])).toEqual(FAILED);
    }
    expect(f.port.share).not.toHaveBeenCalled();
  });

  test("a dismissed sheet resolves, another error fails", async () => {
    const f = fake();
    const { call } = setup("share@1", createShareCapability(f.port));
    f.port.share.mockRejectedValueOnce(new Error("Share canceled"));
    expect(await call("share", [{ text: "x" }])).toEqual({ ok: true, value: null });
    f.port.share.mockRejectedValueOnce(new Error("boom"));
    expect(await call("share", [{ text: "x" }])).toEqual(FAILED);
  });
});

describe("menu@1", () => {
  const items = [
    { id: "open", label: "Open" },
    { id: "rm", label: "Delete", destructive: true },
    { id: "off", label: "Unavailable", disabled: true },
  ];

  function fake(answer: string | null = null) {
    const port = {
      show: vi.fn(async (_input: MenuShowInput) => answer),
      cancel: vi.fn(() => {}),
    } satisfies MenuHostPort;
    return port;
  }

  test("menu.show is confirming", () => {
    expect(createMenuCapability(fake()).confirming).toEqual(["show"]);
  });

  test("invalid inputs fail and never reach MenuHost", async () => {
    const port = fake();
    const { call } = setup("menu@1", createMenuCapability(port));
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `i${i}`, label: "x" }));
    const bad: unknown[] = [
      undefined,
      null,
      {},
      { items: [] },
      { items: many },
      { items: [{ id: "a b", label: "x" }] },
      { items: [{ id: "", label: "x" }] },
      { items: [{ id: "a", label: "x".repeat(65) }] },
      { items: [{ id: "a", label: "" }] },
      { items: [{ id: "a", label: "x", items: [{ id: "b", label: "y" }] }] },
      { items: [{ id: "a", label: "x", icon: "trash" }] },
      { items: [{ id: "a", label: "x", destructive: "yes" }] },
      {
        items: [
          { id: "a", label: "x" },
          { id: "a", label: "y" },
        ],
      },
      { items: [{ id: "a", label: "x" }], title: "x".repeat(129) },
      { items: [{ id: "a", label: "x" }], extra: 1 },
      { items: [{ id: "a", label: "x" }], anchor: { x: 1, y: 2, width: "3", height: 4 } },
      { items: [{ id: "a", label: "x" }], anchor: { x: Number.NaN, y: 2, width: 3, height: 4 } },
    ];
    for (const input of bad) {
      expect(await call("show", input === undefined ? [] : [input])).toEqual(FAILED);
    }
    expect(port.show).not.toHaveBeenCalled();
  });

  test("12 items with 64-character labels are fine", async () => {
    const port = fake();
    const { call } = setup("menu@1", createMenuCapability(port));
    const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, label: "x".repeat(64) }));
    expect(await call("show", [{ items: twelve }])).toEqual({ ok: true, value: null });
  });

  test("a valid call shows MenuHost with the flags, title and anchor", async () => {
    const port = fake();
    const { call } = setup("menu@1", createMenuCapability(port));
    const anchor = { x: 10, y: 20, width: 30, height: 40 };
    await call("show", [{ title: "Actions", items, anchor }]);
    expect(port.show).toHaveBeenCalledExactlyOnceWith({
      title: "Actions",
      items: [
        { id: "open", label: "Open", destructive: false, disabled: false },
        { id: "rm", label: "Delete", destructive: true, disabled: false },
        { id: "off", label: "Unavailable", destructive: false, disabled: true },
      ],
      anchor,
    });
  });

  test("picking resolves the id; dismissing resolves null", async () => {
    const { call } = setup("menu@1", createMenuCapability(fake("rm")));
    expect(await call("show", [{ items }])).toEqual({ ok: true, value: "rm" });
    const dismissed = setup("menu@1", createMenuCapability(fake(null)));
    expect(await dismissed.call("show", [{ items }])).toEqual({ ok: true, value: null });
  });

  test("a disabled or unknown id from the host is ignored, never resolved", async () => {
    for (const answer of ["off", "nope"]) {
      const { call } = setup("menu@1", createMenuCapability(fake(answer)));
      expect(await call("show", [{ items }])).toEqual({ ok: true, value: null });
    }
  });

  test("no activation, and a second menu while one is open is busy", async () => {
    let finish: (id: string | null) => void = () => {};
    const port: MenuHostPort = {
      show: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      cancel: () => {},
    };
    const { call } = setup("menu@1", createMenuCapability(port));
    expect(await call("show", [{ items }], false)).toEqual({ ok: false, code: "no_activation" });
    const first = call("show", [{ items }]);
    expect(await call("show", [{ items }])).toEqual({ ok: false, code: "busy" });
    finish("open");
    expect(await first).toEqual({ ok: true, value: "open" });
  });

  test("the document ending cancels the open menu natively and settles cancelled", async () => {
    let finish: (id: string | null) => void = () => {};
    const port = {
      show: vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            finish = resolve;
          }),
      ),
      cancel: vi.fn(() => finish(null)),
    } satisfies MenuHostPort;
    const { registry, call } = setup("menu@1", createMenuCapability(port));
    const open = call("show", [{ items }]);
    await vi.waitFor(() => expect(port.show).toHaveBeenCalledTimes(1));
    registry.endDocument("p1");
    expect(await open).toEqual({ ok: false, code: "cancelled" });
    expect(port.cancel).toHaveBeenCalledTimes(1);
    // The slot is free again for the next document.
    port.show.mockImplementationOnce(async () => "open");
    expect(await call("show", [{ items }])).toEqual({ ok: true, value: "open" });
  });

  test("a menu that settles on its own is never cancelled", async () => {
    const port = fake("open");
    const { registry, call } = setup("menu@1", createMenuCapability(port));
    expect(await call("show", [{ items }])).toEqual({ ok: true, value: "open" });
    registry.endDocument("p1");
    expect(port.cancel).not.toHaveBeenCalled();
  });

  test("menuHostPortFrom forwards cancel to the MenuHost plugin", async () => {
    const plugin = { show: vi.fn(async () => ({ id: null })), cancel: vi.fn(async () => {}) };
    menuHostPortFrom(plugin).cancel();
    expect(plugin.cancel).toHaveBeenCalledTimes(1);
  });

  test("a host failure is a failed call", async () => {
    const port: MenuHostPort = {
      show: async () => {
        throw new Error("no window");
      },
      cancel: () => {},
    };
    const { call } = setup("menu@1", createMenuCapability(port));
    expect(await call("show", [{ items }])).toEqual(FAILED);
  });
});

describe("openExternal@1", () => {
  test("open is not confirming", () => {
    expect(createOpenExternalCapability({ open: async () => {} }).confirming ?? []).toEqual([]);
  });

  test("openExternal@1 exposes returnScheme", () => {
    const profile = { id: "p1", origin: "https://a.example" };
    const cap = createOpenExternalCapability(
      { open: async () => {} },
      { returnScheme: "capybara" },
    );
    expect(cap.fields?.(profile)).toEqual({ returnScheme: "capybara" });
    // Without a scheme there is no field.
    expect(createOpenExternalCapability({ open: async () => {} }).fields).toBeUndefined();
  });

  test("ftp, javascript and a foreign http url fail; https opens", async () => {
    const port = { open: vi.fn(async (_url: string) => {}) };
    const { call } = setup("openExternal@1", createOpenExternalCapability(port));
    for (const url of [
      "ftp://a.example/f",
      "javascript:alert(1)",
      "http://other.example",
      5,
      null,
    ]) {
      expect(await call("open", [url], false)).toEqual(FAILED);
    }
    expect(await call("open", [], false)).toEqual(FAILED);
    expect(port.open).not.toHaveBeenCalled();
    expect(await call("open", ["https://docs.example/x"], false)).toEqual({
      ok: true,
      value: null,
    });
    expect(port.open).toHaveBeenCalledExactlyOnceWith("https://docs.example/x");
  });

  test("a relative url resolves against the profile origin; an over-long one fails", async () => {
    const port = { open: vi.fn(async (_url: string) => {}) };
    const { call } = setup("openExternal@1", createOpenExternalCapability(port));
    await call("open", ["/files/1"], false);
    expect(port.open).toHaveBeenLastCalledWith("https://a.example/files/1");
    expect(await call("open", [`https://a.example/${"x".repeat(2049)}`], false)).toEqual(FAILED);
  });

  test("a native failure is a failed call", async () => {
    const port = {
      open: async () => {
        throw new Error("no handler");
      },
    };
    const { call } = setup("openExternal@1", createOpenExternalCapability(port));
    expect(await call("open", ["https://x.example"], false)).toEqual(FAILED);
  });
});
