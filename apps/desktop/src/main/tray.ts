// The tray (D1) and the platform entries of the app menu: one model, two renderers. The model is a
// pure function of the state; Electron's Tray and Menu come in as parameters. The tray shows no
// device state: the desktop manages no devices (maintainer decision 2026-11-23).
import { type Locale, t } from "@capybara-hq/shell";

export interface MenuItemModel {
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "radio";
  checked?: boolean;
  enabled?: boolean;
  role?: string;
  accelerator?: string;
  click?: (item: { checked: boolean }) => void;
  submenu?: MenuItemModel[];
}

export interface TrayState {
  locale: Locale;
  /** The offered profiles; `open`: a main window of it is open now. */
  profiles: { id: string; name: string; open: boolean }[];
  /** Managed `lockDeployments`: 「添加平台」 is not offered. */
  lockDeployments: boolean;
}

export interface TrayActions {
  showProfile(id: string): void;
  addPlatform(): void;
  /** Asks, then removes the platform (remove-profile.ts). Absent: no 「移除平台」. */
  removeProfile?: (id: string) => void;
  openWindow(): void;
  quit(): void;
}

const SEPARATOR: MenuItemModel = { type: "separator" };

/**
 * A platform's entry label. Several platforms can have windows open at once, so the menus check
 * none of them (no radio): an open one carries a dot and a localized word in the label itself
 * ("Example • Open"), which every OS draws and screen readers announce (a `sublabel` or tooltip is
 * not shown or not read on every OS, and a bare symbol is skipped as punctuation).
 */
export function platformLabel(locale: Locale, profile: { name: string; open: boolean }): string {
  return profile.open ? t(locale, "platform.open_label", { platform: profile.name }) : profile.name;
}

/**
 * The profile switcher, 「添加平台」 and 「移除平台」 (one entry per platform): shared by the tray and
 * the app menu. A click shows the platform: focuses its window, or opens one. Under
 * `lockDeployments` the offered profiles are the managed ones, and neither adding nor removing is
 * offered.
 */
export function platformItems(state: TrayState, actions: TrayActions): MenuItemModel[] {
  const items: MenuItemModel[] = state.profiles.map((p) => ({
    label: platformLabel(state.locale, p),
    click: () => actions.showProfile(p.id),
  }));
  if (!state.lockDeployments) {
    if (items.length > 0) items.push(SEPARATOR);
    items.push({ label: t(state.locale, "platform.add"), click: () => actions.addPlatform() });
    const remove = actions.removeProfile;
    if (remove && state.profiles.length > 0) {
      items.push({
        label: t(state.locale, "platform.remove"),
        submenu: state.profiles.map((p) => ({ label: `${p.name}…`, click: () => remove(p.id) })),
      });
    }
  }
  return items;
}

/** The tray menu: profiles, 「添加平台」, open window, quit. */
export function trayMenuModel(state: TrayState, actions: TrayActions): MenuItemModel[] {
  const platforms = platformItems(state, actions);
  return [
    ...platforms,
    ...(platforms.length > 0 ? [SEPARATOR] : []),
    { label: t(state.locale, "tray.open_window"), click: () => actions.openWindow() },
    SEPARATOR,
    { label: t(state.locale, "tray.quit"), click: () => actions.quit() },
  ];
}

export interface TrayLike {
  setToolTip(text: string): void;
  setContextMenu(menu: unknown): void;
  setTitle?(title: string): void;
  on(event: "click", listener: () => void): unknown;
  destroy(): void;
}

export interface TrayDeps {
  /** `new Tray(icon)`. */
  createTray(): TrayLike;
  /** `Menu.buildFromTemplate`. */
  buildMenu(template: MenuItemModel[]): unknown;
  tooltip: string;
  /** Shown as the tray's title when there is no icon image yet. */
  fallbackTitle?: string;
  actions: TrayActions;
}

export function createTrayController(deps: TrayDeps) {
  let tray: TrayLike | undefined;
  return {
    /** Creates the tray on first use, then rebuilds its menu. */
    update(state: TrayState): void {
      if (!tray) {
        tray = deps.createTray();
        tray.on("click", () => deps.actions.openWindow());
      }
      tray.setToolTip(deps.tooltip);
      tray.setTitle?.(deps.fallbackTitle ?? "");
      tray.setContextMenu(deps.buildMenu(trayMenuModel(state, deps.actions)));
    },
    destroy(): void {
      tray?.destroy();
      tray = undefined;
    },
    exists(): boolean {
      return tray !== undefined;
    },
  };
}
