// The confirmations of device@1 (spec §9.1, §9.3, §9.5, §9.7, §6.3): shell dialogs (§7.4), drawn
// by the app in a window of its own attached to the profile's window, so the page can neither draw
// nor click them. Every dialog has two buttons, cancel first (取消 / 否: the cancel button, where
// the focus starts, so Enter and Escape refuse) and the confirming one last; only a deliberate
// click allows. `showDialog` is the shell dialog, injected so tests answer it.

import type { KeepAwakeMode } from "@capybara-hq/plugin-sdk";
import { type Locale, t } from "@capybara-hq/shell";
import type { Profile } from "../profiles.ts";
import {
  cleanPlatformName,
  type ShellDialogOptions,
  type ShowShellDialog,
} from "../shell-dialog.ts";

export interface DeviceDialogs {
  /** 「允许 <平台名称>（<host>）在这台电脑上运行命令吗？」 */
  confirmConnect(parent: unknown, profile: Profile): Promise<boolean>;
  /** This machine is logged in to `origin`: disconnect it first (spec §9.3)? */
  confirmDisconnectOther(parent: unknown, origin: string): Promise<boolean>;
  confirmResume(parent: unknown, profile: Profile): Promise<boolean>;
  /**
   * Names each widened item first, so a page asking for both cannot pass as asking for one; then
   * `texts`, the device program's own risk texts, as given (spec §9.5).
   */
  confirmWidenCeiling(
    parent: unknown,
    widened: { outsideSandbox: boolean; network: boolean; projectReach: boolean },
    texts: string[],
    profile?: Profile,
  ): Promise<boolean>;
  confirmRaiseKeepAwake(
    parent: unknown,
    mode: Exclude<KeepAwakeMode, "off">,
    profile?: Profile,
  ): Promise<boolean>;
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
  // Cleaned of control and bidi characters and capped: it is shown inside a confirmation.
  const name = cleanPlatformName(profile.name);
  const isHost = name === "" || name === url.host || name === url.hostname;
  return { name: isHost ? null : name, host: url.host };
}

/** The platform a dialog names, with its icon as a data: URL when main has one cached. */
export function dialogPlatformOf(
  profile: Pick<Profile, "name" | "origin">,
  iconUrl?: string,
): NonNullable<ShellDialogOptions["platform"]> {
  const { name, host } = platformLabel(profile);
  return { name: name ?? host, host, ...(iconUrl ? { iconUrl } : {}) };
}

export function createDeviceDialogs(deps: {
  showDialog: ShowShellDialog;
  locale: Locale;
  /** The profile's platform icon as a data: URL (main's cache), else undefined: default icon. */
  iconFor?: (profile: Profile) => string | undefined;
  /** `process.platform`: the keep-awake limits differ on Linux (the lid switch, spec §9.7). */
  platform: string;
}): DeviceDialogs {
  // `deps.locale` is read at each call: main passes a getter that follows the chosen language.
  const tr = (key: string, vars?: Record<string, string>) => t(deps.locale, key, vars);

  /** Asks; true only for the confirming (last) button. */
  async function ask(
    parent: unknown,
    o: {
      message: string;
      detail: string;
      confirm: string;
      cancel?: string;
      tone?: "primary" | "danger";
      profile?: Profile | undefined;
    },
  ): Promise<boolean> {
    const options: ShellDialogOptions = {
      title: o.message,
      detail: o.detail,
      buttons: [o.cancel ?? tr("device.cancel"), o.confirm],
      defaultId: 0,
      cancelId: 0,
      confirmId: 1,
      tone: o.tone ?? "primary",
      ...(o.profile
        ? {
            platform: dialogPlatformOf(o.profile, deps.iconFor?.(o.profile)),
            profileId: o.profile.id,
          }
        : {}),
    };
    const { response } = await deps.showDialog(parent, options);
    return response === options.confirmId;
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
        profile,
      }),

    confirmDisconnectOther: (parent, origin) =>
      ask(parent, {
        tone: "danger",
        message: tr("device.disconnect_other.message", { origin }),
        detail: tr("device.disconnect_other.detail"),
        confirm: tr("device.disconnect_other.confirm"),
      }),

    confirmResume: (parent, profile) =>
      ask(parent, {
        message: named("device.resume.message", profile),
        detail: tr("device.resume.detail"),
        confirm: tr("device.resume.confirm"),
        profile,
      }),

    confirmWidenCeiling: (parent, widened, texts, profile) =>
      ask(parent, {
        profile,
        message: tr("device.ceiling.message"),
        detail: [
          [
            ...(widened.outsideSandbox ? [tr("device.ceiling.change.outside_sandbox")] : []),
            ...(widened.network ? [tr("device.ceiling.change.network")] : []),
            ...(widened.projectReach ? [tr("device.ceiling.change.project_reach")] : []),
          ].join("\n"),
          ...texts,
        ].join("\n\n"),
        confirm: tr("device.ceiling.confirm"),
      }),

    confirmRaiseKeepAwake: (parent, mode, profile) =>
      ask(parent, {
        profile,
        message: tr("device.keep_awake.message"),
        detail: `${tr(`device.keep_awake.detail.${mode}`)}\n\n${tr(
          deps.platform === "linux" ? "device.keep_awake.limits_linux" : "device.keep_awake.limits",
        )}`,
        confirm: tr("device.keep_awake.confirm"),
      }),

    confirmRemoveDevice: (parent, profile) => {
      const { name, host } = platformLabel(profile);
      return ask(parent, {
        message: tr("device.remove.message"),
        detail: tr("device.remove.detail", { platform: name ?? host }),
        confirm: tr("device.remove.yes"),
        cancel: tr("device.remove.no"),
        tone: "danger",
        profile,
      });
    },
  };
}
