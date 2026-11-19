// The app menu (macOS): the app's own items, the platform switcher (spec §6.3) and the standard
// edit, view and window menus, every item labelled from the shell catalog (zh, en). 「登录时启动」 is off by default (spec §9.4): it is checked only when
// the OS says the app is a login item, and toggling it calls `setLoginItemSettings`.
import { type Locale, t } from "@capybara-hq/shell";
import { type MenuItemModel, platformItems, type TrayActions, type TrayState } from "./tray.ts";

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

export interface AppMenuState extends TrayState {
  productName: string;
  locale: Locale;
  startAtLogin: boolean;
}

export interface AppMenuActions extends TrayActions {
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
    { label: tr("menu.platforms"), submenu: platformItems(state, actions) },
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
