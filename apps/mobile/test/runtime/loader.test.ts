import { describe, expect, test, vi } from "vitest";
import { createAppearanceStore } from "../../src/runtime/appearance.ts";
import { errorModel } from "../../src/runtime/error-page.ts";
import type {
  DocumentEvent,
  HostPort,
  LoadEvent,
  ProfileHostPort,
} from "../../src/runtime/host-port.ts";
import { createLoader, type ErrorView, type LoaderProfile } from "../../src/runtime/loader.ts";
import { createRegistry } from "../../src/runtime/registry.ts";
import { blockRulesFor } from "../../src/runtime/sign-in-block.ts";
import type { Splash } from "../../src/runtime/splash.ts";

const p1: LoaderProfile = {
  id: "p1",
  origin: "https://a.example",
  base: "https://a.example/team",
  dataStoreId: "6d0c6e2b-1f4a-4c1e-9b7e-0a11e5a7e513",
  name: "Team A",
};
const p2: LoaderProfile = {
  ...p1,
  id: "p2",
  origin: "https://b.example",
  base: "https://b.example",
  name: null,
};

function fakeHost() {
  const order: string[] = [];
  let load: ((e: LoadEvent) => void) | undefined;
  let doc: ((e: DocumentEvent) => void) | undefined;
  const host = {
    open: vi.fn(async (req: { profileId: string }) => {
      order.push(`open ${req.profileId}`);
    }),
    showError: vi.fn(async (profileId: string) => {
      order.push(`showError ${profileId}`);
    }),
    close: vi.fn(async (profileId: string) => {
      order.push(`close ${profileId}`);
    }),
    setAppearance: vi.fn(async (profileId: string, _look: unknown) => {
      order.push(`setAppearance ${profileId}`);
    }),
    onLoad: (l: (e: LoadEvent) => void) => {
      load = l;
      return () => {
        load = undefined;
      };
    },
    onDocument: (l: (e: DocumentEvent) => void) => {
      doc = l;
      return () => {
        doc = undefined;
      };
    },
  } satisfies ProfileHostPort;
  return {
    host,
    order,
    emitLoad: (e: LoadEvent) => load?.(e),
    emitDocument: (e: DocumentEvent) => doc?.(e),
  };
}

function setup(
  stored: Record<string, string> = {},
  allowed: () => LoaderProfile[] = () => [p1, p2],
) {
  const native = fakeHost();
  const pushState = vi.fn(async () => {});
  const calls: HostPort = {
    onCall: () => () => {},
    reply: async () => {},
    pushState,
    event: async () => {},
  };
  const registry = createRegistry({ host: calls, profiles: { list: () => [p1, p2] } });
  registry.register("test@1", { functions: { run: async () => 1 } });
  const endDocument = vi.spyOn(registry, "endDocument");
  const values = new Map(Object.entries(stored));
  const appearance = createAppearanceStore({
    get: async (k) => values.get(k) ?? null,
    set: async (k, v) => {
      values.set(k, v);
    },
  });
  const splash: Splash = { ready: vi.fn(), loaded: vi.fn(), failed: vi.fn() };
  const errorView: ErrorView = { show: vi.fn(), hide: vi.fn() };
  const loader = createLoader({
    host: native.host,
    calls,
    registry,
    appearance,
    splash,
    errorView,
    profiles: allowed,
  });
  return { native, pushState, registry, endDocument, splash, errorView, loader };
}

describe("loader: only allowed profiles", () => {
  test("open refuses a profile that is not in profiles() (hidden by a lock)", async () => {
    const { native, loader } = setup({}, () => [p1]);
    await loader.open(p2);
    expect(native.host.open).not.toHaveBeenCalled();
    expect(loader.shown()).toBeNull();
  });

  test("retry refuses a shown profile that became hidden", async () => {
    let allowed = [p1, p2];
    const { native, loader } = setup({}, () => allowed);
    await loader.open(p2);
    expect(loader.shown()).toBe("p2");
    allowed = [p1];
    await loader.retry();
    expect(native.host.open).toHaveBeenCalledTimes(1);
  });

  test("close tears the profile's WebView down and forgets it when shown", async () => {
    const { native, loader } = setup();
    await loader.open(p1);
    await loader.close("p1");
    expect(native.host.close).toHaveBeenCalledWith("p1");
    expect(loader.shown()).toBeNull();
    await loader.close("p2");
    expect(native.host.close).toHaveBeenCalledWith("p2");
  });
});

describe("loader", () => {
  test("opens the profile with its capabilities as the initial state", async () => {
    const { native, loader } = setup();
    await loader.open(p1);
    expect(native.host.open).toHaveBeenCalledWith({
      profileId: "p1",
      origin: "https://a.example",
      base: "https://a.example/team",
      dataStoreId: p1.dataStoreId,
      state: {
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
        capabilities: { "test@1": ["run"] },
        events: {},
      },
      // iOS compiles these into the WebView's content rule list before its first load.
      blockRules: blockRulesFor("https://a.example/team"),
    });
  });

  test("a deployment too old for app sign-in shows the too-old state with the current state", async () => {
    const { native, errorView, pushState, splash, loader } = setup();
    await loader.open(p1);
    loader.tooOld("p2");
    expect(errorView.show).not.toHaveBeenCalled();
    loader.tooOld("p1");
    expect(native.host.showError).toHaveBeenCalledWith("p1");
    expect(vi.mocked(errorView.show).mock.calls[0]?.[0]).toMatchObject({
      kind: "too_old",
      profileId: "p1",
      host: "a.example",
    });
    expect(vi.mocked(errorView.show).mock.calls[0]?.[0]).not.toHaveProperty("code");
    // The capabilities are pushed again (signIn@1 is no longer offered to it).
    expect(pushState).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ capabilities: { "test@1": ["run"] } }),
    );
    expect(splash.failed).toHaveBeenCalled();
  });

  test("the stored background is applied before the WebView loads", async () => {
    const { native, loader } = setup({
      "appearance.p1": JSON.stringify({ scheme: "dark", background: "#123456" }),
    });
    await loader.open(p1);
    expect(native.order).toEqual(["setAppearance p1", "open p1"]);
    expect(native.host.setAppearance).toHaveBeenCalledWith("p1", {
      background: "#123456",
      statusBar: "light",
    });
  });

  test("without a stored appearance nothing is set natively", async () => {
    const { native, loader } = setup();
    await loader.open(p1);
    expect(native.host.setAppearance).not.toHaveBeenCalled();
  });

  test("an owed single-store wipe shows its own error state and retry opens again", async () => {
    // Native refuses to load while a wipe of the shared store is owed (and retries it inside open).
    const { native, errorView, loader } = setup();
    native.host.open.mockRejectedValueOnce(new Error("wipe_owed"));
    await loader.open(p1);
    const shown = vi.mocked(errorView.show).mock.calls[0]?.[0];
    expect(shown).toMatchObject({ kind: "wipe_owed", profileId: "p1", host: "a.example" });
    expect(native.host.showError).toHaveBeenCalledWith("p1");
    await loader.retry();
    expect(native.host.open).toHaveBeenCalledTimes(2);
    expect(errorView.hide).toHaveBeenCalledTimes(2);
  });

  test("any other open failure still rejects", async () => {
    const { native, loader } = setup();
    native.host.open.mockRejectedValueOnce(new Error("not_created"));
    await expect(loader.open(p1)).rejects.toThrow("not_created");
  });

  test("the main-frame load finishing starts the splash fallback", async () => {
    const { native, splash, loader } = setup();
    await loader.open(p1);
    native.emitLoad({ profileId: "p1", type: "didFinish" });
    expect(splash.loaded).toHaveBeenCalledTimes(1);
  });

  test("chrome@1.ready of the shown profile drops the splash; another profile's does not", async () => {
    const { splash, loader } = setup();
    await loader.open(p1);
    loader.ready("p2");
    expect(splash.ready).not.toHaveBeenCalled();
    loader.ready("p1");
    expect(splash.ready).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["ERR_NAME_NOT_RESOLVED", false, "unreachable"],
    ["NSURLErrorDomain:-1003", false, "unreachable"],
    ["NSURLErrorDomain:-1202", true, "tls"],
    ["ERR_CERT_AUTHORITY_INVALID", true, "tls"],
  ] as const)("a provisional failure %s shows the error state (%s)", async (code, tls, kind) => {
    const { native, splash, errorView, loader } = setup();
    await loader.open(p1);
    native.emitLoad({ profileId: "p1", type: "didFailProvisional", code, tls });
    // Native hides the profile WebView: its own error page is never what the person sees.
    expect(native.host.showError).toHaveBeenCalledWith("p1");
    expect(errorView.show).toHaveBeenCalledWith({
      kind,
      profileId: "p1",
      host: "a.example",
      code,
      profiles: [
        { id: "p1", label: "Team A", current: true },
        { id: "p2", label: "b.example", current: false },
      ],
    });
    expect(splash.failed).toHaveBeenCalledTimes(1);
  });

  test("a crashed web content process shows the error state", async () => {
    const { native, errorView, loader } = setup();
    await loader.open(p1);
    native.emitLoad({ profileId: "p1", type: "processGone" });
    expect(native.host.showError).toHaveBeenCalledWith("p1");
    expect(vi.mocked(errorView.show).mock.calls[0]?.[0].kind).toBe("crashed");
  });

  test("a 500 from the deployment stays in the WebView", async () => {
    const { native, errorView, splash, loader } = setup();
    await loader.open(p1);
    native.emitLoad({ profileId: "p1", type: "didFinish", status: 500 });
    expect(native.host.showError).not.toHaveBeenCalled();
    expect(errorView.show).not.toHaveBeenCalled();
    expect(splash.loaded).toHaveBeenCalledTimes(1);
  });

  test("events of a profile not shown are ignored", async () => {
    const { native, errorView, loader } = setup();
    await loader.open(p1);
    native.emitLoad({ profileId: "p2", type: "didFailProvisional", code: "x", tls: false });
    expect(errorView.show).not.toHaveBeenCalled();
  });

  test("retry hides the error state and opens the profile again", async () => {
    const { native, errorView, loader } = setup();
    await loader.open(p1);
    native.emitLoad({ profileId: "p1", type: "didFailProvisional", code: "x", tls: false });
    await loader.retry();
    expect(errorView.hide).toHaveBeenCalled();
    expect(native.host.open).toHaveBeenCalledTimes(2);
  });

  test("a document that opens gets the current state again (M7)", async () => {
    const { native, pushState, loader } = setup();
    await loader.open(p1);
    native.emitDocument({ profileId: "p1", docId: "doc-0001-aaaa", state: "opened" });
    expect(pushState).toHaveBeenCalledWith("p1", {
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      capabilities: { "test@1": ["run"] },
      events: {},
    });
  });

  test("a document that ends settles its profile's calls (M3)", async () => {
    const { native, endDocument, loader } = setup();
    await loader.open(p1);
    native.emitDocument({ profileId: "p1", docId: "doc-0001-aaaa", state: "ended" });
    expect(endDocument).toHaveBeenCalledWith("p1");
  });
});

describe("the error page model", () => {
  const base = {
    profileId: "p1",
    host: "a.example",
    code: "NSURLErrorDomain:-1202",
    profiles: [
      { id: "p1", label: "Team A", current: true },
      { id: "p2", label: "b.example", current: false },
    ],
  };

  test("offers retry and the profile switcher, and never a proceed option on TLS errors", () => {
    const model = errorModel({ ...base, kind: "tls" }, "en");
    expect(model.actions.map((a) => a.id)).toEqual(["retry", "switch"]);
    expect(JSON.stringify(model)).not.toMatch(/proceed|continue anyway|ignore/i);
    expect(model.title).toBe("Cannot open this platform");
    expect(model.switcher.title).toBe("Platforms");
    expect(model.switcher.items).toEqual([
      { id: "p1", label: "Team A", current: true },
      { id: "p2", label: "b.example", current: false },
    ]);
    expect(model.switcher.add).toBe("Add a platform");
  });

  test("each kind has its own lead, in zh too", () => {
    const leads = new Set(
      (["unreachable", "tls", "crashed", "wipe_owed", "too_old"] as const).map(
        (kind) => errorModel({ ...base, kind }, "zh").lead,
      ),
    );
    expect(leads.size).toBe(5);
    for (const lead of leads) expect(lead).not.toMatch(/企业|agent/i);
  });
});
