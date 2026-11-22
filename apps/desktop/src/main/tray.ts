// The tray (D1) and the platform entries of the app menu: one model, two renderers. The model is a
// pure function of the state, so a later task (device state, Task 19) extends the state and the
// model without touching how a menu is built. Electron's Tray and Menu come in as parameters.
import type { KeepAwakeMode } from "@capybara-hq/plugin-sdk";
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

/**
 * What the tray icon says about this machine (spec §9.6): not connected, online, offline, paused
 * (draining, or stopped by the person), busy (online with running operations).
 */
export type TrayIconState = "not_connected" | "online" | "offline" | "paused" | "busy";

/** One of this machine's device connections, as the tray shows it. */
export interface TrayDevice {
  deviceId: string;
  host: string;
  /** The org's name, or its id when the program has no name for it. */
  orgLabel: string;
  icon: Exclude<TrayIconState, "not_connected">;
  running: number;
  keepAwake: KeepAwakeMode;
  /** The saved profile of that deployment; absent: not one of ours, the row has no actions. */
  profileId?: string | undefined;
}

/** The icon of the worst connection: offline > busy > paused > online; none: not connected. */
export function worstIcon(devices: readonly TrayDevice[]): TrayIconState {
  const order = ["offline", "busy", "paused", "online"] as const;
  for (const icon of order) if (devices.some((d) => d.icon === icon)) return icon;
  return "not_connected";
}

export interface TrayState {
  locale: Locale;
  /** The offered profiles; `open`: a main window of it is open now. */
  profiles: { id: string; name: string; open: boolean }[];
  /** Managed `lockDeployments`: 「添加平台」 is not offered. */
  lockDeployments: boolean;
  /** Every connection of this machine (the tray is the person's own UI, not a page). */
  devices?: TrayDevice[] | undefined;
}

/** Device actions of the tray: each runs for one connection of a saved profile (tray-device.ts). */
export interface TrayDeviceActions {
  pause(profileId: string, deviceId: string): unknown;
  resume(profileId: string, deviceId: string): unknown;
  disconnect(profileId: string, deviceId: string): unknown;
  setKeepAwake(profileId: string, deviceId: string, mode: KeepAwakeMode): unknown;
  openDevicePage(profileId: string, deviceId: string): unknown;
}

export interface TrayActions {
  showProfile(id: string): void;
  addPlatform(): void;
  /** Asks, then removes the platform (remove-profile.ts). Absent: no 「移除平台」. */
  removeProfile?: (id: string) => void;
  openWindow(): void;
  quit(): void;
  device?: TrayDeviceActions;
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

const KEEP_AWAKE_ORDER: KeepAwakeMode[] = ["off", "while-busy", "connected"];

/** The state line's text key: busy is online with a count. */
const stateKey = (icon: Exclude<TrayIconState, "not_connected">) =>
  `tray.device.state.${icon === "busy" ? "online" : icon}`;

/** One connection's row: a submenu with its state, running count, 暂停 / 恢复, 断开, keep-awake, 「本机」. */
function deviceRow(device: TrayDevice, locale: Locale, act: TrayDeviceActions | undefined) {
  const { profileId, deviceId } = device;
  // Without a saved profile for the deployment there is no dialog parent or page to open.
  const usable = profileId !== undefined && act !== undefined;
  const go = (run: (a: TrayDeviceActions, profile: string) => unknown) => () => {
    if (act && profileId !== undefined) run(act, profileId);
  };
  const state = t(locale, stateKey(device.icon));
  const items: MenuItemModel[] = [
    { label: state, enabled: false },
    { label: t(locale, "tray.device.running", { count: String(device.running) }), enabled: false },
    device.icon === "paused"
      ? {
          label: t(locale, "tray.device.resume"),
          enabled: usable,
          click: go((a, p) => a.resume(p, deviceId)),
        }
      : {
          label: t(locale, "tray.device.pause"),
          enabled: usable,
          click: go((a, p) => a.pause(p, deviceId)),
        },
    {
      label: t(locale, "tray.device.disconnect"),
      enabled: usable,
      click: go((a, p) => a.disconnect(p, deviceId)),
    },
    {
      label: t(locale, "tray.device.keep_awake"),
      enabled: usable,
      submenu: KEEP_AWAKE_ORDER.map((mode) => ({
        label: t(locale, `tray.device.keep_awake.${mode}`),
        type: "radio" as const,
        checked: device.keepAwake === mode,
        click: go((a, p) => a.setKeepAwake(p, deviceId, mode)),
      })),
    },
    {
      label: t(locale, "tray.device.page"),
      enabled: usable,
      click: go((a, p) => a.openDevicePage(p, deviceId)),
    },
  ];
  return {
    label: t(locale, "tray.device.row", { host: device.host, org: device.orgLabel, state }),
    submenu: items,
  };
}

/** The device section: one row per connection. */
function deviceItems(state: TrayState, actions: TrayActions): MenuItemModel[] {
  return (state.devices ?? []).map((d) => deviceRow(d, state.locale, actions.device));
}

/** The icon's tooltip and title suffix: the worst state and the running count of all of them. */
export function trayIndication(state: TrayState): { tooltip: string; suffix: string } {
  const devices = state.devices ?? [];
  const worst = worstIcon(devices);
  if (worst === "not_connected") return { tooltip: "", suffix: "" };
  const { locale } = state;
  const label = t(locale, stateKey(worst));
  const total = devices.reduce((n, d) => n + d.running, 0);
  if (worst === "busy") {
    const count = t(locale, "tray.device.running", { count: String(total) });
    return { tooltip: `${label} · ${count}`, suffix: String(total) };
  }
  return {
    tooltip: label,
    suffix: worst === "offline" ? "!" : worst === "paused" ? "⏸" : "",
  };
}

/** The tray menu: profiles, 「添加平台」, a row per device connection, open window, quit. */
export function trayMenuModel(state: TrayState, actions: TrayActions): MenuItemModel[] {
  const platforms = platformItems(state, actions);
  const device = deviceItems(state, actions);
  return [
    ...platforms,
    ...(platforms.length > 0 ? [SEPARATOR] : []),
    ...(device.length > 0 ? [...device, SEPARATOR] : []),
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
      const { tooltip, suffix } = trayIndication(state);
      tray.setToolTip(tooltip ? `${deps.tooltip} · ${tooltip}` : deps.tooltip);
      const title = [deps.fallbackTitle ?? "", suffix].filter(Boolean).join(" ");
      tray.setTitle?.(title);
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
