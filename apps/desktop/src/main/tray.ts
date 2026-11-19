// The tray (D1) and the platform entries of the app menu: one model, two renderers. The model is a
// pure function of the state, so a later task (device state, Task 19) extends the state and the
// model without touching how a menu is built. Electron's Tray and Menu come in as parameters.
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
  profiles: { id: string; name: string }[];
  /** The profile in front (the last used one), shown checked. */
  activeId?: string | undefined;
  /** Managed `lockDeployments`: 「添加平台」 is not offered. */
  lockDeployments: boolean;
}

export interface TrayActions {
  showProfile(id: string): void;
  addPlatform(): void;
  openWindow(): void;
  quit(): void;
}

const SEPARATOR: MenuItemModel = { type: "separator" };

/** The profile switcher and 「添加平台」: shared by the tray and the app menu. */
export function platformItems(state: TrayState, actions: TrayActions): MenuItemModel[] {
  const items: MenuItemModel[] = state.profiles.map((p) => ({
    label: p.name,
    type: "radio",
    checked: p.id === state.activeId,
    click: () => actions.showProfile(p.id),
  }));
  if (!state.lockDeployments) {
    if (items.length > 0) items.push(SEPARATOR);
    items.push({ label: t(state.locale, "platform.add"), click: () => actions.addPlatform() });
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
        tray.setToolTip(deps.tooltip);
        if (deps.fallbackTitle) tray.setTitle?.(deps.fallbackTitle);
        tray.on("click", () => deps.actions.openWindow());
      }
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
