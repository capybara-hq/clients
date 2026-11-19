import { describe, expect, test, vi } from "vitest";
import { bootAddressPreload } from "../src/preload/address-bridge.ts";
import { ADDRESS_CHANNELS } from "../src/shared/protocol.ts";

const INIT = { locale: "zh", strings: { "address.title": "添加平台" }, prefill: null };

function deps(over: { protocol?: string; host?: string; top?: boolean; init?: unknown } = {}) {
  return {
    ipcRenderer: {
      sendSync: vi.fn((_c: string) => (over.init === undefined ? INIT : over.init)),
      invoke: vi.fn(async (_c: string, ..._a: unknown[]): Promise<unknown> => ({ ok: true })),
    },
    contextBridge: { exposeInMainWorld: vi.fn((_k: string, _api: unknown) => undefined) },
    location: { protocol: over.protocol ?? "app:", host: over.host ?? "address" },
    isTopFrame: over.top ?? true,
  };
}

describe("the address preload", () => {
  test("exposes capybaraAddress on the top frame of app://address", async () => {
    const d = deps();
    expect(bootAddressPreload(d)).toBe(true);
    const [key, api] = d.contextBridge.exposeInMainWorld.mock.calls[0] ?? [];
    expect(key).toBe("capybaraAddress");
    const a = api as {
      submit(s: string): Promise<unknown>;
      open(): Promise<unknown>;
      locale: string;
    };
    expect(a.locale).toBe("zh");
    expect(Object.keys(a).sort()).toEqual(["locale", "open", "prefill", "strings", "submit"]);
    await a.submit("capybara.example.com");
    expect(d.ipcRenderer.invoke).toHaveBeenCalledWith(
      ADDRESS_CHANNELS.submit,
      "capybara.example.com",
    );
    await a.open();
    expect(d.ipcRenderer.invoke).toHaveBeenLastCalledWith(ADDRESS_CHANNELS.open);
  });

  test("never on a deployment, another app:// host or a sub-frame", () => {
    for (const d of [
      deps({ protocol: "https:", host: "capybara.example.com" }),
      deps({ host: "other" }),
      deps({ top: false }),
    ]) {
      expect(bootAddressPreload(d)).toBe(false);
      expect(d.ipcRenderer.sendSync).not.toHaveBeenCalled();
      expect(d.contextBridge.exposeInMainWorld).not.toHaveBeenCalled();
    }
  });

  test("nothing when main refuses", () => {
    const d = deps({ init: null });
    expect(bootAddressPreload(d)).toBe(false);
    expect(d.contextBridge.exposeInMainWorld).not.toHaveBeenCalled();
  });

  test("an IPC failure is failed", async () => {
    const d = deps();
    bootAddressPreload(d);
    const api = d.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
      submit(s: string): Promise<unknown>;
    };
    d.ipcRenderer.invoke.mockRejectedValueOnce(new Error("x"));
    expect(await api.submit("x")).toEqual({ ok: false, error: "failed" });
  });
});
