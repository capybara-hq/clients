import { describe, expect, test, vi } from "vitest";
import type { Profile } from "../src/main/profiles.ts";
import {
  createWindowManager,
  smallWindowControls,
  smallWindowOptions,
  type WindowManagerDeps,
} from "../src/main/windows.ts";
import {
  DESKTOP_CONTROLS,
  localPageUrl,
  SHELL_CHANNELS,
  TRAFFIC_LIGHT_POSITION,
} from "../src/shared/protocol.ts";
import { fakeEmitter, fakeSession, fakeWebContents } from "./fakes.ts";

const COLORS = { background: "#0A0A0A", symbol: "#8E8E89" };

const p1: Profile = {
  id: "p1",
  signedIn: true,
  base: "https://a.example.com/team",
  origin: "https://a.example.com",
  name: "A",
};
const p2: Profile = {
  id: "p2",
  signedIn: true,
  base: "https://b.example.com",
  origin: "https://b.example.com",
  name: "B",
};

function setup(extra: Partial<WindowManagerDeps> = {}) {
  const created: ReturnType<typeof fakeWindow>[] = [];
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const options: Record<string, unknown>[] = [];
  const onFocusProfile = vi.fn();
  const openExternal = vi.fn();
  function fakeWindow(origin: string) {
    const em = fakeEmitter();
    let destroyed = false;
    return {
      ...em,
      on: em.on,
      webContents: fakeWebContents(origin),
      isFullScreen: () => false,
      show: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(() => {
        destroyed = true;
        em.emit("closed");
      }),
      isDestroyed: () => destroyed,
      isMinimized: () => false,
      restore: vi.fn(),
      setBackgroundColor: vi.fn(),
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
      getBounds() {
        return { ...this.bounds };
      },
      loadURL: vi.fn(async (_url: string) => undefined),
    };
  }
  const windows = createWindowManager({
    createWindow: (opts) => {
      options.push(opts as unknown as Record<string, unknown>);
      const partition = (opts.webPreferences as { partition?: string }).partition ?? "";
      const origin = partition.startsWith("persist:profile-p2") ? p2.origin : p1.origin;
      const w = fakeWindow(partition === "local" ? "app://local" : origin);
      if (typeof opts.x === "number" && typeof opts.y === "number") {
        w.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      }
      created.push(w);
      return w;
    },
    sessionFor: (partition) => {
      let s = sessions.get(partition);
      if (!s) {
        s = fakeSession();
        vi.spyOn(s, "setPermissionRequestHandler");
        sessions.set(partition, s);
      }
      return s;
    },
    preloadPath: "/dist/preload/index.cjs",
    localPreloadPath: "/dist/preload/local.cjs",
    platform: "macos",
    openExternal,
    describe: () => ({}),
    onFocusProfile,
    userAgent: "Capybara Desktop/0.1.0 (Box)",
    ...extra,
  });
  return { windows, created, options, sessions, onFocusProfile, openExternal };
}

describe("profile windows", () => {
  test("hiddenInset title bar at the fixed traffic light position, the profile partition", () => {
    const { windows, options, created } = setup();
    windows.openProfileWindow(p1);
    expect(options[0]).toMatchObject({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: TRAFFIC_LIGHT_POSITION,
      webPreferences: {
        partition: "persist:profile-p1",
        preload: "/dist/preload/index.cjs",
        contextIsolation: true,
        sandbox: true,
      },
    });
    expect(created[0]?.loadURL).toHaveBeenCalledWith("https://a.example.com/team");
  });

  test("the sign-out hooks: once per partition, once per profile window", () => {
    const onPartitionPrepared = vi.fn();
    const onProfileWindow = vi.fn();
    const { windows, created } = setup({ onPartitionPrepared, onProfileWindow });
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p2);
    windows.openSmallWindow(COLORS);
    expect(onPartitionPrepared.mock.calls).toEqual([
      [p1, "persist:profile-p1"],
      [p2, "persist:profile-p2"],
    ]);
    expect(onProfileWindow.mock.calls).toEqual([
      [p1, created[0]],
      [p1, created[1]],
      [p2, created[2]],
    ]);
  });

  test("hasProfileWindows and profileUrls (sign-out pairs a logout with a window on /login)", () => {
    const { windows, created } = setup();
    expect(windows.hasProfileWindows("p1")).toBe(false);
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p2);
    Object.assign(created[0]?.webContents ?? {}, {
      getURL: () => "https://a.example.com/team/login",
    });
    expect(windows.hasProfileWindows("p1")).toBe(true);
    expect(windows.profileUrls("p1")).toEqual(["https://a.example.com/team/login"]);
    // No getURL on the fake: nothing to report.
    expect(windows.profileUrls("p2")).toEqual([]);
    windows.closeProfileWindows("p1");
    expect(windows.hasProfileWindows("p1")).toBe(false);
  });

  test("permission handlers are installed once per partition", () => {
    const { windows, sessions } = setup();
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p1, "https://a.example.com/team/files/1");
    const s = sessions.get("persist:profile-p1");
    expect(s?.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
  });

  test("the profile partition blocks in-window sign-in once; the local partition has no guard", () => {
    const { windows, sessions } = setup();
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p1);
    windows.openSmallWindow(COLORS);
    const s = sessions.get("persist:profile-p1");
    expect(s?.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(s?.beforeRequest("POST", "https://a.example.com/team/api/v1/auth/login")).toBe(true);
    expect(s?.beforeRequest("GET", "https://a.example.com/team/api/v1/auth/sso/x/start")).toBe(
      true,
    );
    expect(s?.beforeRequest("GET", "https://a.example.com/team/chat/1")).toBe(false);
    expect(sessions.get("local")).toBeUndefined();
  });

  test("the profile partition sends the desktop user agent to its origin only", () => {
    const { windows, sessions } = setup();
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p1);
    windows.openSmallWindow(COLORS);
    const s = sessions.get("persist:profile-p1");
    expect(s?.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
    const chromium = { "User-Agent": "Mozilla/5.0" };
    expect(s?.beforeSendHeaders("https://a.example.com/team/api/v1/me", chromium)).toEqual({
      "User-Agent": "Capybara Desktop/0.1.0 (Box)",
    });
    expect(s?.beforeSendHeaders("https://github.com/login", chromium)).toEqual(chromium);
    expect(sessions.get("local")).toBeUndefined();
  });

  test("reloadProfile reloads the profile's windows on its origin and brings one forward", () => {
    const { windows, created } = setup();
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p2);
    // The second window wandered off the origin (an identity provider): it goes back to the base.
    if (created[1]) created[1].webContents.mainFrame.origin = "https://idp.example.com";
    windows.reloadProfile(p1);
    expect(created[0]?.webContents.reload).toHaveBeenCalledTimes(1);
    expect(created[1]?.webContents.reload).not.toHaveBeenCalled();
    expect(created[1]?.loadURL).toHaveBeenLastCalledWith("https://a.example.com/team");
    expect(created[2]?.webContents.reload).not.toHaveBeenCalled();
    expect(created[1]?.focus).toHaveBeenCalled();
  });

  test("reloadProfile opens a window when the profile has none", () => {
    const { windows, created } = setup();
    windows.reloadProfile(p1);
    expect(created).toHaveLength(1);
    expect(created[0]?.loadURL).toHaveBeenCalledWith("https://a.example.com/team");
  });

  test("senders resolve to their profile; unknown senders do not", () => {
    const { windows, created } = setup();
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p2);
    expect(windows.resolveSender(created[0]?.webContents)?.profile.id).toBe("p1");
    expect(windows.resolveSender(created[1]?.webContents)?.profile.id).toBe("p2");
    expect(windows.resolveSender(fakeWebContents())).toBeUndefined();
  });

  test("a closed window is forgotten", () => {
    const { windows, created } = setup();
    windows.openProfileWindow(p1);
    const wc = created[0]?.webContents;
    created[0]?.close();
    expect(windows.resolveSender(wc)).toBeUndefined();
  });

  test("a same-origin window.open opens another window of the same profile", () => {
    const { windows, created, options } = setup();
    windows.openProfileWindow(p1);
    created[0]?.webContents.openWindow("https://a.example.com/team/share/x");
    expect(created).toHaveLength(2);
    expect(options[1]).toMatchObject({ webPreferences: { partition: "persist:profile-p1" } });
    expect(created[1]?.loadURL).toHaveBeenCalledWith("https://a.example.com/team/share/x");
  });

  test("a foreign window.open goes to the system browser", () => {
    const { windows, created, openExternal } = setup();
    windows.openProfileWindow(p1);
    created[0]?.webContents.openWindow("https://docs.example.com/");
    expect(openExternal).toHaveBeenCalledWith("https://docs.example.com/");
    expect(created).toHaveLength(1);
  });

  test("showProfile focuses an open window and navigates; opens one otherwise", () => {
    const { windows, created } = setup();
    windows.showProfile(p1);
    expect(created).toHaveLength(1);
    windows.showProfile(p1, "https://a.example.com/team/chat/1");
    expect(created).toHaveLength(1);
    expect(created[0]?.focus).toHaveBeenCalled();
    expect(created[0]?.loadURL).toHaveBeenLastCalledWith("https://a.example.com/team/chat/1");
  });

  test("focus records the last used profile", () => {
    const { windows, created, onFocusProfile } = setup();
    windows.openProfileWindow(p1);
    created[0]?.emit("focus");
    expect(onFocusProfile).toHaveBeenCalledWith(p1);
  });

  test("focusLast focuses the most recently focused window", () => {
    const { windows, created } = setup();
    expect(windows.focusLast()).toBe(false);
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p2);
    created[0]?.emit("focus");
    expect(windows.focusLast()).toBe(true);
    expect(created[0]?.focus).toHaveBeenCalled();
  });

  test("focusLast skips windows of profiles the filter refuses", () => {
    const { windows, created } = setup();
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p2);
    created[1]?.emit("focus");
    expect(windows.focusLast((p) => p.id === "p1")).toBe(true);
    expect(created[0]?.focus).toHaveBeenCalled();
    expect(created[1]?.focus).not.toHaveBeenCalled();
    expect(windows.focusLast(() => false)).toBe(false);
  });

  test("closeProfileWindows closes every window of a profile", () => {
    const { windows, created } = setup();
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p2);
    windows.closeProfileWindows("p1");
    expect(created[0]?.close).toHaveBeenCalled();
    expect(created[1]?.close).toHaveBeenCalled();
    expect(created[2]?.close).not.toHaveBeenCalled();
  });

  test("closeProfileWindows forgets the windows at once, before `closed` arrives", () => {
    const onProfileClosed = vi.fn();
    const { windows, created } = setup({ onProfileClosed });
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p2);
    // A real close is asynchronous (beforeunload, then `closed`): nothing is emitted here.
    created[0]?.close.mockImplementation(() => {});
    const sender = created[0]?.webContents;
    expect(windows.resolveSender(sender)?.profile.id).toBe("p1");
    windows.closeProfileWindows("p1");
    expect(created[0]?.close).toHaveBeenCalledTimes(1);
    // No IPC resolves to the closing window while the removal clears its partition.
    expect(windows.resolveSender(sender)).toBeUndefined();
    expect(onProfileClosed).toHaveBeenCalledExactlyOnceWith(sender?.id);
    // The late `closed` changes nothing more.
    created[0]?.emit("closed");
    expect(onProfileClosed).toHaveBeenCalledTimes(1);
    expect(windows.resolveSender(created[1]?.webContents)?.profile.id).toBe("p2");
  });

  test("a closed window is forgotten without touching its destroyed webContents", () => {
    const onProfileClosed = vi.fn();
    const { windows, created } = setup({ onProfileClosed });
    windows.openSmallWindow(COLORS);
    windows.openProfileWindow(p1);
    const ids = created.map((w) => w.webContents.id);
    // Electron: reading `webContents` of a window that emitted `closed` throws.
    for (const w of created) {
      Object.defineProperty(w, "webContents", {
        get() {
          throw new TypeError("Object has been destroyed");
        },
      });
    }
    expect(() => created[0]?.emit("closed")).not.toThrow();
    expect(() => created[1]?.emit("closed")).not.toThrow();
    expect(onProfileClosed).toHaveBeenCalledExactlyOnceWith(ids[1]);
    expect(windows.hasWindows()).toBe(false);
  });

  test("dialogParent: the profile's window (the front one if it is), never another's", () => {
    const { windows, created } = setup();
    expect(windows.dialogParent("p1")).toBeUndefined();
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p2);
    created[0]?.emit("focus");
    expect(windows.dialogParent("p1")).toBe(created[0]);
    created[2]?.emit("focus");
    // p1 is not in front: its newest window.
    expect(windows.dialogParent("p1")).toBe(created[1]);
    expect(windows.dialogParent("p2")).toBe(created[2]);
    // No window of that profile: none (the dialog stands alone), not another profile's window.
    expect(windows.dialogParent("p3")).toBeUndefined();
    windows.closeProfileWindows("p2");
    expect(windows.dialogParent("p3")).toBeUndefined();
  });
});

describe("the small window", () => {
  test("480×600 on the local onboarding page, fixed size, the local partition and preload", () => {
    const { windows, created, options } = setup();
    const { window, created: isNew } = windows.openSmallWindow(COLORS);
    expect(isNew).toBe(true);
    expect(window).toBe(created[0]);
    expect(options[0]).toMatchObject({
      width: 480,
      height: 600,
      useContentSize: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: TRAFFIC_LIGHT_POSITION,
      backgroundColor: "#0A0A0A",
      webPreferences: { partition: "local", preload: "/dist/preload/local.cjs", sandbox: true },
    });
    expect(options[0]).not.toHaveProperty("titleBarOverlay");
    expect(created[0]?.loadURL).toHaveBeenCalledWith(localPageUrl("onboarding"));
    // Not a profile window: no Shell IPC resolves to it.
    expect(windows.resolveSender(created[0]?.webContents)).toBeUndefined();
    expect(windows.smallWindow()).toBe(created[0]);
  });

  test("one at a time: a second request brings the open one forward", () => {
    const { windows, created } = setup();
    windows.openSmallWindow(COLORS);
    const again = windows.openSmallWindow(COLORS);
    expect(again.created).toBe(false);
    expect(created).toHaveLength(1);
    expect(created[0]?.focus).toHaveBeenCalled();
  });

  test("a closed small window is forgotten; closeSmallWindow closes it", () => {
    const { windows, created } = setup();
    windows.openSmallWindow(COLORS);
    windows.closeSmallWindow();
    expect(created[0]?.close).toHaveBeenCalled();
    expect(windows.smallWindow()).toBeUndefined();
    expect(windows.hasWindows()).toBe(false);
  });

  test("it stays on app://local", () => {
    const { windows, created } = setup();
    windows.openSmallWindow(COLORS);
    const away = { url: "https://evil.example.com/", preventDefault: vi.fn() };
    created[0]?.webContents.emit("will-navigate", away, away.url);
    expect(away.preventDefault).toHaveBeenCalled();
  });

  test("focusLast and dialogParent include it (dialogParent while it is in front)", () => {
    const { windows, created } = setup();
    windows.openSmallWindow(COLORS);
    expect(windows.focusLast(() => false)).toBe(true);
    created[0]?.emit("focus");
    expect(windows.dialogParent("p1")).toBe(created[0]);
  });

  test("Windows and Linux: a hidden title bar with the caption overlay in the appearance's colors", () => {
    for (const platform of ["windows", "linux"] as const) {
      const o = smallWindowOptions(platform, COLORS, { title: "Capybara", preload: "/l.cjs" });
      expect(o).toMatchObject({
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#0A0A0A", symbolColor: "#8E8E89", height: 32 },
        resizable: false,
        maximizable: false,
        fullscreenable: false,
      });
      expect(o).not.toHaveProperty("trafficLightPosition");
      expect(smallWindowControls(platform)).toEqual({ x: 342, y: 0, width: 138, height: 32 });
    }
    expect(smallWindowControls("macos")).toEqual(DESKTOP_CONTROLS);
  });
});

describe("the main window's rectangle", () => {
  const displays = () => [
    { workArea: { x: 0, y: 25, width: 1440, height: 875 }, primary: true },
    { workArea: { x: 1440, y: 0, width: 1920, height: 1080 } },
  ];

  test("first opening: 1280×800 centered on the primary display, minimum 480×400", () => {
    const { windows, options } = setup({ displays });
    windows.openProfileWindow(p1);
    expect(options[0]).toMatchObject({
      x: 80,
      y: 63,
      width: 1280,
      height: 800,
      minWidth: 480,
      minHeight: 400,
    });
  });

  test("a saved rectangle on a display is reused; one off every display is centered", () => {
    const { windows, options } = setup({ displays });
    windows.openProfileWindow({ ...p1, bounds: { x: 1500, y: 100, width: 900, height: 700 } });
    windows.openProfileWindow({ ...p2, bounds: { x: 9000, y: 9000, width: 900, height: 700 } });
    expect(options[0]).toMatchObject({ x: 1500, y: 100, width: 900, height: 700 });
    expect(options[1]).toMatchObject({ x: 80, y: 63, width: 1280, height: 800 });
  });

  test("a further window of the profile cascades from the first and is not remembered", () => {
    const saveBounds = vi.fn();
    const { windows, options, created } = setup({ displays, saveBounds });
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p2);
    expect(options[1]).toMatchObject({ x: 104, y: 87, width: 1280, height: 800 });
    // Another profile's first window: its own rectangle.
    expect(options[2]).toMatchObject({ x: 80, y: 63 });
    created[1]?.emit("close");
    expect(saveBounds).not.toHaveBeenCalled();
    created[0]?.emit("close");
    expect(saveBounds).toHaveBeenCalledWith("p1", expect.anything());
  });

  test("moves and resizes are saved for the profile (debounced), and on close", () => {
    const saveBounds = vi.fn();
    const timers: (() => void)[] = [];
    const { windows, created } = setup({
      displays,
      saveBounds,
      boundsScheduler: { set: (fn) => timers.push(fn), clear: () => undefined },
    });
    windows.openProfileWindow(p1);
    const win = created[0];
    if (!win) throw new Error("no window");
    win.bounds = { x: 10, y: 20, width: 1000, height: 700 };
    win.emit("resize");
    expect(saveBounds).not.toHaveBeenCalled();
    timers.at(-1)?.();
    expect(saveBounds).toHaveBeenLastCalledWith("p1", { x: 10, y: 20, width: 1000, height: 700 });
    win.bounds = { x: 30, y: 40, width: 1000, height: 700 };
    win.emit("close");
    expect(saveBounds).toHaveBeenLastCalledWith("p1", { x: 30, y: 40, width: 1000, height: 700 });
  });
});

describe("device@1 support", () => {
  test("a main-frame navigation of a profile window reports the profile load", () => {
    const onProfileLoad = vi.fn();
    const { windows, created } = setup({ onProfileLoad });
    windows.openProfileWindow(p1);
    created[0]?.webContents.emit("did-navigate", {}, "https://a.example.com/team");
    expect(onProfileLoad).toHaveBeenCalledWith(p1);
  });

  test("a closed profile window reports its webContents id", () => {
    const onProfileClosed = vi.fn();
    const { windows, created } = setup({ onProfileClosed });
    windows.openProfileWindow(p1);
    const id = created[0]?.webContents.id;
    created[0]?.close();
    expect(onProfileClosed).toHaveBeenCalledWith(id);
  });

  test("change carries the event names when there are any", () => {
    const { windows, created } = setup({
      describe: () => ({ "device@1": ["status"] }),
      describeEvents: () => ({ "device@1": ["onStatus"] }),
    });
    windows.openProfileWindow(p1);
    windows.broadcastChange(p1.id);
    expect(created[0]?.webContents.send).toHaveBeenLastCalledWith(
      SHELL_CHANNELS.change,
      expect.objectContaining({ events: { "device@1": ["onStatus"] } }),
    );
  });

  test("an event goes only to a window still on the profile origin", () => {
    const { windows, created } = setup();
    const win = windows.openProfileWindow(p1);
    expect(windows.sendEvent({ profile: p1, window: win }, { doc: "d", id: 1, payload: 1 })).toBe(
      true,
    );
    expect(created[0]?.webContents.send).toHaveBeenLastCalledWith(SHELL_CHANNELS.event, {
      doc: "d",
      id: 1,
      payload: 1,
    });
    if (created[0]) created[0].webContents.mainFrame.origin = "https://idp.example.com";
    expect(windows.sendEvent({ profile: p1, window: win }, { doc: "d", id: 1, payload: 2 })).toBe(
      false,
    );
    expect(created[0]?.webContents.send).toHaveBeenCalledTimes(1);
  });

  test("the verification window: a child of the profile window, its partition, no preload", () => {
    const { windows, options, created } = setup();
    const parent = windows.openProfileWindow(p1);
    const child = windows.openChildWindow(
      p1,
      parent,
      "https://a.example.com/team/devices/link?code=X&org=o",
    );
    expect(options[1]).toMatchObject({
      parent,
      webPreferences: { partition: "persist:profile-p1", contextIsolation: true, sandbox: true },
    });
    expect(options[1]?.webPreferences).not.toHaveProperty("preload");
    // An ordinary window: the default title bar, no inset traffic lights.
    expect(options[1]).not.toHaveProperty("titleBarStyle");
    expect(options[1]).not.toHaveProperty("trafficLightPosition");
    expect(created[1]?.loadURL).toHaveBeenCalledWith(
      "https://a.example.com/team/devices/link?code=X&org=o",
    );
    // It is not a profile window: no IPC resolves to it.
    expect(windows.resolveSender(created[1]?.webContents)).toBeUndefined();
    const closed = vi.fn();
    child.onClosed(closed);
    child.close();
    expect(closed).toHaveBeenCalledOnce();
  });

  test("a parent that is gone opens the verification window on its own", () => {
    const { windows, options } = setup();
    windows.openChildWindow(p1, { isDestroyed: () => true }, "https://a.example.com/team/x");
    expect(options[0]?.parent).toBeUndefined();
  });
});
