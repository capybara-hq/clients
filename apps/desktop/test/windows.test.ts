import { describe, expect, test, vi } from "vitest";
import type { Profile } from "../src/main/profiles.ts";
import { createWindowManager, type WindowManagerDeps } from "../src/main/windows.ts";
import { ADDRESS_URL, SHELL_CHANNELS, TRAFFIC_LIGHT_POSITION } from "../src/shared/protocol.ts";
import { fakeEmitter, fakeSession, fakeWebContents } from "./fakes.ts";

const p1: Profile = {
  id: "p1",
  base: "https://a.example.com/team",
  origin: "https://a.example.com",
  name: "A",
};
const p2: Profile = {
  id: "p2",
  base: "https://b.example.com",
  origin: "https://b.example.com",
  name: "B",
};

function setup(extra: Partial<WindowManagerDeps> = {}) {
  const created: ReturnType<typeof fakeWindow>[] = [];
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const options: Record<string, unknown>[] = [];
  const onFocusProfile = vi.fn();
  const onAddressClosed = vi.fn();
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
      loadURL: vi.fn(async (_url: string) => undefined),
    };
  }
  const windows = createWindowManager({
    createWindow: (opts) => {
      options.push(opts as unknown as Record<string, unknown>);
      const partition = (opts.webPreferences as { partition?: string }).partition ?? "";
      const origin = partition.startsWith("persist:profile-p2") ? p2.origin : p1.origin;
      const w = fakeWindow(partition === "address" ? "app://address" : origin);
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
    addressPreloadPath: "/dist/preload/address.cjs",
    platform: "macos",
    openExternal,
    describe: () => ({}),
    onFocusProfile,
    onAddressClosed,
    userAgent: "Capybara Desktop/0.1.0 (Box)",
    ...extra,
  });
  return { windows, created, options, sessions, onFocusProfile, onAddressClosed, openExternal };
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

  test("permission handlers are installed once per partition", () => {
    const { windows, sessions } = setup();
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p1, "https://a.example.com/team/files/1");
    const s = sessions.get("persist:profile-p1");
    expect(s?.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
  });

  test("the profile partition blocks in-window sign-in once; the address partition has no guard", () => {
    const { windows, sessions } = setup();
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p1);
    windows.openAddressWindow();
    const s = sessions.get("persist:profile-p1");
    expect(s?.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(s?.beforeRequest("POST", "https://a.example.com/team/api/v1/auth/login")).toBe(true);
    expect(s?.beforeRequest("GET", "https://a.example.com/team/api/v1/auth/sso/x/start")).toBe(
      true,
    );
    expect(s?.beforeRequest("GET", "https://a.example.com/team/chat/1")).toBe(false);
    expect(sessions.get("address")?.webRequest.onBeforeRequest).not.toHaveBeenCalled();
  });

  test("the profile partition sends the desktop user agent to its origin only", () => {
    const { windows, sessions } = setup();
    windows.openProfileWindow(p1);
    windows.openProfileWindow(p1);
    windows.openAddressWindow();
    const s = sessions.get("persist:profile-p1");
    expect(s?.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
    const chromium = { "User-Agent": "Mozilla/5.0" };
    expect(s?.beforeSendHeaders("https://a.example.com/team/api/v1/me", chromium)).toEqual({
      "User-Agent": "Capybara Desktop/0.1.0 (Box)",
    });
    expect(s?.beforeSendHeaders("https://github.com/login", chromium)).toEqual(chromium);
    expect(sessions.get("address")?.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();
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
});

describe("the address window", () => {
  test("loads the app:// page with its own preload and partition", () => {
    const { windows, created, options } = setup();
    windows.openAddressWindow();
    expect(options[0]).toMatchObject({
      titleBarStyle: "hiddenInset",
      webPreferences: { partition: "address", preload: "/dist/preload/address.cjs", sandbox: true },
    });
    expect(created[0]?.loadURL).toHaveBeenCalledWith(ADDRESS_URL);
    expect(windows.isAddressSender(created[0]?.webContents)).toBe(true);
    expect(windows.resolveSender(created[0]?.webContents)).toBeUndefined();
  });

  test("a second request focuses the open address window and keeps its prefill", () => {
    const { windows, created } = setup();
    windows.openAddressWindow("a.example.com");
    windows.openAddressWindow();
    expect(created).toHaveLength(1);
    expect(windows.prefillFor(created[0]?.webContents)).toBe("a.example.com");
  });

  test("the address partition denies every permission", async () => {
    const { windows, sessions } = setup();
    windows.openAddressWindow();
    const s = sessions.get("address");
    expect(s?.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(await s?.request("notifications", "app://address/index.html")).toBe(false);
    expect(s?.check("clipboard-sanitized-write", "app://address")).toBe(false);
  });

  test("closing the address window reports its webContents id", () => {
    const { windows, created, onAddressClosed } = setup();
    windows.openAddressWindow();
    const id = created[0]?.webContents.id;
    created[0]?.close();
    expect(onAddressClosed).toHaveBeenCalledWith(id);
  });

  test("a profile window is not an address sender", () => {
    const { windows, created } = setup();
    windows.openProfileWindow(p1);
    expect(windows.isAddressSender(created[0]?.webContents)).toBe(false);
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
