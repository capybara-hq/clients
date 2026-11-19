import { describe, expect, test, vi } from "vitest";
import { appMenuTemplate, createStartAtLogin, type LoginItemApp } from "../src/main/app-menu.ts";
import {
  createTrayController,
  type MenuItemModel,
  platformItems,
  type TrayActions,
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
    expect(template.map((i) => i.label ?? i.role)).toEqual([
      "Capybara",
      "平台",
      "editMenu",
      "viewMenu",
      "windowMenu",
    ]);
    expect(labels(template[1]?.submenu ?? [])).toEqual(["Example", "Other", "-", "添加平台"]);
  });

  test("with lockDeployments the app menu offers no 添加平台", () => {
    const template = appMenuTemplate(
      { ...menuState(false), lockDeployments: true },
      { ...actions(), setStartAtLogin: vi.fn() },
    );
    expect(labels(template[1]?.submenu ?? [])).toEqual(["Example", "Other"]);
  });
});
