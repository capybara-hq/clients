// The app menu (macOS): the app's own items, the 「平台」 menu (spec §6.9) and the standard
// edit, view and window menus, every item labelled from the shell catalog (zh, en). 「登录时启动」 is off by default (spec §9.4): it is checked only when
// the OS says the app is a login item, and toggling it calls `setLoginItemSettings`.
import { type Locale, t } from "@capybara-hq/shell";
import { type MenuItemModel, platformLabel, type TrayState } from "./tray.ts";

const SEPARATOR: MenuItemModel = { type: "separator" };

export interface LoginItemApp {
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

export function createStartAtLogin(app: LoginItemApp) {
  return {
    /** Off unless the OS reports the app as a login item. */
    enabled(): boolean {
      try {
        return app.getLoginItemSettings().openAtLogin === true;
      } catch {
        return false;
      }
    },
    set(on: boolean): void {
      app.setLoginItemSettings({ openAtLogin: on });
    },
  };
}

/** What the 「平台」 menu shows (spec §6.9). */
export interface PlatformMenuState {
  locale: Locale;
  /**
   * The offered profiles, in order (the first nine get ⌘1…⌘9); `open`: a main window of it is
   * open now.
   */
  profiles: { id: string; name: string; signedIn: boolean; open: boolean }[];
  /**
   * The current profile (the last used one): what 退出登录 and 移除 act on. Not shown as a check:
   * several platforms can be open at once.
   */
  activeId?: string | undefined;
  /** Managed `lockDeployments`: neither adding nor removing is offered. */
  lockDeployments: boolean;
}

export interface PlatformMenuActions {
  /** Shows the profile: its main window, else its signed-out or found page. */
  showProfile(id: string): void;
  addPlatform(): void;
  /** The shell dialog, then the logout (sign-out.ts `confirmAndSignOut`). */
  signOut(id: string): void;
  /** Asks, then removes the platform (remove-profile.ts). */
  removeProfile(id: string): void;
}

/**
 * The 「平台」 menu (spec §6.9): the profiles (⌘1…⌘9; an open one marked, `platformLabel`),
 * 「添加平台…」,
 * 「退出登录 <平台>…」 (the current profile, enabled only while it is signed in) and 「移除这个平台…」.
 * The app menu shows it; the error overlay's 「切换平台」 pops the same template up
 * (`Menu.buildFromTemplate(platformMenuTemplate(...)).popup()`).
 */
export function platformMenuTemplate(
  state: PlatformMenuState,
  actions: PlatformMenuActions,
): MenuItemModel[] {
  const tr = (key: string, vars?: Record<string, string>) => t(state.locale, key, vars);
  const items: MenuItemModel[] = state.profiles.map((p, i) => ({
    label: platformLabel(state.locale, p),
    ...(i < 9 ? { accelerator: `CmdOrCtrl+${i + 1}` } : {}),
    click: () => actions.showProfile(p.id),
  }));
  const current = state.profiles.find((p) => p.id === state.activeId);
  const tail: MenuItemModel[] = [];
  if (!state.lockDeployments) {
    tail.push({ label: tr("menu.platform.add"), click: () => actions.addPlatform() });
  }
  tail.push({
    label: current
      ? tr("menu.platform.signOut", { platform: current.name })
      : tr("menu.platform.signOutPlain"),
    enabled: current?.signedIn === true,
    click: () => {
      if (current?.signedIn) actions.signOut(current.id);
    },
  });
  if (!state.lockDeployments) {
    tail.push({
      label: tr("menu.platform.remove"),
      enabled: current !== undefined,
      click: () => {
        if (current) actions.removeProfile(current.id);
      },
    });
  }
  if (items.length > 0) items.push(SEPARATOR);
  return [...items, ...tail];
}

export interface AppMenuState extends TrayState, PlatformMenuState {
  productName: string;
  locale: Locale;
  startAtLogin: boolean;
  profiles: { id: string; name: string; signedIn: boolean; open: boolean }[];
}

export interface AppMenuActions extends PlatformMenuActions {
  setStartAtLogin(on: boolean): void;
}

export function appMenuTemplate(state: AppMenuState, actions: AppMenuActions): MenuItemModel[] {
  // Electron hard-codes English labels for bare roles (spec §12): every item carries a label from
  // the shell catalog and keeps its role, so the behaviour and the accelerators stay Electron's.
  const tr = (key: string) => t(state.locale, key, { name: state.productName });
  const role = (r: string, key: string): MenuItemModel => ({ role: r, label: tr(key) });
  return [
    {
      label: state.productName,
      submenu: [
        role("about", "menu.about"),
        SEPARATOR,
        {
          label: tr("menu.start_at_login"),
          type: "checkbox",
          checked: state.startAtLogin,
          click: (item) => actions.setStartAtLogin(item.checked),
        },
        SEPARATOR,
        role("hide", "menu.hide"),
        role("hideOthers", "menu.hide_others"),
        role("unhide", "menu.show_all"),
        SEPARATOR,
        role("quit", "menu.quit"),
      ],
    },
    { label: tr("menu.platform.title"), submenu: platformMenuTemplate(state, actions) },
    {
      label: tr("menu.edit"),
      submenu: [
        role("undo", "menu.undo"),
        role("redo", "menu.redo"),
        SEPARATOR,
        role("cut", "menu.cut"),
        role("copy", "menu.copy"),
        role("paste", "menu.paste"),
        role("pasteAndMatchStyle", "menu.paste_and_match_style"),
        role("delete", "menu.delete"),
        role("selectAll", "menu.select_all"),
      ],
    },
    {
      label: tr("menu.view"),
      submenu: [
        role("reload", "menu.reload"),
        role("forceReload", "menu.force_reload"),
        role("toggleDevTools", "menu.toggle_dev_tools"),
        SEPARATOR,
        role("resetZoom", "menu.reset_zoom"),
        role("zoomIn", "menu.zoom_in"),
        role("zoomOut", "menu.zoom_out"),
        SEPARATOR,
        role("togglefullscreen", "menu.toggle_fullscreen"),
      ],
    },
    {
      // `window`: macOS keeps its window list in this menu.
      label: tr("menu.window"),
      role: "window",
      submenu: [
        role("minimize", "menu.minimize"),
        role("zoom", "menu.zoom"),
        SEPARATOR,
        role("front", "menu.front"),
      ],
    },
  ];
}
