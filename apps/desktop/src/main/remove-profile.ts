// Removing a platform (spec §6.3), from the app menu or the tray: a shell dialog (§7.4; cancel is
// the default, the remove button is the danger one), the device question when this machine has
// connections into that deployment, then the profile's windows close before its partition is
// cleared, so no window of a profile being removed passes the IPC checks while its data goes. Not offered for managed profiles under
// `lockDeployments`. Electron objects come in as parameters.
import { type Locale, t } from "@capybara-hq/shell";
import { dialogPlatformOf, platformLabel } from "./device/dialogs.ts";
import type { ConfirmGate } from "./ipc.ts";
import type { Profile } from "./profiles.ts";
import type { ShellDialogOptions, ShowShellDialog } from "./shell-dialog.ts";

export interface ProfileRemovalDeps {
  getProfile(id: string): Profile | undefined;
  /** False for a managed profile under `lockDeployments`. */
  isRemovable(profile: Profile): boolean;
  /** The bridge's gate: one dialog at a time per profile. */
  gate: ConfirmGate;
  /** A live window to attach the dialogs to (`windows.dialogParent`), or undefined. */
  dialogParent(profileId: string): unknown;
  showDialog: ShowShellDialog;
  /** The dialog's language: fixed, or the profile's own (spec §12). */
  locale: Locale | ((profileId: string) => Locale);
  /** The profile's platform icon as a data: URL (main's cache), else undefined: default icon. */
  iconFor?: (profile: Profile) => string | undefined;
  /**
   * device@2's `beforeRemoveProfile`: when this machine has connections into the deployment, asks
   * once whether to disconnect them and log them out.
   */
  beforeRemoveDevice(profile: Profile, parent: unknown): Promise<void>;
  closeProfileWindows(profileId: string): void;
  /** `profiles.remove`: clears the partition, then forgets the profile. */
  removeProfile(profileId: string): Promise<void>;
  /** `deviceAvailability.forget`. */
  forgetAvailability(profileId: string): void;
  /** The tray, the app menu and the Dock icon follow; the tray re-reads the device. */
  onRemoved(): void;
  log?: (message: string, err?: unknown) => void;
}

export function createProfileRemoval(deps: ProfileRemovalDeps) {
  async function confirm(parent: unknown, profile: Profile): Promise<boolean> {
    const locale = typeof deps.locale === "function" ? deps.locale(profile.id) : deps.locale;
    const tr = (key: string, vars?: Record<string, string>) => t(locale, key, vars);
    const { name, host } = platformLabel(profile);
    const options: ShellDialogOptions = {
      title:
        name === null
          ? tr("platform.remove.message_host", { host })
          : tr("platform.remove.message", { name, host }),
      detail: tr("platform.remove.detail"),
      buttons: [tr("platform.remove.cancel"), tr("platform.remove.confirm")],
      defaultId: 0,
      cancelId: 0,
      confirmId: 1,
      tone: "danger",
      platform: dialogPlatformOf(profile, deps.iconFor?.(profile)),
      profileId: profile.id,
    };
    const { response } = await deps.showDialog(parent, options);
    return response === options.confirmId;
  }

  return {
    async remove(profileId: string): Promise<void> {
      const profile = deps.getProfile(profileId);
      if (!profile || !deps.isRemovable(profile)) return;
      // A menu click is a user action in the app's own UI: the activation is given.
      if (deps.gate.isConfirmingCallAllowed(profile.id, true) !== "ok") {
        deps.log?.("a dialog is already open for this platform");
        return;
      }
      let removed = false;
      try {
        if (!(await confirm(deps.dialogParent(profile.id), profile))) return;
        try {
          await deps.beforeRemoveDevice(profile, deps.dialogParent(profile.id));
        } catch (err) {
          deps.log?.("the device step of a platform removal failed", err);
        }
        removed = true;
        deps.closeProfileWindows(profile.id);
        await deps.removeProfile(profile.id);
        deps.forgetAvailability(profile.id);
      } catch (err) {
        deps.log?.("the platform could not be removed", err);
      } finally {
        deps.gate.release(profile.id);
        if (removed) deps.onRemoved();
      }
    },
  };
}

export type ProfileRemoval = ReturnType<typeof createProfileRemoval>;
