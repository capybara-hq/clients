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
    { id: "p1", name: "Example" },
    { id: "p2", name: "Other" },
  ],
  activeId: "p2",
  lockDeployments: false,
};

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

  test("the active profile is checked and a click shows that profile", () => {
    const a = actions();
    const items = trayMenuModel(state, a);
    expect(items.map((i) => i.checked)).toEqual([
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    items[0]?.click?.({ checked: false });
    expect(a.showProfile).toHaveBeenCalledWith("p1");
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
          { ...state, lockDeployments: true, productName: "Capybara", startAtLogin: false },
          { ...a, setStartAtLogin: vi.fn() },
        )[1]?.submenu ?? [],
      ),
    ).toEqual(["Example", "Other"]);
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
    const item = login(
      appMenuTemplate(menuState(startAtLogin.enabled()), {
        ...actions(),
        setStartAtLogin: vi.fn(),
      }),
    );
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
        ...actions(),
        setStartAtLogin: (on) => startAtLogin.set(on),
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
    const template = appMenuTemplate(menuState(false), { ...actions(), setStartAtLogin: vi.fn() });
    expect(template.map((i) => i.label)).toEqual(["Capybara", "平台", "编辑", "显示", "窗口"]);
    expect(labels(template[1]?.submenu ?? [])).toEqual(["Example", "Other", "-", "添加平台"]);
  });

  // Electron hard-codes English labels for bare roles (spec §12): every item carries a catalog
  // label and keeps its role, so the behaviour and the accelerators stay Electron's.
  const roleItems = (items: MenuItemModel[]): [string | undefined, string | undefined][] =>
    items.flatMap((i) =>
      i.submenu ? roleItems(i.submenu) : i.role ? [[i.role, i.label] as [string, string]] : [],
    );

  test("every role item has a Chinese label", () => {
    const template = appMenuTemplate(menuState(false), { ...actions(), setStartAtLogin: vi.fn() });
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
    const template = appMenuTemplate(
      { ...menuState(false), locale: "en" },
      { ...actions(), setStartAtLogin: vi.fn() },
    );
    expect(template.map((i) => i.label)).toEqual([
      "Capybara",
      "Platforms",
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
      walk(
        appMenuTemplate(
          { ...menuState(false), locale },
          { ...actions(), setStartAtLogin: vi.fn() },
        ),
      );
    }
  });

  test("with lockDeployments the app menu offers no 添加平台", () => {
    const template = appMenuTemplate(
      { ...menuState(false), lockDeployments: true },
      { ...actions(), setStartAtLogin: vi.fn() },
    );
    expect(labels(template[1]?.submenu ?? [])).toEqual(["Example", "Other"]);
  });
});

describe("the tray's device state (spec 9.6)", () => {
  const deviceActions = () => ({
    pause: vi.fn(),
    resume: vi.fn(),
    disconnect: vi.fn(),
    setKeepAwake: vi.fn(),
    openDevicePage: vi.fn(),
  });
  const withDevice = (device: TrayDevice, locale: "zh" | "en" = "zh") => ({
    ...state,
    locale,
    device,
  });
  const online: TrayDevice = {
    icon: "online",
    running: 0,
    keepAwake: "while-busy",
    profileId: "p1",
    deviceId: "dev_1",
  };
  const a = (d = deviceActions()) => ({ ...actions(), device: d });
  const section = (items: MenuItemModel[]) => {
    const i = items.findIndex((x) => x.label === "本机");
    return items.slice(0, i + 1);
  };

  test("not connected: no device entries at all", () => {
    expect(
      labels(
        trayMenuModel(withDevice({ icon: "not_connected", running: 0, keepAwake: "off" }), a()),
      ),
    ).toEqual(labels(trayMenuModel(state, actions())));
  });

  test("online: status, running count, 暂停, 断开, keep-awake, 本机", () => {
    const items = trayMenuModel(withDevice(online), a());
    expect(labels(items)).toEqual([
      "Example",
      "Other",
      "-",
      "添加平台",
      "-",
      "本机：在线",
      "运行中：0",
      "暂停",
      "断开",
      "保持唤醒",
      "本机",
      "-",
      "打开窗口",
      "-",
      "退出",
    ]);
    expect(section(items)).toHaveLength(11);
  });

  test("paused: 恢复 instead of 暂停", () => {
    const l = labels(trayMenuModel(withDevice({ ...online, icon: "paused" }), a()));
    expect(l).toContain("本机：已暂停");
    expect(l).toContain("恢复");
    expect(l).not.toContain("暂停");
    expect(l).toContain("断开");
  });

  test("busy shows the running count; offline says offline", () => {
    expect(labels(trayMenuModel(withDevice({ ...online, icon: "busy", running: 3 }), a()))).toEqual(
      expect.arrayContaining(["本机：在线", "运行中：3", "暂停"]),
    );
    expect(labels(trayMenuModel(withDevice({ ...online, icon: "offline" }), a()))).toEqual(
      expect.arrayContaining(["本机：离线", "暂停"]),
    );
  });

  test("the entries call the device actions with the profile", () => {
    const d = deviceActions();
    const items = trayMenuModel(withDevice(online), a(d));
    const click = (label: string) =>
      items.find((i) => i.label === label)?.click?.({ checked: false });
    click("暂停");
    click("断开");
    click("本机");
    expect(d.pause).toHaveBeenCalledWith("p1");
    expect(d.disconnect).toHaveBeenCalledWith("p1");
    expect(d.openDevicePage).toHaveBeenCalledWith("p1", "dev_1");
    const paused = trayMenuModel(withDevice({ ...online, icon: "paused" }), a(d));
    paused.find((i) => i.label === "恢复")?.click?.({ checked: false });
    expect(d.resume).toHaveBeenCalledWith("p1");
  });

  test("keep-awake is a radio submenu with the current mode checked", () => {
    const d = deviceActions();
    const items = trayMenuModel(withDevice({ ...online, keepAwake: "connected" }), a(d));
    const sub = items.find((i) => i.label === "保持唤醒")?.submenu ?? [];
    expect(sub.map((i) => [i.label, i.type, i.checked])).toEqual([
      ["关闭", "radio", false],
      ["运行任务时", "radio", false],
      ["连接期间", "radio", true],
    ]);
    sub[1]?.click?.({ checked: true });
    expect(d.setKeepAwake).toHaveBeenCalledWith("p1", "while-busy");
  });

  test("a deployment that is not a saved profile: the state shows, the actions are disabled", () => {
    const { profileId: _p, ...unknown } = online;
    const items = trayMenuModel(withDevice(unknown), a());
    for (const label of ["暂停", "断开", "保持唤醒", "本机"]) {
      expect(items.find((i) => i.label === label)?.enabled).toBe(false);
    }
    expect(labels(items)).toContain("本机：在线");
  });

  test("English text comes from the catalog", () => {
    expect(
      labels(trayMenuModel(withDevice({ ...online, icon: "busy", running: 2 }, "en"), a())),
    ).toEqual(
      expect.arrayContaining([
        "This computer: online",
        "Running: 2",
        "Pause",
        "Disconnect",
        "Keep awake",
        "This computer",
      ]),
    );
  });

  test("quit stays the last entry and calls only quit", () => {
    const x = a();
    const items = trayMenuModel(withDevice(online), x);
    items.at(-1)?.click?.({ checked: false });
    expect(x.quit).toHaveBeenCalledTimes(1);
    expect(x.device.pause).not.toHaveBeenCalled();
    expect(x.device.disconnect).not.toHaveBeenCalled();
  });
});

describe("the tray icon follows the device state", () => {
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
  const dev = (icon: TrayDevice["icon"], running = 0): TrayDevice => ({
    icon,
    running,
    keepAwake: "off",
  });

  test.each([
    ["not_connected", 0, "Capybara", ""],
    ["online", 0, "Capybara · 本机：在线", ""],
    ["offline", 0, "Capybara · 本机：离线", "!"],
    ["paused", 0, "Capybara · 本机：已暂停", "⏸"],
    ["busy", 2, "Capybara · 本机：在线 · 运行中：2", "2"],
  ] as const)("%s: tooltip %s, title suffix %s", (icon, running, tooltip, title) => {
    const { tray, controller } = setup();
    controller.update({ ...state, device: dev(icon, running) });
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
    controller.update({ ...state, device: dev("paused") });
    expect(tray.setTitle).toHaveBeenLastCalledWith("Capybara ⏸");
  });
});
