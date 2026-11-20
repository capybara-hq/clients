// `menu@1` (mobile app spec §5.2): a native menu. The runtime validates the input, hands the
// native `MenuHost` (MenuHost.swift: an action sheet or iPad popover; MenuHost.kt: a modal bottom
// sheet) a normalized copy, and resolves the picked item id or null. Confirming.
import { type MenuInputV1, SHELL_CAPABILITY_KEYS } from "@capybara-hq/plugin-sdk";
import { type Locale, t } from "@capybara-hq/shell";
import type { CapabilityImpl } from "../registry.ts";
import { fail, isRecord, MENU_ITEM_ID, MOBILE_SHELL_LIMITS, onlyKeys } from "./limits.ts";

export interface MenuShowItem {
  id: string;
  label: string;
  destructive: boolean;
  disabled: boolean;
}

export type MenuAnchor = NonNullable<MenuInputV1["anchor"]>;

export interface MenuShowInput {
  title?: string;
  items: MenuShowItem[];
  /** iPad popover only; Android ignores it. A rect in CSS px from the web view's top-left. */
  anchor?: MenuAnchor;
}

/** The native menu. Resolves the picked item id, or null when dismissed. */
export interface MenuHostPort {
  show(input: MenuShowInput): Promise<string | null>;
  /** Dismisses the menu showing now, if any (its `show` then resolves null). */
  cancel(): void;
}

export const MENU_HOST_PLUGIN_NAME = "MenuHost";

/** The Capacitor plugin `MenuHost` (MenuHost.swift, MenuHost.kt). */
export interface MenuHostPlugin {
  /** `cancelLabel` is the shell's own text (the iPhone action sheet's cancel row). */
  show(options: MenuShowInput & { cancelLabel: string }): Promise<{ id: string | null }>;
  cancel(): Promise<void>;
}

/** A `MenuHostPort` over the plugin; English labels when no locale is given. */
export function menuHostPortFrom(plugin: MenuHostPlugin, locale?: () => Locale): MenuHostPort {
  return {
    show: async (input) =>
      (await plugin.show({ ...input, cancelLabel: t(locale?.() ?? "en", "dialog.cancel") })).id,
    cancel: () => {
      plugin.cancel().catch(() => {});
    },
  };
}

export const MENU_KEY = SHELL_CAPABILITY_KEYS.menu;

function bool(v: unknown): boolean {
  if (v === undefined) return false;
  if (typeof v !== "boolean") return fail();
  return v;
}

function parseItem(v: unknown): MenuShowItem {
  if (!isRecord(v) || !onlyKeys(v, ["id", "label", "destructive", "disabled"])) return fail();
  const { id, label } = v;
  if (typeof id !== "string" || !MENU_ITEM_ID.test(id)) return fail();
  if (
    typeof label !== "string" ||
    label.length === 0 ||
    label.length > MOBILE_SHELL_LIMITS.menuLabel
  ) {
    return fail();
  }
  return { id, label, destructive: bool(v.destructive), disabled: bool(v.disabled) };
}

function parseAnchor(v: unknown): MenuAnchor {
  if (!isRecord(v) || !onlyKeys(v, ["x", "y", "width", "height"])) return fail();
  const { x, y, width, height } = v;
  for (const n of [x, y, width, height]) {
    if (typeof n !== "number" || !Number.isFinite(n)) return fail();
  }
  return { x, y, width, height } as MenuAnchor;
}

export function parseMenuInput(input: unknown): MenuShowInput {
  if (!isRecord(input) || !onlyKeys(input, ["title", "items", "anchor"])) return fail();
  const { items } = input;
  if (!Array.isArray(items) || items.length === 0 || items.length > MOBILE_SHELL_LIMITS.menuItems) {
    return fail();
  }
  const parsed = items.map(parseItem);
  if (new Set(parsed.map((i) => i.id)).size !== parsed.length) return fail();
  const out: MenuShowInput = { items: parsed };
  if (input.title !== undefined) {
    if (typeof input.title !== "string" || input.title.length > MOBILE_SHELL_LIMITS.menuTitle) {
      return fail();
    }
    out.title = input.title;
  }
  if (input.anchor !== undefined) out.anchor = parseAnchor(input.anchor);
  return out;
}

export function createMenuCapability(host: MenuHostPort): CapabilityImpl {
  return {
    confirming: ["show"],
    functions: {
      async show(ctx, input) {
        const menu = parseMenuInput(input);
        // The document ended (the registry has answered `cancelled`): close the menu natively.
        const cancel = () => host.cancel();
        ctx.signal.addEventListener("abort", cancel, { once: true });
        let picked: string | null;
        try {
          picked = await host.show(menu);
        } catch {
          return fail();
        } finally {
          ctx.signal.removeEventListener("abort", cancel);
        }
        // Only an enabled item of this menu can be the answer, whatever the host reports.
        const item = menu.items.find((i) => i.id === picked);
        return item && !item.disabled ? item.id : null;
      },
    },
  };
}
