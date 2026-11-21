// `nav@1` (mobile app spec §5.2, §6.1, decided 2026-11-21): the iPhone Duo's strip navigation. iOS
// only, and offered exactly while the window has a strip, so its presence is the strip's
// visibility: native reports the strip (`stripChanged`), the registry re-evaluates and the page
// gets one `change`. The web hands the sections, their counts and the strip's menu button with
// `set`; the shell draws them with its own icon per id (StripHost.swift) and tells the shown
// profile's page about taps (`onSelect`, the current section included, and `onMenu`). Not
// confirming, no activation.
import {
  NAV_SECTION_ORDER,
  type NavSectionId,
  type NavStateV1,
  SHELL_CAPABILITY_KEYS,
} from "@capybara-hq/plugin-sdk";
import type { ProfileRef } from "../protocol.ts";
import type { CapabilityImpl, CapabilityRegistry } from "../registry.ts";
import { fail, isRecord, onlyKeys } from "./limits.ts";

export const NAV_KEY = SHELL_CAPABILITY_KEYS.nav;

/**
 * The label and count limits of decision 2 (nav label 1..32, count an integer 0..9999). They move
 * to `MOBILE_SHELL_LIMITS.navLabel` / `navCount` in the SDK with core Task 30; until that release
 * the shell keeps the same values here.
 */
export const NAV_LIMITS = { label: 32, count: 9999 } as const;

/** What the native strip draws: the sections in order with the OS badge text, and the menu button. */
export interface NavNativeState {
  items: { id: NavSectionId; label: string; badge: string | null }[];
  current: NavSectionId | null;
  menu: { label: string; badge: string | null } | null;
}

/** The native strip (`StripHost` through the `CapybaraHost` plugin). */
export interface NavNativePort {
  set(state: NavNativeState): Promise<void>;
}

function badge(v: Record<string, unknown>): { count?: number; countMore?: boolean } | null {
  const out: { count?: number; countMore?: boolean } = {};
  if (v.count !== undefined) {
    const n = v.count;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > NAV_LIMITS.count) return null;
    out.count = n;
  }
  if (v.countMore !== undefined) {
    if (typeof v.countMore !== "boolean") return null;
    out.countMore = v.countMore;
  }
  return out;
}

function label(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= NAV_LIMITS.label ? v : null;
}

/** The page's `set` input as a `NavStateV1`, or null when anything is off (the call then fails). */
export function validateNavState(input: unknown): NavStateV1 | null {
  if (!isRecord(input) || !onlyKeys(input, ["items", "current", "menu"])) return null;
  const { items, current, menu } = input;
  if (!Array.isArray(items) || items.length > NAV_SECTION_ORDER.length) return null;
  const out: NavStateV1 = { items: [], current: null, menu: null };
  let last = -1;
  for (const raw of items) {
    if (!isRecord(raw) || !onlyKeys(raw, ["id", "label", "count", "countMore"])) return null;
    const order = NAV_SECTION_ORDER.indexOf(raw.id as NavSectionId);
    // Known ids only, each once, in NAV_SECTION_ORDER.
    if (order <= last) return null;
    last = order;
    const text = label(raw.label);
    const counts = badge(raw);
    if (text === null || counts === null) return null;
    out.items.push({ id: raw.id as NavSectionId, label: text, ...counts });
  }
  if (current !== null) {
    if (!out.items.some((item) => item.id === current)) return null;
    out.current = current as NavSectionId;
  }
  if (menu === undefined) return null;
  if (menu !== null) {
    if (!isRecord(menu) || !onlyKeys(menu, ["label", "count", "countMore"])) return null;
    const text = label(menu.label);
    const counts = badge(menu);
    if (text === null || counts === null) return null;
    out.menu = { label: text, ...counts };
  }
  return out;
}

/** The OS badge text: none for 0 or no count, `99+` above 99, `N+` when the count is a floor. */
export function badgeText(b: { count?: number; countMore?: boolean }): string | null {
  const count = b.count ?? 0;
  if (count <= 0) return null;
  if (count > 99) return "99+";
  return b.countMore ? `${count}+` : String(count);
}

function nativeState(state: NavStateV1): NavNativeState {
  return {
    items: state.items.map((item) => ({ id: item.id, label: item.label, badge: badgeText(item) })),
    current: state.current,
    menu: state.menu ? { label: state.menu.label, badge: badgeText(state.menu) } : null,
  };
}

export interface NavDeps<P extends ProfileRef> {
  registry: CapabilityRegistry<P>;
  native: NavNativePort;
  /** The profiles the registry knows: each is refreshed when the strip comes or goes. */
  profiles(): P[];
  /** The profile whose WebView is on screen (the strip belongs to it), or null. */
  shown(): string | null;
  /** The strip as native reported it at start. */
  strip: boolean;
}

export interface Nav<P extends ProfileRef> {
  capability: CapabilityImpl<P>;
  available(profile: P): boolean;
  /** Native: the window gained or lost its strip. */
  stripChanged(visible: boolean): void;
  /** Native: a section was tapped (the selected one too). */
  sectionSelected(id: string): void;
  /** Native: the strip's menu button was tapped. */
  menuTapped(): void;
  /** The runtime showed this profile: the strip draws the sections its page last set. */
  profileShown(profileId: string): void;
}

export function createNav<P extends ProfileRef>(deps: NavDeps<P>): Nav<P> {
  let strip = deps.strip;
  // Profile id -> what its page last set; drawn when that profile is the one shown.
  const states = new Map<string, NavNativeState>();

  const draw = (profileId: string) => {
    const state = states.get(profileId);
    if (state && deps.shown() === profileId) deps.native.set(state).catch(() => {});
  };
  const emit = (event: "onSelect" | "onMenu", payload: unknown) => {
    const id = deps.shown();
    if (strip && id !== null) deps.registry.emit(id, NAV_KEY, event, payload);
  };

  return {
    capability: {
      functions: {
        async set(ctx, input) {
          const state = validateNavState(input);
          if (!state) return fail();
          states.set(ctx.profile.id, nativeState(state));
          draw(ctx.profile.id);
        },
      },
      events: ["onSelect", "onMenu"],
    },
    available: () => strip,
    stripChanged(visible) {
      if (visible === strip) return;
      strip = visible;
      for (const profile of deps.profiles()) deps.registry.refresh(profile.id);
    },
    sectionSelected(id) {
      if (!NAV_SECTION_ORDER.includes(id as NavSectionId)) return;
      emit("onSelect", id);
    },
    menuTapped() {
      emit("onMenu", null);
    },
    profileShown(profileId) {
      draw(profileId);
    },
  };
}

/** Registers `nav@1` on iOS; Android has no strip and never offers it (spec §6.1). */
export function registerNav<P extends ProfileRef>(
  registry: CapabilityRegistry<P>,
  platform: "ios" | "android",
  nav: Nav<P>,
): void {
  if (platform !== "ios") return;
  registry.register(NAV_KEY, nav.capability, { available: (profile) => nav.available(profile) });
}

/** The strip part of the `CapybaraHost` plugin (ShellPlugin.swift with StripHost.swift). */
export interface StripHostPlugin {
  /** Whether the window has a strip now (StripDetector). */
  stripState(): Promise<{ visible: boolean }>;
  navSet(options: { state: NavNativeState }): Promise<void>;
  addListener(
    eventName: "stripChanged" | "sectionSelected" | "menuTapped",
    listener: (e: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

/** A `NavNativePort` over the plugin. */
export function navNativeFrom(plugin: Pick<StripHostPlugin, "navSet">): NavNativePort {
  return { set: (state) => plugin.navSet({ state }) };
}

/** The strip as native reports it at start; false when native cannot say. */
export async function stripAtStart(plugin: Pick<StripHostPlugin, "stripState">): Promise<boolean> {
  try {
    return (await plugin.stripState()).visible === true;
  } catch {
    return false;
  }
}

/** Forwards native's strip events to `nav`; malformed events are ignored. Returns how to stop. */
export function connectStrip<P extends ProfileRef>(
  plugin: Pick<StripHostPlugin, "addListener">,
  nav: Pick<Nav<P>, "stripChanged" | "sectionSelected" | "menuTapped">,
): () => void {
  let stopped = false;
  const field = (e: unknown, key: string): unknown => (isRecord(e) ? e[key] : undefined);
  const handles = [
    plugin.addListener("stripChanged", (e) => {
      const visible = field(e, "visible");
      if (!stopped && typeof visible === "boolean") nav.stripChanged(visible);
    }),
    plugin.addListener("sectionSelected", (e) => {
      const id = field(e, "id");
      if (!stopped && typeof id === "string") nav.sectionSelected(id);
    }),
    plugin.addListener("menuTapped", () => {
      if (!stopped) nav.menuTapped();
    }),
  ];
  return () => {
    stopped = true;
    for (const handle of handles) handle.then((h) => h.remove()).catch(() => {});
  };
}
