import { describe, expect, test, vi } from "vitest";
import { appMenuTemplate, createStartAtLogin, type LoginItemApp } from "../src/main/app-menu.ts";
import {
  createTrayController,
  type MenuItemModel,
  platformItems,
  type TrayActions,
  type TrayDevice,
  type TrayLike,
  trayMenuModel,
  worstIcon,
} from "../src/main/tray.ts";

const actions = (): TrayActions => ({
  showProfile: vi.fn(),
  addPlatform: vi.fn(),
  openWindow: vi.fn(),
  quit: vi.fn(),
});

const state = {
  locale: "zh" as const,
  profiles: [
    { id: "p1", name: "Example", open: false },
    { id: "p2", name: "Other", open: false },
  ],
  // The app menu's current profile (退出登录 / 移除); the tray shows no current one.
  activeId: "p2",
  lockDeployments: false,
};

/** The app menu's actions (the 「平台」 menu adds sign-out and removal). */
const menuActions = () => ({
  ...actions(),
  signOut: vi.fn(),
  removeProfile: vi.fn(),
  setStartAtLogin: vi.fn(),
});
const menuProfiles = state.profiles.map((p) => ({ ...p, signedIn: true }));

const labels = (items: MenuItemModel[]) =>
  items.map((i) => (i.type === "separator" ? "-" : (i.label ?? i.role)));

describe("the tray menu model", () => {
  test("profiles, 添加平台, open window, quit", () => {
    expect(labels(trayMenuModel(state, actions()))).toEqual([
      "Example",
      "Other",
      "-",
      "添加平台",
      "-",
      "打开窗口",
      "-",
      "退出",
    ]);
  });

  test("no platform is checked; an open one is marked in its label; a click shows it", () => {
    const a = actions();
    const open = {
      ...state,
      profiles: [
        { id: "p1", name: "Example", open: true },
        { id: "p2", name: "Other", open: false },
      ],
    };
    const items = trayMenuModel(open, a);
    // Several platforms can be open at once: no radio, no check (the last used one included).
    expect(items.some((i) => i.type === "radio" || i.checked !== undefined)).toBe(false);
    expect(labels(items).slice(0, 2)).toEqual(["Example • 已打开", "Other"]);
    expect(labels(trayMenuModel({ ...open, locale: "en" }, a)).slice(0, 2)).toEqual([
      "Example • Open",
      "Other",
    ]);
    items[0]?.click?.({ checked: false });
    items[1]?.click?.({ checked: false });
    expect(vi.mocked(a.showProfile).mock.calls).toEqual([["p1"], ["p2"]]);
    // 移除平台 lists the plain names.
    const remove = platformItems(open, { ...a, removeProfile: vi.fn() }).at(-1);
    expect(labels(remove?.submenu ?? [])).toEqual(["Example…", "Other…"]);
  });

  test("the actions are wired to their entries", () => {
    const a = actions();
    const items = trayMenuModel(state, a);
    items.find((i) => i.label === "添加平台")?.click?.({ checked: false });
    items.find((i) => i.label === "打开窗口")?.click?.({ checked: false });
    items.find((i) => i.label === "退出")?.click?.({ checked: false });
    expect(a.addPlatform).toHaveBeenCalledTimes(1);
    expect(a.openWindow).toHaveBeenCalledTimes(1);
    expect(a.quit).toHaveBeenCalledTimes(1);
  });

  test("with lockDeployments 添加平台 is hidden", () => {
    const locked = { ...state, lockDeployments: true };
    expect(labels(trayMenuModel(locked, actions()))).toEqual([
      "Example",
      "Other",
      "-",
      "打开窗口",
      "-",
      "退出",
    ]);
    expect(labels(platformItems(locked, actions()))).toEqual(["Example", "Other"]);
  });

  test("移除平台 lists each platform; a click removes that one (spec 6.3)", () => {
    const a = { ...actions(), removeProfile: vi.fn() };
    const items = platformItems(state, a);
    expect(labels(items)).toEqual(["Example", "Other", "-", "添加平台", "移除平台"]);
    const sub = items.at(-1)?.submenu ?? [];
    expect(labels(sub)).toEqual(["Example…", "Other…"]);
    sub[1]?.click?.({ checked: false });
    expect(a.removeProfile).toHaveBeenCalledExactlyOnceWith("p2");
    expect(a.showProfile).not.toHaveBeenCalled();
    // The tray carries the same entries.
    expect(labels(trayMenuModel(state, a))).toContain("移除平台");
    expect(labels(platformItems({ ...state, locale: "en" }, a)).at(-1)).toBe("Remove platform");
  });

  test("with lockDeployments or without profiles there is no 移除平台", () => {
    const a = { ...actions(), removeProfile: vi.fn() };
    expect(labels(platformItems({ ...state, lockDeployments: true }, a))).toEqual([
      "Example",
      "Other",
    ]);
    expect(labels(platformItems({ ...state, profiles: [] }, a))).toEqual(["添加平台"]);
    expect(
      labels(
        appMenuTemplate(
          {
            ...state,
            profiles: menuProfiles,
            lockDeployments: true,
            productName: "Capybara",
            startAtLogin: false,
          },
          menuActions(),
        )[1]?.submenu ?? [],
      ),
    ).toEqual(["Example", "Other", "-", "退出登录 Other…"]);
  });

  test("without profiles the menu starts at the entries that remain", () => {
    expect(labels(trayMenuModel({ ...state, profiles: [] }, actions()))).toEqual([
      "添加平台",
      "-",
      "打开窗口",
      "-",
      "退出",
    ]);
    expect(
      labels(trayMenuModel({ ...state, profiles: [], lockDeployments: true }, actions())),
    ).toEqual(["打开窗口", "-", "退出"]);
  });

  test("English text comes from the catalog", () => {
    expect(labels(trayMenuModel({ ...state, locale: "en" }, actions()))).toEqual([
      "Example",
      "Other",
      "-",
      "Add a platform",
      "-",
      "Open window",
      "-",
      "Quit",
    ]);
  });
});

describe("the tray controller", () => {
  function setup() {
    const tray: TrayLike & { menus: unknown[] } = {
      menus: [],
      setToolTip: vi.fn(),
      setContextMenu(m) {
        this.menus.push(m);
      },
      setTitle: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn(),
    };
    const createTray = vi.fn(() => tray);
    const buildMenu = vi.fn((template: MenuItemModel[]) => ({ template }));
    const a = actions();
    const controller = createTrayController({
      createTray,
      buildMenu,
      tooltip: "Capybara",
      actions: a,
    });
    return { controller, tray, createTray, buildMenu, a };
  }

  test("an update after a window opened marks that platform in the rebuilt menu", () => {
    const { controller, buildMenu } = setup();
    controller.update(state);
    controller.update({ ...state, profiles: [{ id: "p1", name: "Example", open: true }] });
    const last = buildMenu.mock.calls.at(-1)?.[0] ?? [];
    expect(labels(last)[0]).toBe("Example • 已打开");
  });

  test("creates the tray once and rebuilds the menu on every update", () => {
    const { controller, tray, createTray, buildMenu } = setup();
    expect(controller.exists()).toBe(false);
    controller.update(state);
    controller.update({ ...state, profiles: [] });
    expect(createTray).toHaveBeenCalledTimes(1);
    expect(tray.setToolTip).toHaveBeenCalledWith("Capybara");
    expect(buildMenu).toHaveBeenCalledTimes(2);
    expect(tray.menus).toHaveLength(2);
  });

  test("a click on the tray icon opens the window; destroy removes it", () => {
    const { controller, tray, a } = setup();
    controller.update(state);
    const click = vi.mocked(tray.on).mock.calls[0]?.[1];
    click?.();
    expect(a.openWindow).toHaveBeenCalledTimes(1);
    controller.destroy();
    expect(tray.destroy).toHaveBeenCalledTimes(1);
    expect(controller.exists()).toBe(false);
  });
});

describe("start at login (spec 9.4)", () => {
  function fakeApp(openAtLogin = false) {
    return {
      getLoginItemSettings: vi.fn(() => ({ openAtLogin })),
      setLoginItemSettings: vi.fn(),
    } satisfies LoginItemApp;
  }

  const menuState = (startAtLogin: boolean) => ({
    ...state,
    profiles: menuProfiles,
    productName: "Capybara",
    startAtLogin,
  });
  const login = (template: MenuItemModel[]) =>
    template[0]?.submenu?.find((i) => i.label === "登录时启动");

  test("off by default, and creating it changes nothing", () => {
    const app = fakeApp();
    const startAtLogin = createStartAtLogin(app);
    expect(startAtLogin.enabled()).toBe(false);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    const item = login(appMenuTemplate(menuState(startAtLogin.enabled()), menuActions()));
    expect(item).toMatchObject({ type: "checkbox", checked: false });
  });

  test("the item reflects what the OS reports", () => {
    expect(createStartAtLogin(fakeApp(true)).enabled()).toBe(true);
  });

  test("toggling the item calls setLoginItemSettings", () => {
    const app = fakeApp();
    const startAtLogin = createStartAtLogin(app);
    const item = login(
      appMenuTemplate(menuState(false), {
        ...menuActions(),
        setStartAtLogin: (on: boolean) => startAtLogin.set(on),
      }),
    );
    item?.click?.({ checked: true });
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true });
    item?.click?.({ checked: false });
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
  });

  test("an OS that cannot say reads as off", () => {
    const app = fakeApp();
    app.getLoginItemSettings.mockImplementation(() => {
      throw new Error("unsupported");
    });
    expect(createStartAtLogin(app).enabled()).toBe(false);
  });

  test("the app menu carries the platform switcher and the standard menus", () => {
    const template = appMenuTemplate(menuState(false), menuActions());
    expect(template.map((i) => i.label)).toEqual(["Capybara", "平台", "编辑", "显示", "窗口"]);
    expect(labels(template[1]?.submenu ?? [])).toEqual([
      "Example",
      "Other",
      "-",
      "添加平台…",
      "退出登录 Other…",
      "移除这个平台…",
    ]);
  });

  // Electron hard-codes English labels for bare roles (spec §12): every item carries a catalog
  // label and keeps its role, so the behaviour and the accelerators stay Electron's.
  const roleItems = (items: MenuItemModel[]): [string | undefined, string | undefined][] =>
    items.flatMap((i) =>
      i.submenu ? roleItems(i.submenu) : i.role ? [[i.role, i.label] as [string, string]] : [],
    );

  test("every role item has a Chinese label", () => {
    const template = appMenuTemplate(menuState(false), menuActions());
    expect(roleItems(template)).toEqual([
      ["about", "关于 Capybara"],
      ["hide", "隐藏 Capybara"],
      ["hideOthers", "隐藏其他"],
      ["unhide", "全部显示"],
      ["quit", "退出 Capybara"],
      ["undo", "撤销"],
      ["redo", "重做"],
      ["cut", "剪切"],
      ["copy", "拷贝"],
      ["paste", "粘贴"],
      ["pasteAndMatchStyle", "粘贴并匹配样式"],
      ["delete", "删除"],
      ["selectAll", "全选"],
      ["reload", "重新载入"],
      ["forceReload", "强制重新载入"],
      ["toggleDevTools", "开发者工具"],
      ["resetZoom", "实际大小"],
      ["zoomIn", "放大"],
      ["zoomOut", "缩小"],
      ["togglefullscreen", "切换全屏幕"],
      ["minimize", "最小化"],
      ["zoom", "缩放"],
      ["front", "前置全部窗口"],
    ]);
    // The Window menu is the macOS window menu (its window list), labelled.
    expect(template[4]).toMatchObject({ label: "窗口", role: "window" });
  });

  test("every role item has an English label", () => {
    const template = appMenuTemplate({ ...menuState(false), locale: "en" }, menuActions());
    expect(template.map((i) => i.label)).toEqual([
      "Capybara",
      "Platform",
      "Edit",
      "View",
      "Window",
    ]);
    expect(roleItems(template).map(([, label]) => label)).toEqual([
      "About Capybara",
      "Hide Capybara",
      "Hide Others",
      "Show All",
      "Quit Capybara",
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
      "Paste and Match Style",
      "Delete",
      "Select All",
      "Reload",
      "Force Reload",
      "Toggle Developer Tools",
      "Actual Size",
      "Zoom In",
      "Zoom Out",
      "Toggle Full Screen",
      "Minimize",
      "Zoom",
      "Bring All to Front",
    ]);
    expect(template[0]?.submenu?.find((i) => i.type === "checkbox")?.label).toBe("Start at login");
  });

  test("no menu item is left without a label", () => {
    for (const locale of ["zh", "en"] as const) {
      const walk = (items: MenuItemModel[]): void => {
        for (const i of items) {
          if (i.type === "separator") continue;
          expect(i.label, JSON.stringify(i)).toBeTruthy();
          expect(i.label).not.toMatch(/^menu\./);
          if (i.submenu) walk(i.submenu);
        }
      };
      walk(appMenuTemplate({ ...menuState(false), locale }, menuActions()));
    }
  });

  test("with lockDeployments the app menu offers no 添加平台", () => {
    const template = appMenuTemplate({ ...menuState(false), lockDeployments: true }, menuActions());
    expect(labels(template[1]?.submenu ?? [])).toEqual([
      "Example",
      "Other",
      "-",
      "退出登录 Other…",
    ]);
  });
});

const device = (over: Partial<TrayDevice> = {}): TrayDevice => ({
  deviceId: "dev_1",
  host: "a.example.com",
  orgLabel: "Acme",
  icon: "online",
  running: 0,
  keepAwake: "while-busy",
  profileId: "p1",
  ...over,
});

describe("worstIcon", () => {
  const d = (icon: TrayDevice["icon"]) => device({ icon });
  test("offline over busy over paused over online; none: not connected", () => {
    expect(worstIcon([d("online"), d("busy")])).toBe("busy");
    expect(worstIcon([d("busy"), d("offline")])).toBe("offline");
    expect(worstIcon([d("online"), d("paused")])).toBe("paused");
    expect(worstIcon([d("busy"), d("paused")])).toBe("busy");
    expect(worstIcon([d("online")])).toBe("online");
    expect(worstIcon([])).toBe("not_connected");
  });
});

describe("the tray's device rows (spec 9.6)", () => {
  const deviceActions = () => ({
    pause: vi.fn(),
    resume: vi.fn(),
    disconnect: vi.fn(),
    setKeepAwake: vi.fn(),
    openDevicePage: vi.fn(),
  });
  const withDevices = (devices: TrayDevice[], locale: "zh" | "en" = "zh") => ({
    ...state,
    locale,
    devices,
  });
  const a = (d = deviceActions()) => ({ ...actions(), device: d });
  const rows = (items: MenuItemModel[]) =>
    items.filter((i) => i.submenu && i.label?.includes(" · "));
  const row = (items: MenuItemModel[], n = 0) => rows(items)[n];

  test("no connections: no device entries at all", () => {
    expect(labels(trayMenuModel(withDevices([]), a()))).toEqual(
      labels(trayMenuModel(state, actions())),
    );
  });

  test("one row per connection: host · org · state, each with its own submenu", () => {
    const items = trayMenuModel(
      withDevices([
        device(),
        device({ deviceId: "dev_2", host: "b.example.com", orgLabel: "Beta", icon: "paused" }),
      ]),
      a(),
    );
    expect(labels(items)).toEqual([
      "Example",
      "Other",
      "-",
      "添加平台",
      "-",
      "a.example.com · Acme · 在线",
      "b.example.com · Beta · 已暂停",
      "-",
      "打开窗口",
      "-",
      "退出",
    ]);
    expect(labels(row(items, 0)?.submenu ?? [])).toEqual([
      "本机：在线",
      "运行中：0",
      "暂停",
      "断开",
      "保持唤醒",
      "本机",
    ]);
    expect(labels(row(items, 1)?.submenu ?? [])).toEqual([
      "本机：已暂停",
      "运行中：0",
      "恢复",
      "断开",
      "保持唤醒",
      "本机",
    ]);
  });

  test("busy shows the running count; offline says offline", () => {
    const busy = row(trayMenuModel(withDevices([device({ icon: "busy", running: 3 })]), a()));
    expect(labels(busy?.submenu ?? [])).toEqual(
      expect.arrayContaining(["本机：在线", "运行中：3", "暂停"]),
    );
    const off = row(trayMenuModel(withDevices([device({ icon: "offline" })]), a()));
    expect(off?.label).toBe("a.example.com · Acme · 离线");
  });

  test("an action on a row runs for that connection only", () => {
    const d = deviceActions();
    const items = trayMenuModel(
      withDevices([device(), device({ deviceId: "dev_a2", profileId: "p2", icon: "paused" })]),
      a(d),
    );
    const click = (n: number, label: string) =>
      row(items, n)
        ?.submenu?.find((i) => i.label === label)
        ?.click?.({ checked: false });
    click(0, "暂停");
    click(0, "断开");
    click(0, "本机");
    expect(d.pause).toHaveBeenCalledWith("p1", "dev_1");
    expect(d.disconnect).toHaveBeenCalledWith("p1", "dev_1");
    expect(d.openDevicePage).toHaveBeenCalledWith("p1", "dev_1");
    click(1, "恢复");
    expect(d.resume).toHaveBeenCalledWith("p2", "dev_a2");
    expect(d.resume).toHaveBeenCalledTimes(1);
    expect(d.pause).toHaveBeenCalledTimes(1);
  });

  test("keep-awake is a radio submenu per row with the current mode checked", () => {
    const d = deviceActions();
    const items = trayMenuModel(withDevices([device({ keepAwake: "connected" })]), a(d));
    const sub = row(items)?.submenu?.find((i) => i.label === "保持唤醒")?.submenu ?? [];
    expect(sub.map((i) => [i.label, i.type, i.checked])).toEqual([
      ["关闭", "radio", false],
      ["运行任务时", "radio", false],
      ["连接期间", "radio", true],
    ]);
    sub[1]?.click?.({ checked: true });
    expect(d.setKeepAwake).toHaveBeenCalledWith("p1", "dev_1", "while-busy");
  });

  test("a connection to a deployment without a saved profile shows its row without actions", () => {
    const items = trayMenuModel(withDevices([device({ profileId: undefined })]), a());
    const sub = row(items)?.submenu ?? [];
    for (const label of ["暂停", "断开", "保持唤醒", "本机"]) {
      expect(sub.find((i) => i.label === label)?.enabled).toBe(false);
    }
    expect(row(items)?.label).toBe("a.example.com · Acme · 在线");
  });

  test("English text comes from the catalog", () => {
    const items = trayMenuModel(withDevices([device({ icon: "busy", running: 2 })], "en"), a());
    expect(row(items)?.label).toBe("a.example.com · Acme · online");
    expect(labels(row(items)?.submenu ?? [])).toEqual(
      expect.arrayContaining(["Running: 2", "Pause", "Disconnect", "Keep awake", "This computer"]),
    );
  });

  test("quit stays the last entry and calls only quit", () => {
    const x = a();
    const items = trayMenuModel(withDevices([device()]), x);
    items.at(-1)?.click?.({ checked: false });
    expect(x.quit).toHaveBeenCalledTimes(1);
    expect(x.device.pause).not.toHaveBeenCalled();
    expect(x.device.disconnect).not.toHaveBeenCalled();
  });
});

describe("the tray icon follows the worst connection", () => {
  function setup() {
    const tray: TrayLike = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      setTitle: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn(),
    };
    const controller = createTrayController({
      createTray: () => tray,
      buildMenu: (template) => ({ template }),
      tooltip: "Capybara",
      actions: actions(),
    });
    return { tray, controller };
  }
  const dev = (icon: TrayDevice["icon"], running = 0) => device({ icon, running });

  test.each([
    [[], "Capybara", ""],
    [[dev("online")], "Capybara · 本机：在线", ""],
    [[dev("offline")], "Capybara · 本机：离线", "!"],
    [[dev("paused")], "Capybara · 本机：已暂停", "⏸"],
    [[dev("busy", 2)], "Capybara · 本机：在线 · 运行中：2", "2"],
    [[dev("online"), dev("paused")], "Capybara · 本机：已暂停", "⏸"],
    [[dev("busy", 1), dev("online"), dev("busy", 2)], "Capybara · 本机：在线 · 运行中：3", "3"],
    [[dev("busy", 2), dev("offline"), dev("paused")], "Capybara · 本机：离线", "!"],
  ] as const)("%j: tooltip %s, title suffix %s", (devices, tooltip, title) => {
    const { tray, controller } = setup();
    controller.update({ ...state, devices: [...devices] });
    expect(tray.setToolTip).toHaveBeenLastCalledWith(tooltip);
    expect(tray.setTitle).toHaveBeenLastCalledWith(title);
  });

  test("the title keeps the fallback name and no device means the plain tooltip", () => {
    const tray: TrayLike = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      setTitle: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn(),
    };
    const controller = createTrayController({
      createTray: () => tray,
      buildMenu: (template) => ({ template }),
      tooltip: "Capybara",
      fallbackTitle: "Capybara",
      actions: actions(),
    });
    controller.update(state);
    expect(tray.setToolTip).toHaveBeenLastCalledWith("Capybara");
    expect(tray.setTitle).toHaveBeenLastCalledWith("Capybara");
    controller.update({ ...state, devices: [dev("paused")] });
    expect(tray.setTitle).toHaveBeenLastCalledWith("Capybara ⏸");
  });
});
