import { describe, expect, test, vi } from "vitest";
import { createWindowManager } from "../src/main/windows.ts";
import {
  bootShellPreload,
  installShellEnvironment,
  type ShellBridge,
} from "../src/preload/shell-environment.ts";
import {
  chromeState,
  SHELL_CHANNELS,
  type ShellInit,
  type ShellState,
} from "../src/shared/protocol.ts";
import type { CapybaraShell } from "../src/shared/sdk-shell-types.ts";
import { fakeEmitter, fakeSession, fakeWebContents } from "./fakes.ts";

const ORIGIN = "https://capybara.example.com";

const init: ShellInit = {
  origin: ORIGIN,
  platform: "macos",
  shellVersion: "0.1.0",
  insets: { top: 28, right: 0, bottom: 0, left: 0 },
  controls: { x: 0, y: 0, width: 80, height: 28 },
  capabilities: { "notify@1": ["notify"], "openExternal@1": ["open"] },
};

function fakeBridge() {
  let changed: ((s: ShellState) => void) | undefined;
  const bridge: ShellBridge & { fire(s: ShellState): void } = {
    call: vi.fn(
      async (_key: string, _fn: string, _args: unknown[]) => ({ ok: true, value: "v" }) as const,
    ),
    onChange(listener) {
      changed = listener;
    },
    fire(s) {
      changed?.(s);
    },
  };
  return bridge;
}

function install(fn: typeof installShellEnvironment = installShellEnvironment) {
  const bridge = fakeBridge();
  const target: { capybaraShell?: CapybaraShell } = {};
  fn(init, bridge, target);
  return { bridge, target, shell: target.capybaraShell as CapybaraShell };
}

describe("desktop values", () => {
  test("windowed and fullscreen", () => {
    expect(chromeState("macos", false)).toEqual({
      insets: { top: 28, right: 0, bottom: 0, left: 0 },
      controls: { x: 0, y: 0, width: 80, height: 28 },
    });
    expect(chromeState("macos", true)).toEqual({
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      controls: null,
    });
  });
});

describe("the Shell environment object", () => {
  test("has the contract's shape", () => {
    const { shell } = install();
    expect(shell.version).toBe(1);
    expect(shell.kind).toBe("desktop");
    expect(shell.platform).toBe("macos");
    expect(shell.shellVersion).toBe("0.1.0");
    expect(shell.insets).toEqual({ top: 28, right: 0, bottom: 0, left: 0 });
    expect(shell.controls).toEqual({ x: 0, y: 0, width: 80, height: 28 });
    expect(Object.keys(shell.capabilities)).toEqual(["notify@1", "openExternal@1"]);
    expect(typeof (shell.capabilities["notify@1"] as Record<string, unknown>).notify).toBe(
      "function",
    );
    expect(Object.isFrozen(shell)).toBe(true);
    expect(Object.isFrozen(shell.capabilities)).toBe(true);
  });

  test("the global cannot be replaced by the page", () => {
    const { target, shell } = install();
    expect(() => {
      (target as Record<string, unknown>).capybaraShell = {};
    }).toThrow();
    expect(target.capybaraShell).toBe(shell);
  });

  test("a capability function forwards key, name and arguments", async () => {
    const { shell, bridge } = install();
    const notify = (shell.capabilities["notify@1"] as { notify(i: unknown): Promise<unknown> })
      .notify;
    await expect(notify({ title: "t", body: "b" })).resolves.toBe("v");
    expect(bridge.call).toHaveBeenCalledWith("notify@1", "notify", [{ title: "t", body: "b" }]);
  });

  test("a refused call rejects with { code }", async () => {
    const { shell, bridge } = install();
    vi.mocked(bridge.call).mockResolvedValueOnce({ ok: false, code: "busy" });
    const open = (shell.capabilities["openExternal@1"] as { open(u: string): Promise<unknown> })
      .open;
    await expect(open("https://x.example.com")).rejects.toMatchObject({ code: "busy" });
  });

  test("fullscreen sets top 0 and controls null and emits change", () => {
    const { shell, bridge } = install();
    const listener = vi.fn();
    const off = shell.on("change", listener);
    bridge.fire({ ...chromeState("macos", true), capabilities: init.capabilities });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(shell.insets.top).toBe(0);
    expect(shell.controls).toBeNull();
    bridge.fire({ ...chromeState("macos", false), capabilities: init.capabilities });
    expect(shell.insets.top).toBe(28);
    expect(shell.controls).toEqual({ x: 0, y: 0, width: 80, height: 28 });
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    bridge.fire({ ...chromeState("macos", true), capabilities: init.capabilities });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("a capability can appear after load", () => {
    const { shell, bridge } = install();
    expect(shell.capabilities["device@1"]).toBeUndefined();
    bridge.fire({
      ...chromeState("macos", false),
      capabilities: { ...init.capabilities, "device@1": ["status"] },
    });
    expect(typeof (shell.capabilities["device@1"] as Record<string, unknown>).status).toBe(
      "function",
    );
  });

  test("a throwing listener does not stop the others", () => {
    const { shell, bridge } = install();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = vi.fn();
    shell.on("change", () => {
      throw new Error("x");
    });
    shell.on("change", second);
    bridge.fire({ ...chromeState("macos", true), capabilities: {} });
    expect(second).toHaveBeenCalled();
    error.mockRestore();
  });

  test("on() ignores other events and non-functions", () => {
    const { shell } = install();
    expect(typeof shell.on("other" as "change", () => {})).toBe("function");
    expect(typeof shell.on("change", "x" as unknown as () => void)).toBe("function");
  });

  test("the function survives serialization (executeInMainWorld runs its source text)", async () => {
    const revived = new Function(`return (${installShellEnvironment.toString()})`)();
    const { shell, bridge } = install(revived);
    expect(shell.version).toBe(1);
    await (shell.capabilities["notify@1"] as { notify(): Promise<unknown> }).notify();
    expect(bridge.call).toHaveBeenCalled();
  });
});

function fakePreloadDeps(over: { origin?: string; top?: boolean; init?: unknown } = {}) {
  const changeListeners: ((e: unknown, s: unknown) => void)[] = [];
  let active = false;
  const deps = {
    ipcRenderer: {
      sendSync: vi.fn((_channel: string) => (over.init === undefined ? init : over.init)),
      invoke: vi.fn(
        async (_channel: string, _req: unknown): Promise<unknown> => ({ ok: true, value: 1 }),
      ),
      on: vi.fn((_channel: string, l: (e: unknown, s: unknown) => void) => {
        changeListeners.push(l);
      }),
    },
    contextBridge: {
      executeInMainWorld: vi.fn((_s: { func: unknown; args: unknown[] }) => undefined),
    },
    location: { origin: over.origin ?? ORIGIN },
    isTopFrame: over.top ?? true,
    userActivation: () => active,
    setActive(v: boolean) {
      active = v;
    },
    changeListeners,
  };
  return deps;
}

describe("the preload", () => {
  test("injects into the top frame of the profile origin", () => {
    const deps = fakePreloadDeps();
    expect(bootShellPreload(deps)).toBe(true);
    expect(deps.ipcRenderer.sendSync).toHaveBeenCalledWith(SHELL_CHANNELS.init);
    const script = deps.contextBridge.executeInMainWorld.mock.calls[0]?.[0];
    expect(script?.func).toBe(installShellEnvironment);
    expect(script?.args[0]).toEqual(init);
  });

  test("does nothing in a sub-frame (no IPC at all)", () => {
    const deps = fakePreloadDeps({ top: false });
    expect(bootShellPreload(deps)).toBe(false);
    expect(deps.ipcRenderer.sendSync).not.toHaveBeenCalled();
    expect(deps.contextBridge.executeInMainWorld).not.toHaveBeenCalled();
  });

  test("does nothing when main refuses or the origin differs", () => {
    for (const deps of [
      fakePreloadDeps({ init: null }),
      fakePreloadDeps({ origin: "https://idp.example.com" }),
      fakePreloadDeps({ init: { ...init, capabilities: "x" } }),
    ]) {
      expect(bootShellPreload(deps)).toBe(false);
      expect(deps.contextBridge.executeInMainWorld).not.toHaveBeenCalled();
    }
  });

  test("a call reports the activation at call time and never invokes another channel", async () => {
    const deps = fakePreloadDeps();
    bootShellPreload(deps);
    const bridge = deps.contextBridge.executeInMainWorld.mock.calls[0]?.[0].args[1] as ShellBridge;
    deps.setActive(true);
    expect(await bridge.call("notify@1", "notify", [1])).toEqual({ ok: true, value: 1 });
    expect(deps.ipcRenderer.invoke).toHaveBeenCalledWith(SHELL_CHANNELS.call, {
      key: "notify@1",
      fn: "notify",
      args: [1],
      activation: true,
    });
    deps.setActive(false);
    await bridge.call("notify@1", "notify", []);
    expect(deps.ipcRenderer.invoke.mock.calls[1]?.[1]).toMatchObject({ activation: false });
  });

  test("an IPC failure or a malformed answer is failed", async () => {
    const deps = fakePreloadDeps();
    bootShellPreload(deps);
    const bridge = deps.contextBridge.executeInMainWorld.mock.calls[0]?.[0].args[1] as ShellBridge;
    deps.ipcRenderer.invoke.mockRejectedValueOnce(new Error("could not clone"));
    expect(await bridge.call("notify@1", "notify", [])).toEqual({ ok: false, code: "failed" });
    deps.ipcRenderer.invoke.mockResolvedValueOnce({ ok: false, code: "nope" });
    expect(await bridge.call("notify@1", "notify", [])).toEqual({ ok: false, code: "failed" });
  });

  test("change events from main reach the listener", () => {
    const deps = fakePreloadDeps();
    bootShellPreload(deps);
    const bridge = deps.contextBridge.executeInMainWorld.mock.calls[0]?.[0].args[1] as ShellBridge;
    const listener = vi.fn();
    bridge.onChange(listener);
    expect(deps.ipcRenderer.on).toHaveBeenCalledWith(SHELL_CHANNELS.change, expect.any(Function));
    const state = { ...chromeState("macos", true), capabilities: {} };
    for (const l of deps.changeListeners) l({}, state);
    expect(listener).toHaveBeenCalledWith(state);
  });
});

describe("the main side announces fullscreen", () => {
  function fakeWindow() {
    const em = fakeEmitter();
    const wc = fakeWebContents();
    let fullscreen = false;
    return {
      ...em,
      on: em.on,
      webContents: wc,
      isFullScreen: () => fullscreen,
      setFullScreenState(v: boolean) {
        fullscreen = v;
        em.emit(v ? "enter-full-screen" : "leave-full-screen");
      },
      show: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      setBackgroundColor: vi.fn(),
      loadURL: vi.fn(async () => undefined),
    };
  }

  test("enter and leave fullscreen send change to the page", () => {
    const win = fakeWindow();
    const windows = createWindowManager({
      createWindow: () => win,
      sessionFor: () => fakeSession(),
      preloadPath: "/p.cjs",
      addressPreloadPath: "/a.cjs",
      platform: "macos",
      openExternal: vi.fn(),
      describe: () => ({ "notify@1": ["notify"] }),
      onFocusProfile: vi.fn(),
    });
    windows.openProfileWindow({ id: "p1", base: ORIGIN, origin: ORIGIN, name: "E" });
    win.setFullScreenState(true);
    expect(win.webContents.send).toHaveBeenLastCalledWith(SHELL_CHANNELS.change, {
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      controls: null,
      capabilities: { "notify@1": ["notify"] },
    });
    win.setFullScreenState(false);
    expect(win.webContents.send).toHaveBeenLastCalledWith(SHELL_CHANNELS.change, {
      insets: { top: 28, right: 0, bottom: 0, left: 0 },
      controls: { x: 0, y: 0, width: 80, height: 28 },
      capabilities: { "notify@1": ["notify"] },
    });
  });

  test("nothing is sent while the window is off the profile origin", () => {
    const win = fakeWindow();
    win.webContents.mainFrame.origin = "https://idp.example.com";
    const windows = createWindowManager({
      createWindow: () => win,
      sessionFor: () => fakeSession(),
      preloadPath: "/p.cjs",
      addressPreloadPath: "/a.cjs",
      platform: "macos",
      openExternal: vi.fn(),
      describe: () => ({}),
      onFocusProfile: vi.fn(),
    });
    windows.openProfileWindow({ id: "p1", base: ORIGIN, origin: ORIGIN, name: "E" });
    win.setFullScreenState(true);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
