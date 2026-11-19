// The native confirmations of device@1 (spec §9.1, §9.3, §9.5, §9.7, §6.3): drawn by the OS,
// attached to the profile's window, so the page can neither draw nor click them. Every dialog has
// two buttons; the second (取消 / 否) is both the default and the cancel button, so Enter and
// Escape refuse and only a deliberate click allows. `showMessageBox` is Electron's
// `dialog.showMessageBox`, injected so tests answer it.

import type { KeepAwakeMode } from "@capybara-hq/plugin-sdk";
import { type Locale, t } from "@capybara-hq/shell";
import type { Profile } from "../profiles.ts";

export interface MessageBoxOptions {
  type: "question" | "warning";
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  /** macOS: plain buttons, never command links. */
  noLink: true;
}

/** `parent` is the profile's window, or null when none is open (the box is then app-modal). */
export type ShowMessageBox = (
  parent: unknown,
  options: MessageBoxOptions,
) => Promise<{ response: number }>;

export interface DeviceDialogs {
  /** 「允许 <平台名称>（<host>）在这台电脑上运行命令吗？」 */
  confirmConnect(parent: unknown, profile: Profile): Promise<boolean>;
  /** This machine is logged in to `origin`: disconnect it first (spec §9.3)? */
  confirmDisconnectOther(parent: unknown, origin: string): Promise<boolean>;
  confirmResume(parent: unknown, profile: Profile): Promise<boolean>;
  /** `texts` are the device program's own risk texts, shown as given (spec §9.5). */
  confirmWidenCeiling(parent: unknown, texts: string[]): Promise<boolean>;
  confirmRaiseKeepAwake(parent: unknown, mode: Exclude<KeepAwakeMode, "off">): Promise<boolean>;
  /** Removing a profile this machine is connected to: disconnect and log the device out too? */
  confirmRemoveDevice(parent: unknown, profile: Profile): Promise<boolean>;
}

/**
 * The platform as the dialogs name it: the discovery name and the host, or only the host when the
 * platform has no name (discovery then stored the host as the profile name).
 */
export function platformLabel(profile: Pick<Profile, "name" | "origin">): {
  name: string | null;
  host: string;
} {
  const url = new URL(profile.origin);
  const name = profile.name.trim();
  const isHost = name === "" || name === url.host || name === url.hostname;
  return { name: isHost ? null : name, host: url.host };
}

export function createDeviceDialogs(deps: {
  showMessageBox: ShowMessageBox;
  locale: Locale;
}): DeviceDialogs {
  const { locale } = deps;
  const tr = (key: string, vars?: Record<string, string>) => t(locale, key, vars);

  /** Asks; true only for the first (allowing) button. */
  async function ask(
    parent: unknown,
    o: {
      type?: "question" | "warning";
      message: string;
      detail: string;
      confirm: string;
      cancel?: string;
    },
  ): Promise<boolean> {
    const { response } = await deps.showMessageBox(parent, {
      type: o.type ?? "question",
      message: o.message,
      detail: o.detail,
      buttons: [o.confirm, o.cancel ?? tr("device.cancel")],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return response === 0;
  }

  /** A message key with `{name}` and `{host}`, or its `_host` variant when there is no name. */
  const named = (key: string, profile: Profile) => {
    const { name, host } = platformLabel(profile);
    return name === null ? tr(`${key}_host`, { host }) : tr(key, { name, host });
  };

  return {
    confirmConnect: (parent, profile) =>
      ask(parent, {
        message: named("device.connect.message", profile),
        detail: tr("device.connect.detail"),
        confirm: tr("device.allow"),
      }),

    confirmDisconnectOther: (parent, origin) =>
      ask(parent, {
        type: "warning",
        message: tr("device.disconnect_other.message", { origin }),
        detail: tr("device.disconnect_other.detail"),
        confirm: tr("device.disconnect_other.confirm"),
      }),

    confirmResume: (parent, profile) =>
      ask(parent, {
        message: named("device.resume.message", profile),
        detail: tr("device.resume.detail"),
        confirm: tr("device.resume.confirm"),
      }),

    confirmWidenCeiling: (parent, texts) =>
      ask(parent, {
        type: "warning",
        message: tr("device.ceiling.message"),
        detail: texts.join("\n\n"),
        confirm: tr("device.ceiling.confirm"),
      }),

    confirmRaiseKeepAwake: (parent, mode) =>
      ask(parent, {
        message: tr("device.keep_awake.message"),
        detail: `${tr(`device.keep_awake.detail.${mode}`)}\n\n${tr("device.keep_awake.limits")}`,
        confirm: tr("device.keep_awake.confirm"),
      }),

    confirmRemoveDevice: (parent, profile) => {
      const { name, host } = platformLabel(profile);
      return ask(parent, {
        message: tr("device.remove.message"),
        detail: tr("device.remove.detail", { platform: name ?? host }),
        confirm: tr("device.remove.yes"),
        cancel: tr("device.remove.no"),
      });
    },
  };
}
