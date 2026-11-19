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

/** This machine's device, as the tray shows it. */
export interface TrayDevice {
  icon: TrayIconState;
  running: number;
  keepAwake: KeepAwakeMode;
  /** The saved profile of the deployment the machine is connected to; absent: not one of ours. */
  profileId?: string | undefined;
  deviceId?: string | undefined;
}

export interface TrayState {
  locale: Locale;
  profiles: { id: string; name: string }[];
  /** The profile in front (the last used one), shown checked. */
  activeId?: string | undefined;
  /** Managed `lockDeployments`: 「添加平台」 is not offered. */
  lockDeployments: boolean;
  /** The machine's device; absent or `not_connected`: no device entries. */
  device?: TrayDevice | undefined;
}

/** Device actions of the tray: each runs for the profile (device/tray-device.ts). */
export interface TrayDeviceActions {
  pause(profileId: string): unknown;
  resume(profileId: string): unknown;
  disconnect(profileId: string): unknown;
  setKeepAwake(profileId: string, mode: KeepAwakeMode): unknown;
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
 * The profile switcher, 「添加平台」 and 「移除平台」 (one entry per platform): shared by the tray and
 * the app menu. Under `lockDeployments` the offered profiles are the managed ones, and neither
 * adding nor removing is offered.
 */
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

/** The device section: state, running count, 暂停 / 恢复, 断开, keep-awake, 「本机」. */
function deviceItems(state: TrayState, actions: TrayActions): MenuItemModel[] {
  const device = state.device;
  if (!device || device.icon === "not_connected") return [];
  const { locale } = state;
  const act = actions.device;
  const profileId = device.profileId;
  // Without a saved profile for the deployment there is no dialog parent or page to open.
  const usable = profileId !== undefined && act !== undefined;
  const go = (run: (a: TrayDeviceActions, id: string) => unknown) => () => {
    if (act && profileId !== undefined) run(act, profileId);
  };
  const paused = device.icon === "paused";
  return [
    { label: t(locale, stateKey(device.icon)), enabled: false },
    { label: t(locale, "tray.device.running", { count: String(device.running) }), enabled: false },
    paused
      ? {
          label: t(locale, "tray.device.resume"),
          enabled: usable,
          click: go((a, id) => a.resume(id)),
        }
      : {
          label: t(locale, "tray.device.pause"),
          enabled: usable,
          click: go((a, id) => a.pause(id)),
        },
    {
      label: t(locale, "tray.device.disconnect"),
      enabled: usable,
      click: go((a, id) => a.disconnect(id)),
    },
    {
      label: t(locale, "tray.device.keep_awake"),
      enabled: usable,
      submenu: KEEP_AWAKE_ORDER.map((mode) => ({
        label: t(locale, `tray.device.keep_awake.${mode}`),
        type: "radio" as const,
        checked: device.keepAwake === mode,
        click: go((a, id) => a.setKeepAwake(id, mode)),
      })),
    },
    {
      label: t(locale, "tray.device.page"),
      enabled: usable && device.deviceId !== undefined,
      click: () => {
        if (act && profileId !== undefined && device.deviceId !== undefined) {
          act.openDevicePage(profileId, device.deviceId);
        }
      },
    },
  ];
}

/** The icon's tooltip and title suffix (one template image; the state rides on text). */
export function trayIndication(state: TrayState): { tooltip: string; suffix: string } {
  const device = state.device;
  if (!device || device.icon === "not_connected") return { tooltip: "", suffix: "" };
  const { locale } = state;
  const label = t(locale, stateKey(device.icon));
  if (device.icon === "busy") {
    const count = t(locale, "tray.device.running", { count: String(device.running) });
    return { tooltip: `${label} · ${count}`, suffix: String(device.running) };
  }
  return {
    tooltip: label,
    suffix: device.icon === "offline" ? "!" : device.icon === "paused" ? "⏸" : "",
  };
}

/** The tray menu: profiles, 「添加平台」, the device section, open window, quit. */
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
