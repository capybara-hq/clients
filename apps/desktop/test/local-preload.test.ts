import { describe, expect, test, vi } from "vitest";
import { bootLocalPreload } from "../src/preload/local-bridge.ts";
import type { CapybaraLocal } from "../src/shared/local-page.ts";
import { LOCAL_CHANNELS } from "../src/shared/protocol.ts";

const STATE = { page: "connect", appearance: { scheme: "dark" } };

function deps(
  over: { protocol?: string; host?: string; top?: boolean; invoke?: unknown | Error } = {},
) {
  const on = new Map<string, (event: unknown, payload: unknown) => void>();
  return {
    on,
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, ..._a: unknown[]): Promise<unknown> => {
        if (over.invoke instanceof Error) throw over.invoke;
        if (over.invoke !== undefined) return over.invoke;
        return channel === LOCAL_CHANNELS.state ? STATE : { ok: true, value: 7 };
      }),
      on: vi.fn((c: string, l: (event: unknown, payload: unknown) => void) => on.set(c, l)),
    },
    contextBridge: { exposeInMainWorld: vi.fn((_k: string, _api: unknown) => undefined) },
    location: { protocol: over.protocol ?? "app:", host: over.host ?? "local" },
    isTopFrame: over.top ?? true,
  };
}

const apiOf = (d: ReturnType<typeof deps>) =>
  d.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as CapybaraLocal;

describe("the local preload", () => {
  test("exposes capybaraLocal with state, onState and act on app://local", async () => {
    const d = deps();
    expect(bootLocalPreload(d)).toBe(true);
    expect(d.contextBridge.exposeInMainWorld.mock.calls[0]?.[0]).toBe("capybaraLocal");
    const api = apiOf(d);
    expect(Object.keys(api).sort()).toEqual(["act", "onState", "state"]);
    expect(await api.state()).toEqual(STATE);
    expect(await api.act("prefs.setTheme", { theme: "light" })).toBe(7);
    expect(d.ipcRenderer.invoke).toHaveBeenLastCalledWith(LOCAL_CHANNELS.act, {
      action: "prefs.setTheme",
      args: { theme: "light" },
    });
  });

  test("pushed states reach subscribers until they unsubscribe", () => {
    const d = deps();
    bootLocalPreload(d);
    const api = apiOf(d);
    const seen: unknown[] = [];
    const off = api.onState((s) => seen.push(s));
    const push = d.on.get(LOCAL_CHANNELS.push);
    push?.({}, STATE);
    push?.({}, "not a state");
    off();
    push?.({}, STATE);
    expect(seen).toEqual([STATE]);
  });

  test("errors reject with the code", async () => {
    const refused = deps({ invoke: { ok: false, error: "refused" } });
    bootLocalPreload(refused);
    await expect(apiOf(refused).act("x")).rejects.toThrow("refused");
    await expect(apiOf(refused).state()).rejects.toThrow("refused");
    const broken = deps({ invoke: new Error("ipc") });
    bootLocalPreload(broken);
    await expect(apiOf(broken).act("x")).rejects.toThrow("failed");
  });

  test("never on a deployment, another app:// host or a sub-frame", () => {
    for (const d of [
      deps({ protocol: "https:", host: "capybara.example.com" }),
      deps({ host: "address" }),
      deps({ top: false }),
    ]) {
      expect(bootLocalPreload(d)).toBe(false);
      expect(d.contextBridge.exposeInMainWorld).not.toHaveBeenCalled();
      expect(d.ipcRenderer.on).not.toHaveBeenCalled();
    }
  });
});
