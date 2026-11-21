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

export interface ProfilesCapabilityDeps {
  profiles: Pick<ProfileStore, "current" | "setCurrent" | "remove" | "list">;
  /** The profiles the managed policy leaves visible (Task 18's `ProfileAccess.list`). */
  visible?: () => Profile[];
  menu: MenuHostPort;
  /** Shows the address page (add a platform). */
  openAddress(): Promise<void>;
  policy(): { locked: boolean };
  /** The native confirm for removing the current platform. */
  confirm(text: { message: string; ok: string; cancel: string }): Promise<boolean>;
  /** After a switch the store accepted: opens the new current profile. */
  afterSwitch?(profile: Profile): Promise<void>;
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

export function createProfilesCapability(deps: ProfilesCapabilityDeps): CapabilityImpl {
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
        try {
          if (picked === ADD_ID) {
            await deps.openAddress();
          } else if (picked === REMOVE_ID) {
            if (!current) return undefined;
            const ok = await deps.confirm({
              message: t(locale, "profile.remove_confirm.message"),
              ok: t(locale, "profile.remove_confirm.confirm"),
              cancel: t(locale, "dialog.cancel"),
            });
            if (!ok) return undefined;
            await deps.profiles.remove(current.id);
            await deps.afterRemove?.();
          } else if (picked.startsWith(PROFILE_PREFIX)) {
            const id = picked.slice(PROFILE_PREFIX.length);
            // Only a row of this sheet can be the answer, whatever the host reports.
            if (!rows.some((p) => p.id === id) || id === current?.id) return undefined;
            // Single-store mode asks first inside `setCurrent` (Decision 9).
            if ((await deps.profiles.setCurrent(id)) !== "switched") return undefined;
            const next = deps.profiles.current();
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
