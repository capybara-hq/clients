// The app menu (macOS): the app's own items, the platform switcher (spec §6.3) and the standard
// edit, view and window menus. 「登录时启动」 is off by default (spec §9.4): it is checked only when
// the OS says the app is a login item, and toggling it calls `setLoginItemSettings`.
import { type Locale, t } from "@capybara-hq/shell";
import { type MenuItemModel, platformItems, type TrayActions, type TrayState } from "./tray.ts";

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
  return [
    {
      label: state.productName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: t(state.locale, "menu.start_at_login"),
          type: "checkbox",
          checked: state.startAtLogin,
          click: (item) => actions.setStartAtLogin(item.checked),
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: t(state.locale, "menu.platforms"), submenu: platformItems(state, actions) },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
