import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { dialogButtons, naturalHeight } from "../src/local/dialog-model.ts";
import { createLocalPages } from "../src/main/local-pages.ts";
import {
  CONFIRM_LOCKOUT_MS,
  checkOptions,
  cleanPlatformName,
  createShellDialogs,
  DIALOG_MAX_HEIGHT,
  DIALOG_MIN_HEIGHT,
  type DialogWindow,
  type DialogWindowOptions,
  PARENT_TOP_OFFSET,
  SHOW_FALLBACK_MS,
  SHOW_TIMEOUT_MS,
  type ShellDialogOptions,
  signOutDialogOptions,
} from "../src/main/shell-dialog.ts";
import { LOCAL_ORIGIN, localPageUrl } from "../src/shared/protocol.ts";

type Listener = (...args: unknown[]) => void;

function emitter() {
  // Like Node's EventEmitter: removeListener also removes a `once` listener by its original.
  const listeners = new Map<string, Array<{ l: Listener; once: boolean }>>();
  const api = {
    on(event: string, l: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), { l, once: false }]);
    },
    once(event: string, l: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), { l, once: true }]);
    },
    removeListener(event: string, l: Listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((x) => x.l !== l),
      );
    },
    emit(event: string, ...a: unknown[]) {
      for (const x of [...(listeners.get(event) ?? [])]) {
        if (x.once) api.removeListener(event, x.l);
        x.l(...a);
      }
    },
    count(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
  return api;
}

let nextId = 100;

function fakeWindow(options: DialogWindowOptions) {
  const ev = emitter();
  const wcEv = emitter();
  let destroyed = false;
  const contents = {
    id: nextId++,
    send: vi.fn(),
    isDestroyed: () => destroyed,
    on: (event: string, l: Listener) => wcEv.on(event, l),
    once: (event: string, l: Listener) => wcEv.once(event, l),
    setWindowOpenHandler: vi.fn(),
    emit: wcEv.emit,
  };
  const win = {
    options,
    webContents: contents,
    focused: false,
    on: (event: string, l: Listener) => ev.on(event, l),
    once: (event: string, l: Listener) => ev.once(event, l),
    // Like Electron: showing emits `show` and gives the window focus.
    show: vi.fn(() => {
      ev.emit("show");
      win.focused = true;
      ev.emit("focus");
    }),
    isFocused: () => win.focused,
    close: vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      ev.emit("closed");
      wcEv.emit("destroyed");
    }),
    isDestroyed: () => destroyed,
    setContentSize: vi.fn(),
    setPosition: vi.fn(),
    loadURL: vi.fn(async (_url: string) => undefined),
    emit: ev.emit,
  };
  return win;
}

type FakeWindow = ReturnType<typeof fakeWindow>;

const BASE = {
  locale: "zh" as const,
  appearance: { scheme: "dark" as const },
  controls: null,
  os: "macos" as const,
  appName: "Capybara",
  version: "0.1.0",
};

const OPTIONS: ShellDialogOptions = {
  title: "退出 Acme？",
  detail: "Detail.",
  buttons: ["取消", "退出登录"],
  defaultId: 0,
  cancelId: 0,
  confirmId: 1,
  tone: "primary",
  platform: { name: "Acme", host: "acme.example.com" },
};

function fakeParent(o: { visible?: boolean; minimized?: boolean } = {}) {
  const ev = emitter();
  return {
    ...ev,
    kind: "parent",
    isVisible: () => o.visible ?? true,
    isMinimized: () => o.minimized ?? false,
    getBounds: () => ({ x: 100, y: 50, width: 1000, height: 700 }),
  };
}

function setup(o: { loadFails?: boolean; os?: "macos" | "windows" | "linux" } = {}) {
  let clock = 1_000;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const windows: FakeWindow[] = [];
  const pages = createLocalPages();
  const dialogs = createShellDialogs({
    createWindow: (options) => {
      const w = fakeWindow(options);
      if (o.loadFails) w.loadURL.mockRejectedValue(new Error("ERR_FAILED"));
      windows.push(w);
      return w as unknown as DialogWindow;
    },
    localPages: pages,
    preloadPath: "/dist/preload/local.cjs",
    liveParent: (p) =>
      typeof p === "object" && p !== null && (p as { kind?: string }).kind === "parent"
        ? (p as ReturnType<typeof fakeParent>)
        : undefined,
    pageBase: () => ({ ...BASE, os: o.os ?? "macos" }),
    workArea: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    log: vi.fn(),
  });
  /** Moves the clock and runs the timers that came due. */
  const advance = (ms: number) => {
    clock += ms;
    for (const t of timers) {
      if (t.live && t.at <= clock) {
        t.live = false;
        t.fn();
      }
    }
  };
  const top = { origin: LOCAL_ORIGIN, parent: null };
  const act = (w: FakeWindow, action: string, args: Record<string, unknown>, sender?: unknown) =>
    pages.handleAct({ sender: sender ?? w.webContents, senderFrame: top }, { action, args });
  /** Loads, reports the height (which shows the window) and lets the lockout pass. */
  const ready = async (w: FakeWindow) => {
    w.emit("ready-to-show");
    await act(w, "dialog.resize", { height: 200 });
    advance(CONFIRM_LOCKOUT_MS);
  };
  return { dialogs, pages, windows, advance, act, ready, top };
}

describe("the shell dialog window (spec 7.4)", () => {
  test("a sheet of a live parent: frameless, 400 wide, local partition, shown with its height", async () => {
    const s = setup();
    const parent = fakeParent();
    const result = s.dialogs.show(parent, OPTIONS);
    const w = s.windows[0] as FakeWindow;
    expect(w.options).toMatchObject({
      width: 400,
      frame: false,
      show: false,
      parent,
      modal: true,
      alwaysOnTop: false,
      resizable: false,
      minimizable: false,
      fullscreenable: false,
      webPreferences: {
        partition: "local",
        preload: "/dist/preload/local.cjs",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    expect(w.loadURL).toHaveBeenCalledWith(localPageUrl("dialog"));
    expect(w.show).not.toHaveBeenCalled();
    // ready-to-show alone does not show it: the page has not reported its height yet.
    w.emit("ready-to-show");
    expect(w.show).not.toHaveBeenCalled();
    await s.act(w, "dialog.resize", { height: 220 });
    expect(w.setContentSize).toHaveBeenLastCalledWith(400, 220);
    expect(w.show).toHaveBeenCalledOnce();
    s.advance(CONFIRM_LOCKOUT_MS);
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: true });
    expect(await result).toEqual({ response: 1 });
    expect(w.close).toHaveBeenCalled();
    expect(s.dialogs.openCount()).toBe(0);
  });

  test("without a live parent: standalone, above other windows, centered on the work area", async () => {
    const s = setup();
    void s.dialogs.show(null, OPTIONS);
    const w = s.windows[0] as FakeWindow;
    expect(w.options.parent).toBeUndefined();
    expect(w.options.modal).toBe(false);
    expect(w.options.alwaysOnTop).toBe(true);
    await s.act(w, "dialog.resize", { height: 300 });
    expect(w.setContentSize).toHaveBeenLastCalledWith(400, 300);
    expect(w.setPosition).toHaveBeenLastCalledWith(500, 200);
  });

  test("the content comes from main: the page state is built from the options only", () => {
    const s = setup();
    void s.dialogs.show(null, {
      ...OPTIONS,
      platform: { name: "Acme", host: "acme.example.com", iconUrl: "https://evil.example/x.png" },
    });
    const w = s.windows[0] as FakeWindow;
    const state = s.pages.handleState({ sender: w.webContents, senderFrame: s.top });
    expect(state).toEqual({
      ...BASE,
      page: "dialog",
      // A remote icon URL is never passed on: the page shows the default icon.
      platform: { name: "Acme", host: "acme.example.com" },
      title: "退出 Acme？",
      detail: "Detail.",
      buttons: ["取消", "退出登录"],
      cancelId: 0,
      confirmId: 1,
      tone: "primary",
    });
  });

  test("a data: image icon is passed on", () => {
    const s = setup();
    const iconUrl = "data:image/png;base64,iVBORw0KGgo=";
    void s.dialogs.show(null, { ...OPTIONS, platform: { name: "A", host: "a", iconUrl } });
    const w = s.windows[0] as FakeWindow;
    const state = s.pages.handleState({ sender: w.webContents, senderFrame: s.top });
    expect(state?.platform).toEqual({ name: "A", host: "a", iconUrl });
  });

  test("a hidden or minimized parent: the dialog stands alone", () => {
    const s = setup();
    void s.dialogs.show(fakeParent({ visible: false }), OPTIONS);
    void s.dialogs.show(fakeParent({ minimized: true }), OPTIONS);
    for (const w of s.windows) {
      expect(w.options.parent).toBeUndefined();
      expect(w.options.modal).toBe(false);
      expect(w.options.alwaysOnTop).toBe(true);
    }
  });

  test("off macOS a parented dialog is centered on the parent, near its top", async () => {
    const s = setup({ os: "windows" });
    void s.dialogs.show(fakeParent(), OPTIONS);
    const w = s.windows[0] as FakeWindow;
    await s.act(w, "dialog.resize", { height: 200 });
    expect(w.setPosition).toHaveBeenLastCalledWith(100 + (1000 - 400) / 2, 50 + PARENT_TOP_OFFSET);
  });

  test("the height follows the page, clamped", async () => {
    const s = setup();
    void s.dialogs.show(fakeParent(), OPTIONS);
    const w = s.windows[0] as FakeWindow;
    await s.act(w, "dialog.resize", { height: 20 });
    expect(w.setContentSize).toHaveBeenLastCalledWith(400, DIALOG_MIN_HEIGHT);
    await s.act(w, "dialog.resize", { height: 3000 });
    expect(w.setContentSize).toHaveBeenLastCalledWith(400, DIALOG_MAX_HEIGHT);
    // A sheet is placed by its parent.
    expect(w.setPosition).not.toHaveBeenCalled();
  });
});

describe("answers", () => {
  test("the confirming button takes no answer in the first 500 ms after showing", async () => {
    const s = setup();
    const result = s.dialogs.show(null, OPTIONS);
    const w = s.windows[0] as FakeWindow;
    // Before the window shows at all.
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: false });
    w.emit("ready-to-show");
    await s.act(w, "dialog.resize", { height: 200 });
    s.advance(CONFIRM_LOCKOUT_MS - 1);
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: false });
    s.advance(1);
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: true });
    expect(await result).toEqual({ response: 1 });
  });

  test("the lockout starts when the window shows, not at ready-to-show", async () => {
    const s = setup();
    void s.dialogs.show(null, OPTIONS);
    const w = s.windows[0] as FakeWindow;
    w.emit("ready-to-show");
    s.advance(CONFIRM_LOCKOUT_MS + 100);
    // Still hidden (no height yet): refused although ready-to-show was long ago.
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: false });
    await s.act(w, "dialog.resize", { height: 200 });
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: false });
    s.advance(CONFIRM_LOCKOUT_MS);
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: true });
  });

  test("a page that never reports its height is shown 2 s after ready-to-show", async () => {
    const s = setup();
    void s.dialogs.show(null, OPTIONS);
    const w = s.windows[0] as FakeWindow;
    w.emit("ready-to-show");
    s.advance(SHOW_FALLBACK_MS - 1);
    expect(w.show).not.toHaveBeenCalled();
    s.advance(1);
    expect(w.show).toHaveBeenCalledOnce();
    s.advance(CONFIRM_LOCKOUT_MS - 1);
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: false });
    s.advance(1);
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: true });
  });

  test("the lockout starts again when the dialog regains focus or is restored", async () => {
    for (const event of ["focus", "restore", "show"]) {
      const s = setup();
      void s.dialogs.show(null, OPTIONS);
      const w = s.windows[0] as FakeWindow;
      await s.ready(w);
      s.advance(5_000);
      w.emit(event);
      expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: false });
      s.advance(CONFIRM_LOCKOUT_MS);
      expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: true });
    }
  });

  test("no button but cancel is taken while the dialog is not focused", async () => {
    const s = setup();
    const result = s.dialogs.show(null, OPTIONS);
    const w = s.windows[0] as FakeWindow;
    await s.ready(w);
    w.focused = false;
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: false });
    // Cancel is always taken.
    expect(await s.act(w, "dialog.answer", { index: 0 })).toEqual({ ok: true, value: true });
    expect(await result).toEqual({ response: 0 });
  });

  test("every button but cancel is locked, not only the confirming one", async () => {
    const s = setup();
    const result = s.dialogs.show(null, {
      ...OPTIONS,
      buttons: ["取消", "其他", "确认"],
      confirmId: 2,
    });
    const w = s.windows[0] as FakeWindow;
    w.emit("ready-to-show");
    await s.act(w, "dialog.resize", { height: 200 });
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: false });
    s.advance(CONFIRM_LOCKOUT_MS);
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: true, value: true });
    expect(await result).toEqual({ response: 1 });
  });

  test("cancel is taken at once", async () => {
    const s = setup();
    const result = s.dialogs.show(null, OPTIONS);
    const w = s.windows[0] as FakeWindow;
    w.emit("ready-to-show");
    expect(await s.act(w, "dialog.answer", { index: 0 })).toEqual({ ok: true, value: true });
    expect(await result).toEqual({ response: 0 });
  });

  test("an index past the buttons is dropped", async () => {
    const s = setup();
    const result = s.dialogs.show(null, OPTIONS);
    const w = s.windows[0] as FakeWindow;
    await s.ready(w);
    expect(await s.act(w, "dialog.answer", { index: 2 })).toEqual({ ok: true, value: false });
    expect(await s.act(w, "dialog.answer", { index: 1.5 })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await s.act(w, "dialog.answer", { index: -1 })).toEqual({ ok: false, error: "invalid" });
    expect(s.dialogs.openCount()).toBe(1);
    await s.act(w, "dialog.answer", { index: 0 });
    expect(await result).toEqual({ response: 0 });
  });

  test("the first answer wins", async () => {
    const s = setup();
    const result = s.dialogs.show(null, OPTIONS);
    const w = s.windows[0] as FakeWindow;
    await s.ready(w);
    await s.act(w, "dialog.answer", { index: 0 });
    // The page is gone from the registry: a later answer is refused.
    expect(await s.act(w, "dialog.answer", { index: 1 })).toEqual({ ok: false, error: "refused" });
    expect(await result).toEqual({ response: 0 });
  });

  test("a foreign sender is refused: another webContents, a sub-frame, another origin", async () => {
    const s = setup();
    void s.dialogs.show(null, OPTIONS);
    const w = s.windows[0] as FakeWindow;
    await s.ready(w);
    const stranger = { id: 9999, send: vi.fn() };
    expect(await s.act(w, "dialog.answer", { index: 1 }, stranger)).toEqual({
      ok: false,
      error: "refused",
    });
    expect(
      await s.pages.handleAct(
        { sender: w.webContents, senderFrame: { origin: LOCAL_ORIGIN, parent: {} } },
        { action: "dialog.answer", args: { index: 1 } },
      ),
    ).toEqual({ ok: false, error: "refused" });
    expect(
      await s.pages.handleAct(
        {
          sender: w.webContents,
          senderFrame: { origin: "https://acme.example.com", parent: null },
        },
        { action: "dialog.answer", args: { index: 1 } },
      ),
    ).toEqual({ ok: false, error: "refused" });
    expect(s.dialogs.openCount()).toBe(1);
  });

  test("one dialog's page cannot answer another dialog", async () => {
    const s = setup();
    const first = s.dialogs.show(null, OPTIONS);
    const second = s.dialogs.show(null, OPTIONS);
    const [a, b] = s.windows as [FakeWindow, FakeWindow];
    await s.ready(a);
    await s.ready(b);
    await s.act(b, "dialog.answer", { index: 1 });
    expect(await second).toEqual({ response: 1 });
    expect(s.dialogs.openCount()).toBe(1);
    await s.act(a, "dialog.answer", { index: 0 });
    expect(await first).toEqual({ response: 0 });
  });

  test("a non-dialog local page cannot send dialog actions", async () => {
    const s = setup();
    void s.dialogs.show(null, OPTIONS);
    const onboarding = { id: 4242, send: vi.fn() };
    s.pages.register(onboarding, { kind: "onboarding", state: () => ({ ...BASE, page: "x" }) });
    expect(
      await s.pages.handleAct(
        { sender: onboarding, senderFrame: s.top },
        { action: "dialog.answer", args: { index: 1 } },
      ),
    ).toEqual({ ok: false, error: "refused" });
  });
});

describe("cancel paths", () => {
  test("Escape answers cancelId, in main", async () => {
    const s = setup();
    const result = s.dialogs.show(null, { ...OPTIONS, buttons: ["a", "b", "c"], cancelId: 2 });
    const w = s.windows[0] as FakeWindow;
    w.webContents.emit("before-input-event", {}, { type: "keyUp", key: "Escape" });
    w.webContents.emit("before-input-event", {}, { type: "keyDown", key: "Enter" });
    expect(s.dialogs.openCount()).toBe(1);
    w.webContents.emit("before-input-event", {}, { type: "keyDown", key: "Escape" });
    expect(await result).toEqual({ response: 2 });
  });

  test("closing the window answers cancelId", async () => {
    const s = setup();
    const result = s.dialogs.show(null, OPTIONS);
    (s.windows[0] as FakeWindow).close();
    expect(await result).toEqual({ response: 0 });
  });

  test("the parent closing answers cancelId and closes the dialog", async () => {
    const s = setup();
    const parent = fakeParent();
    const result = s.dialogs.show(parent, OPTIONS);
    parent.emit("closed");
    expect(await result).toEqual({ response: 0 });
    expect((s.windows[0] as FakeWindow).close).toHaveBeenCalled();
  });

  test("the parent listener goes once the dialog is answered", async () => {
    const s = setup();
    const parent = fakeParent();
    const result = s.dialogs.show(parent, OPTIONS);
    expect(parent.count("closed")).toBe(1);
    const w = s.windows[0] as FakeWindow;
    await s.ready(w);
    await s.act(w, "dialog.answer", { index: 0 });
    await result;
    expect(parent.count("closed")).toBe(0);
  });

  test("a page that fails to load answers cancelId", async () => {
    const s = setup({ loadFails: true });
    expect(await s.dialogs.show(null, OPTIONS)).toEqual({ response: 0 });
    expect(s.windows[0]?.close).toHaveBeenCalled();
  });

  test("a crashed, hung or failed page answers cancelId", async () => {
    const cases: Array<(w: FakeWindow) => void> = [
      (w) => w.webContents.emit("render-process-gone", {}, { reason: "crashed" }),
      (w) => w.emit("unresponsive"),
      (w) => w.webContents.emit("did-fail-load", {}, -2, "ERR_FAILED", "app://local/x", true),
    ];
    for (const trigger of cases) {
      const s = setup();
      const result = s.dialogs.show(null, OPTIONS);
      const w = s.windows[0] as FakeWindow;
      trigger(w);
      expect(await result).toEqual({ response: 0 });
      expect(w.close).toHaveBeenCalled();
    }
  });

  test("a sub-frame failing to load does not cancel", () => {
    const s = setup();
    void s.dialogs.show(null, OPTIONS);
    const w = s.windows[0] as FakeWindow;
    w.webContents.emit("did-fail-load", {}, -2, "ERR_FAILED", "app://local/x", false);
    expect(s.dialogs.openCount()).toBe(1);
  });

  test("a dialog that never shows is cancelled after the show timeout", async () => {
    const s = setup();
    const result = s.dialogs.show(null, OPTIONS);
    s.advance(SHOW_TIMEOUT_MS - 1);
    expect(s.dialogs.openCount()).toBe(1);
    s.advance(1);
    expect(await result).toEqual({ response: 0 });
  });

  test("a shown dialog is not cancelled by the show timeout", async () => {
    const s = setup();
    void s.dialogs.show(null, OPTIONS);
    await s.ready(s.windows[0] as FakeWindow);
    s.advance(SHOW_TIMEOUT_MS * 2);
    expect(s.dialogs.openCount()).toBe(1);
  });

  test("a second dialog for the same parent is refused with its cancelId", async () => {
    const s = setup();
    const parent = fakeParent();
    const first = s.dialogs.show(parent, OPTIONS);
    expect(await s.dialogs.show(parent, { ...OPTIONS, cancelId: 0 })).toEqual({ response: 0 });
    expect(s.windows).toHaveLength(1);
    // After the first is answered, the parent can show another.
    (s.windows[0] as FakeWindow).close();
    await first;
    void s.dialogs.show(parent, OPTIONS);
    expect(s.windows).toHaveLength(2);
  });
});

describe("options", () => {
  test("indices must name buttons; the confirming button is not the cancel button", () => {
    expect(() => checkOptions(OPTIONS)).not.toThrow();
    expect(() => checkOptions({ ...OPTIONS, buttons: [] })).toThrow();
    expect(() => checkOptions({ ...OPTIONS, cancelId: 2 })).toThrow();
    expect(() => checkOptions({ ...OPTIONS, defaultId: -1 })).toThrow();
    expect(() => checkOptions({ ...OPTIONS, confirmId: 2 })).toThrow();
    expect(() => checkOptions({ ...OPTIONS, confirmId: 0 })).toThrow();
    expect(() => checkOptions({ ...OPTIONS, buttons: Array(17).fill("x") })).toThrow();
  });

  test("platform names lose control and bidi characters and are capped at 64", () => {
    expect(cleanPlatformName("Acme\u202E moc.live\u202C")).toBe("Acme moc.live");
    expect(cleanPlatformName("A\u0000B\nC\u200BD\u2066E\u2069")).toBe("AB CDE");
    const long = "名".repeat(80);
    const clean = cleanPlatformName(long);
    expect([...clean]).toHaveLength(64);
    expect(clean.endsWith("…")).toBe(true);
    expect(cleanPlatformName("Meta1 智能体平台")).toBe("Meta1 智能体平台");
  });

  test("the dialog's platform and the sign-out title use the cleaned name", () => {
    const s = setup();
    void s.dialogs.show(null, { ...OPTIONS, platform: { name: "Ev\u202Eil", host: "h" } });
    const w = s.windows[0] as FakeWindow;
    expect(s.pages.handleState({ sender: w.webContents, senderFrame: s.top })?.platform).toEqual({
      name: "Evil",
      host: "h",
    });
    expect(signOutDialogOptions("zh", { name: "Ev\u202Eil", host: "h" }).title).toBe("退出 Evil？");
  });

  test("the sign-out dialog: board SignOut copy, cancel first, primary tone", () => {
    const platform = { name: "Meta1 智能体平台", host: "meta1.top" };
    expect(signOutDialogOptions("zh", platform)).toEqual({
      title: "退出 Meta1 智能体平台？",
      detail: "这台电脑作为设备会继续保持连接，进行中的任务不受影响。要断开设备，请在设备页操作。",
      buttons: ["取消", "退出登录"],
      defaultId: 0,
      cancelId: 0,
      confirmId: 1,
      tone: "primary",
      platform,
    });
    expect(signOutDialogOptions("en", platform).title).toBe("Sign out of Meta1 智能体平台?");
  });

  test("confirmSignOut is true only for 退出登录", async () => {
    const s = setup();
    const parent = fakeParent();
    const yes = s.dialogs.confirmSignOut(parent, { name: "Acme", host: "acme.example.com" });
    const w = s.windows[0] as FakeWindow;
    const state = s.pages.handleState({ sender: w.webContents, senderFrame: s.top });
    expect(state?.title).toBe("退出 Acme？");
    await s.ready(w);
    await s.act(w, "dialog.answer", { index: 1 });
    expect(await yes).toBe(true);

    const no = s.dialogs.confirmSignOut(parent, { name: "Acme", host: "acme.example.com" });
    (s.windows[1] as FakeWindow).close();
    expect(await no).toBe(false);
  });
});

describe("the dialog page model", () => {
  test("the confirming button takes the tone, the others are secondary, focus on cancel", () => {
    const state = {
      ...BASE,
      page: "dialog",
      title: "t",
      detail: "d",
      buttons: ["否", "是"],
      cancelId: 0,
      confirmId: 1,
      tone: "danger" as const,
    };
    expect(dialogButtons(state)).toEqual([
      { index: 0, label: "否", variant: "secondary", focus: true },
      { index: 1, label: "是", variant: "danger", focus: false },
    ]);
    expect(dialogButtons({ ...state, tone: "primary" })[1]?.variant).toBe("primary");
  });

  test("the natural height counts the whole detail", () => {
    expect(naturalHeight(200, 60, 60)).toBe(200);
    expect(naturalHeight(560, 300, 700.4)).toBe(961);
  });
});

describe("no OS message box is left", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith(".ts") ? [path] : [];
    });
  }

  test("src/ never calls showMessageBox nor imports electron's dialog", () => {
    const root = join(import.meta.dirname, "..", "src");
    const offenders: string[] = [];
    for (const file of sources(root)) {
      const text = readFileSync(file, "utf8");
      if (/showMessageBox|showErrorBox|showMessageBoxSync/.test(text)) offenders.push(file);
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']electron["']/g)) {
        if (/\bdialog\b/.test(m[1] ?? "")) offenders.push(file);
      }
      if (/\bdialog\.show\w*\(/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
