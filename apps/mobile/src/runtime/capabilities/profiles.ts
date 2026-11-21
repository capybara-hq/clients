// `profiles@1` (mobile app spec §5.2): the native profile switcher the web's own platform chip
// opens. Confirming: the sheet is a native menu (MenuHost), one dialog at a time per profile, and
// needs a user activation. The page learns nothing: it gets `undefined` whatever is picked, and no
// profile name, id or origin crosses to it; the list is built and shown natively.
import { SHELL_CAPABILITY_KEYS } from "@capybara-hq/plugin-sdk";
import { type Locale, t } from "@capybara-hq/shell";
import type { Profile, ProfileStore } from "../profiles.ts";
import type { CapabilityImpl } from "../registry.ts";
import { fail, MOBILE_SHELL_LIMITS } from "./limits.ts";
import type { MenuHostPort, MenuShowItem } from "./menu.ts";

export const PROFILES_KEY = SHELL_CAPABILITY_KEYS.profiles;

const PROFILE_PREFIX = "profile-";
const ADD_ID = "add";
const REMOVE_ID = "remove";

export interface ProfilesCapabilityDeps<S extends { id: string } = Profile> {
  profiles: Pick<ProfileStore, "current" | "remove" | "list">;
  /** The profiles the managed policy leaves visible (Task 18's `ProfileAccess.list`). */
  visible?: () => Profile[];
  menu: MenuHostPort;
  /** Shows the address page (add a platform). */
  openAddress(): Promise<void>;
  policy(): { locked: boolean };
  /**
   * Switches through the same gates as every other switch (`ProfileAccess.switchTo`: visibility,
   * single-store ask and wipe); the profile now current, or null (hidden, refused, cancelled).
   */
  switchTo(id: string): Promise<S | null>;
  /** The warning haptic before the destructive confirm. */
  haptic?(): void;
  /** After a switch the gates accepted: opens the new current profile. */
  afterSwitch?(profile: S): Promise<void>;
  /** After the current profile was removed: shows what is left, or the address page. */
  afterRemove?(): Promise<void>;
  locale?: () => Locale;
}

function label(text: string): string {
  return text.length > MOBILE_SHELL_LIMITS.menuLabel
    ? `${text.slice(0, MOBILE_SHELL_LIMITS.menuLabel - 1)}…`
    : text;
}

function displayName(p: Profile): string {
  if (p.name) return p.name;
  try {
    return new URL(p.base).host;
  } catch {
    return p.base;
  }
}

const CONFIRM_ID = "confirm";

export function createProfilesCapability<S extends { id: string } = Profile>(
  deps: ProfilesCapabilityDeps<S>,
): CapabilityImpl {
  const list = () => deps.visible?.() ?? deps.profiles.list();

  return {
    confirming: ["show"],
    functions: {
      async show(ctx) {
        // A locked policy hides this capability, but a call racing the lock still gets nothing.
        if (deps.policy().locked) return fail();
        const locale = deps.locale?.() ?? "en";
        const current = deps.profiles.current();
        const shown = list();
        // Room for the add and remove rows; the current profile always stays listed.
        const room = MOBILE_SHELL_LIMITS.menuItems - 2;
        const rows = shown.slice(0, room);
        if (
          current &&
          shown.some((p) => p.id === current.id) &&
          !rows.some((p) => p.id === current.id)
        ) {
          rows[room - 1] = current;
        }
        const items: MenuShowItem[] = rows.map((p) => ({
          id: `${PROFILE_PREFIX}${p.id}`,
          label: label(p.id === current?.id ? `✓ ${displayName(p)}` : displayName(p)),
          destructive: false,
          disabled: false,
        }));
        items.push({
          id: ADD_ID,
          label: t(locale, "profile.switcher.add"),
          destructive: false,
          disabled: false,
        });
        if (current && shown.some((p) => p.id === current.id)) {
          items.push({
            id: REMOVE_ID,
            label: t(locale, "profile.switcher.remove"),
            destructive: true,
            disabled: false,
          });
        }
        const cancel = () => deps.menu.cancel();
        ctx.signal.addEventListener("abort", cancel, { once: true });
        let picked: string | null;
        try {
          picked = await deps.menu.show({ title: t(locale, "profile.switcher.title"), items });
        } catch {
          return fail();
        } finally {
          ctx.signal.removeEventListener("abort", cancel);
        }
        if (picked === null || ctx.signal.aborted) return undefined;
        // The managed policy may have changed while the sheet was open: ask again, per action.
        const allowed = () => !deps.policy().locked;
        if (!allowed()) return undefined;
        try {
          if (picked === ADD_ID) {
            await deps.openAddress();
          } else if (picked === REMOVE_ID) {
            if (!current) return undefined;
            deps.haptic?.();
            // A native confirm: one destructive row (the host adds its own cancel).
            const answer = await deps.menu.show({
              title: t(locale, "profile.remove_confirm.message"),
              items: [
                {
                  id: CONFIRM_ID,
                  label: t(locale, "profile.remove_confirm.confirm"),
                  destructive: true,
                  disabled: false,
                },
              ],
            });
            if (answer !== CONFIRM_ID || ctx.signal.aborted || !allowed()) return undefined;
            if (!list().some((p) => p.id === current.id)) return undefined;
            await deps.profiles.remove(current.id);
            await deps.afterRemove?.();
          } else if (picked.startsWith(PROFILE_PREFIX)) {
            const id = picked.slice(PROFILE_PREFIX.length);
            // Only a row of this sheet can be the answer, whatever the host reports.
            if (!rows.some((p) => p.id === id) || id === current?.id) return undefined;
            // Single-store mode asks first inside the store (Decision 9).
            const next = await deps.switchTo(id);
            if (next) await deps.afterSwitch?.(next);
          }
        } catch {
          return fail();
        }
        return undefined;
      },
    },
  };
}
