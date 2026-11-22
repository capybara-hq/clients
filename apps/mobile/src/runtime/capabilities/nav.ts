// `nav@1` (mobile app spec §5.2, §6.1; interaction model §10, minor version of 2026-11-22): the
// iPhone Duo's strip navigation. iOS only, and offered exactly while the window has a strip, so
// its presence is the strip's visibility: native reports the strip and its side (`stripChanged`),
// the registry re-evaluates and the page gets one `change`. The web hands the pill's items (the
// sections and search), its top item (the action) and the account avatar with `set`; the shell
// draws them with its own glyph per id / icon (StripHost.swift) and tells the shown profile's page
// about taps (`onSelect`, the current section and search included; `onAction`; `onAccount`). The
// capability object carries the strip's `side`. No menu button (D12). Not confirming, no
// activation.
//
// Lockstep: the web sends exactly this shape and the shell takes nothing else (no older-web path
// before 0.1.0). The types and limits are the SDK's (`NavStateV1`, `NAV_SECTION_ORDER`,
// `MOBILE_SHELL_LIMITS`); the shell still validates every input at run time.
import {
  MENU_ITEM_ID,
  MOBILE_SHELL_LIMITS,
  NAV_SECTION_ORDER,
  type NavAccountV1,
  type NavActionV1,
  type NavCapabilityV1,
  type NavItemV1,
  type NavSectionId,
  type NavStateV1,
  SHELL_CAPABILITY_KEYS,
} from "@capybara-hq/plugin-sdk";
import type { ProfileRef } from "../protocol.ts";
import type { CapabilityImpl, CapabilityRegistry } from "../registry.ts";
import { fail, isRecord, onlyKeys } from "./limits.ts";

export const NAV_KEY = SHELL_CAPABILITY_KEYS.nav;

/** The pill's items in display order: the sections and, last, `search`. */
export const NAV_ITEM_ORDER = NAV_SECTION_ORDER;
/** What `current` may name: a section, never `search`. */
export type NavCurrentId = Exclude<NavSectionId, "search">;
export type StripSide = NonNullable<NavCapabilityV1["side"]>;

/** `nav@1.set`'s input once validated: `current` is never `search`. */
export type NavState = Omit<NavStateV1, "current"> & {
  /** The section on screen; null: none (the highlight is cleared, the person is on the action). */
  current: NavCurrentId | null;
};

/**
 * The SDK's `nav@1` limits (`navLabel`, `navCount`, `navAccountName`, `url`), plus the account
 * initial's length, which the SDK states only in prose (1..2 characters).
 */
export const NAV_LIMITS = {
  label: MOBILE_SHELL_LIMITS.navLabel,
  count: MOBILE_SHELL_LIMITS.navCount,
  accountName: MOBILE_SHELL_LIMITS.navAccountName,
  initial: 2,
  url: MOBILE_SHELL_LIMITS.url,
} as const;

/** What the native strip draws: OS badge text, the avatar URL already checked. */
export interface NavNativeState {
  items: { id: NavSectionId; label: string; badge: string | null }[];
  /** Null: no section is highlighted (coordinator ruling 2026-11-22). */
  current: NavCurrentId | null;
  /** Null only before the page's first `set` (the strip then shows nothing). */
  action: NavActionV1 | null;
  account: { name: string; avatarUrl: string | null; initial: string; badge: string | null } | null;
}

/** The native strip (`StripHost` through the `CapybaraHost` plugin). */
export interface NavNativePort {
  set(state: NavNativeState): Promise<void>;
}

/** Characters as the web counts them (code points), so an emoji is one, not two. */
const length = (s: string) => Array.from(s).length;

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const n = length(v);
  return n > 0 && n <= max ? v : null;
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= NAV_LIMITS.count ? v : null;
}

function badge(v: Record<string, unknown>): { count?: number; countMore?: boolean } | null {
  const out: { count?: number; countMore?: boolean } = {};
  if (v.count !== undefined) {
    const n = count(v.count);
    if (n === null) return null;
    out.count = n;
  }
  if (v.countMore !== undefined) {
    if (typeof v.countMore !== "boolean") return null;
    out.countMore = v.countMore;
  }
  return out;
}

/**
 * The avatar's URL: absolute, at most `NAV_LIMITS.url` characters, https from anywhere or plain
 * http on the profile's own origin. Undefined when it is not one (the call then fails).
 */
function avatarUrl(raw: unknown, origin: string): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > NAV_LIMITS.url) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && url.origin === origin)) {
    return url.href.length > NAV_LIMITS.url ? undefined : url.href;
  }
  return undefined;
}

function account(raw: unknown, origin: string): NavAccountV1 | null {
  if (!isRecord(raw) || !onlyKeys(raw, ["name", "avatarUrl", "initial", "badge"])) return null;
  const name = text(raw.name, NAV_LIMITS.accountName);
  const initial = text(raw.initial, NAV_LIMITS.initial);
  if (name === null || initial === null) return null;
  const out: NavAccountV1 = { name, initial };
  if (raw.avatarUrl !== undefined) {
    if (raw.avatarUrl === null) out.avatarUrl = null;
    else {
      const url = avatarUrl(raw.avatarUrl, origin);
      if (url === undefined) return null;
      out.avatarUrl = url;
    }
  }
  if (raw.badge !== undefined) {
    const n = count(raw.badge);
    if (n === null) return null;
    out.badge = n;
  }
  return out;
}

function action(raw: unknown): NavActionV1 | null {
  if (!isRecord(raw) || !onlyKeys(raw, ["id", "label", "icon"])) return null;
  if (typeof raw.id !== "string" || !MENU_ITEM_ID.test(raw.id)) return null;
  const label = text(raw.label, NAV_LIMITS.label);
  if (label === null) return null;
  if (raw.icon !== "plus" && raw.icon !== "square-pen") return null;
  return { id: raw.id, label, icon: raw.icon };
}

/**
 * The page's `set` input as a `NavState`, or null when anything is off (the call then fails):
 * exactly `items`, `current`, `action` and an optional `account` (no `menu`); the items known,
 * each once, in `NAV_ITEM_ORDER`; `current` null or a section among them, never `search`.
 * `origin` is the profile's: the only origin a plain http avatar may come from.
 */
export function validateNavState(input: unknown, origin: string): NavState | null {
  if (!isRecord(input) || !onlyKeys(input, ["items", "current", "action", "account"])) return null;
  if (!("items" in input) || !("current" in input) || !("action" in input)) return null;
  const { items, current } = input;
  if (!Array.isArray(items) || items.length > NAV_ITEM_ORDER.length) return null;
  const parsed: NavItemV1[] = [];
  let last = -1;
  for (const raw of items) {
    if (!isRecord(raw) || !onlyKeys(raw, ["id", "label", "count", "countMore"])) return null;
    const order = NAV_ITEM_ORDER.indexOf(raw.id as NavSectionId);
    // Known ids only, each once, in NAV_ITEM_ORDER.
    if (order <= last) return null;
    last = order;
    const label = text(raw.label, NAV_LIMITS.label);
    const counts = badge(raw);
    if (label === null || counts === null) return null;
    parsed.push({ id: raw.id as NavSectionId, label, ...counts });
  }
  let section: NavCurrentId | null = null;
  if (current !== null) {
    if (current === "search" || !parsed.some((item) => item.id === current)) return null;
    section = current as NavCurrentId;
  }
  const top = action(input.action);
  if (top === null) return null;
  const out: NavState = { items: parsed, current: section, action: top };
  if (input.account !== undefined) {
    const who = account(input.account, origin);
    if (who === null) return null;
    out.account = who;
  }
  return out;
}

/** The OS badge text: none for 0 or no count, `99+` above 99, `N+` when the count is a floor. */
export function badgeText(b: { count?: number; countMore?: boolean }): string | null {
  const n = b.count ?? 0;
  if (n <= 0) return null;
  if (n > 99) return "99+";
  return b.countMore ? `${n}+` : String(n);
}

function nativeState(state: NavState): NavNativeState {
  return {
    items: state.items.map((item) => ({ id: item.id, label: item.label, badge: badgeText(item) })),
    current: state.current,
    action: { ...state.action },
    account: state.account
      ? {
          name: state.account.name,
          avatarUrl: state.account.avatarUrl ?? null,
          initial: state.account.initial,
          badge: badgeText({ count: state.account.badge ?? 0 }),
        }
      : null,
  };
}

/** What native reports about the strip: whether the window has one, and on which edge. */
export interface StripReport {
  visible: boolean;
  side: StripSide;
}

export interface NavDeps<P extends ProfileRef> {
  registry: CapabilityRegistry<P>;
  native: NavNativePort;
  /** The profiles the registry knows: each is refreshed when the strip comes, goes or moves. */
  profiles(): P[];
  /** The profile whose WebView is on screen (the strip belongs to it), or null. */
  shown(): string | null;
  /** The strip as native reported it at start (a boolean: on the right). */
  strip: boolean | StripReport;
}

export interface Nav<P extends ProfileRef> {
  capability: CapabilityImpl<P>;
  available(profile: P): boolean;
  /**
   * Native: the window gained or lost its strip, or the strip moved to the other edge (an
   * inner-display split). `side` left out keeps the one known.
   */
  stripChanged(visible: boolean, side?: StripSide): void;
  /** Native: an item was tapped (the selected section and search too). */
  sectionSelected(id: string): void;
  /** Native: the pill's top item was tapped. */
  actionTapped(): void;
  /** Native: the account avatar was tapped. */
  accountTapped(): void;
  /**
   * The runtime showed this profile: the strip draws what its page last set, or nothing until it
   * sets it.
   */
  profileShown(profileId: string): void;
}

const EMPTY: NavNativeState = { items: [], current: null, action: null, account: null };

export const NAV_EVENTS = ["onSelect", "onAction", "onAccount"] as const;

export function createNav<P extends ProfileRef>(deps: NavDeps<P>): Nav<P> {
  const start: StripReport =
    typeof deps.strip === "boolean" ? { visible: deps.strip, side: "right" } : deps.strip;
  let strip = start.visible;
  let side: StripSide = start.side;
  // Profile id -> what its page last set; drawn when that profile is the one shown.
  const states = new Map<string, NavNativeState>();

  const draw = (profileId: string) => {
    const state = states.get(profileId);
    if (state && deps.shown() === profileId) deps.native.set(state).catch(() => {});
  };
  const emit = (event: (typeof NAV_EVENTS)[number], payload: unknown) => {
    const id = deps.shown();
    if (strip && id !== null) deps.registry.emit(id, NAV_KEY, event, payload);
  };

  return {
    capability: {
      functions: {
        async set(ctx, input) {
          const state = validateNavState(input, ctx.profile.origin);
          if (!state) return fail();
          states.set(ctx.profile.id, nativeState(state));
          draw(ctx.profile.id);
        },
      },
      events: NAV_EVENTS,
      fields: () => ({ side }),
    },
    available: () => strip,
    stripChanged(visible, next) {
      const moved = next !== undefined && next !== side;
      if (visible === strip && !moved) return;
      strip = visible;
      if (next !== undefined) side = next;
      for (const profile of deps.profiles()) deps.registry.refresh(profile.id);
    },
    sectionSelected(id) {
      if (!NAV_ITEM_ORDER.includes(id as NavSectionId)) return;
      emit("onSelect", id);
    },
    actionTapped() {
      emit("onAction", null);
    },
    accountTapped() {
      emit("onAccount", null);
    },
    profileShown(profileId) {
      // A removed profile's state goes with it (an id is never trusted to mean the same page).
      const known = new Set(deps.profiles().map((p) => p.id));
      for (const id of [...states.keys()]) if (!known.has(id)) states.delete(id);
      if (deps.shown() !== profileId) return;
      // A page that has not set its state yet (still loading) gets an empty strip: never the
      // previous profile's labels, badges and avatar over this profile's page.
      deps.native.set(states.get(profileId) ?? EMPTY).catch(() => {});
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
  /** Whether the window has a strip now and its edge (StripDetector). */
  stripState(): Promise<{ visible: boolean; side?: StripSide }>;
  navSet(options: { state: NavNativeState }): Promise<void>;
  addListener(
    eventName: "stripChanged" | "sectionSelected" | "actionTapped" | "accountTapped",
    listener: (e: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

/** A `NavNativePort` over the plugin. */
export function navNativeFrom(plugin: Pick<StripHostPlugin, "navSet">): NavNativePort {
  return { set: (state) => plugin.navSet({ state }) };
}

const sideOf = (v: unknown): StripSide | undefined =>
  v === "left" || v === "right" ? v : undefined;

/** The strip as native reports it at start; none (on the right) when native cannot say. */
export async function stripAtStart(
  plugin: Pick<StripHostPlugin, "stripState">,
): Promise<StripReport> {
  try {
    const state = await plugin.stripState();
    return { visible: state.visible === true, side: sideOf(state.side) ?? "right" };
  } catch {
    return { visible: false, side: "right" };
  }
}

/** Forwards native's strip events to `nav`; malformed events are ignored. Returns how to stop. */
export function connectStrip<P extends ProfileRef>(
  plugin: Pick<StripHostPlugin, "addListener">,
  nav: Pick<Nav<P>, "stripChanged" | "sectionSelected" | "actionTapped" | "accountTapped">,
): () => void {
  let stopped = false;
  const field = (e: unknown, key: string): unknown => (isRecord(e) ? e[key] : undefined);
  const handles = [
    plugin.addListener("stripChanged", (e) => {
      const visible = field(e, "visible");
      if (stopped || typeof visible !== "boolean") return;
      const side = sideOf(field(e, "side"));
      if (side === undefined) nav.stripChanged(visible);
      else nav.stripChanged(visible, side);
    }),
    plugin.addListener("sectionSelected", (e) => {
      const id = field(e, "id");
      if (!stopped && typeof id === "string") nav.sectionSelected(id);
    }),
    plugin.addListener("actionTapped", () => {
      if (!stopped) nav.actionTapped();
    }),
    plugin.addListener("accountTapped", () => {
      if (!stopped) nav.accountTapped();
    }),
  ];
  return () => {
    stopped = true;
    for (const handle of handles) handle.then((h) => h.remove()).catch(() => {});
  };
}
