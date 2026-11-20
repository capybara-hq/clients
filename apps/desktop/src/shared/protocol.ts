// The IPC protocol between the main process and the two preloads, plus the desktop's Shell
// environment values. Shared by main and preload code; no Electron imports.
import type { CapybaraShell, ShellCallError } from "@capybara-hq/plugin-sdk";

/** Channels of the deployment window's preload (the Shell environment). */
export const SHELL_CHANNELS = {
  /** Sync, at preload start: answers `ShellInit` or null (the frame gets nothing). */
  init: "capybara-shell:init",
  /** Invoke: one capability call, `ShellCallRequest` → `ShellCallResult`. */
  call: "capybara-shell:call",
  /** Main → preload: `ShellState` after insets, controls or capabilities changed. */
  change: "capybara-shell:change",
  /** Invoke: start one event subscription, `ShellSubscribeRequest` → boolean. */
  subscribe: "capybara-shell:subscribe",
  /** Send: end one subscription, `ShellUnsubscribeRequest`. */
  unsubscribe: "capybara-shell:unsubscribe",
  /** Main → preload: one event of a subscription, `ShellEventMessage`. */
  event: "capybara-shell:event",
} as const;

/** Channels of the address page's preload. It never sees the Shell environment. */
export const ADDRESS_CHANNELS = {
  /** Sync, at preload start: answers `AddressInit` or null. */
  init: "capybara-address:init",
  /** Invoke: `submit(address)` → `AddressResult`. */
  submit: "capybara-address:submit",
  /** Invoke: open the last discovered deployment → `AddressOpenResult`. */
  open: "capybara-address:open",
} as const;

/**
 * Channels of the local pages' preload (`window.capybaraLocal`): the small window, the main
 * window's error overlay and the shell dialogs. Never the Shell environment.
 */
export const LOCAL_CHANNELS = {
  /** Invoke: the page's current `PageState`, or null for a sender main does not know. */
  state: "capybara-local:state",
  /** Invoke: one page action, `LocalActRequest` → `LocalActResult`. */
  act: "capybara-local:act",
  /** Main → preload: a new `PageState` for the page. */
  push: "capybara-local:push",
} as const;

/** The app's own scheme: the address page (until K5 removes it) and the local pages. */
export const APP_SCHEME = "app";
export const ADDRESS_HOST = "address";
export const ADDRESS_ORIGIN = `${APP_SCHEME}://${ADDRESS_HOST}`;
export const ADDRESS_URL = `${ADDRESS_ORIGIN}/index.html`;
/** Local pages are flat files under one host: `app://local/<page>.html`. */
export const LOCAL_HOST = "local";
export const LOCAL_ORIGIN = `${APP_SCHEME}://${LOCAL_HOST}`;
/** The URL of a local page by its name (`onboarding` → `app://local/onboarding.html`). */
export function localPageUrl(page: string): string {
  return `${LOCAL_ORIGIN}/${page}.html`;
}

export type Insets = CapybaraShell["insets"];
export type Controls = { x: number; y: number; width: number; height: number };
export type ShellPlatform = "macos" | "windows" | "linux";

/** Key → function names; the preload builds callers from this list and nothing else. */
export type CapabilityDescriptors = Record<string, string[]>;

export interface ShellState {
  insets: Insets;
  controls: Controls | null;
  capabilities: CapabilityDescriptors;
  /**
   * Key → event names (`device@1.onStatus`): each becomes a function that takes a listener and
   * returns an unsubscribe. Absent when no capability offered has events.
   */
  events?: CapabilityDescriptors;
}

export interface ShellInit extends ShellState {
  /** The profile origin; the preload re-checks it against `location.origin`. */
  origin: string;
  platform: ShellPlatform;
  shellVersion: string;
}

export interface ShellCallRequest {
  key: string;
  fn: string;
  args: unknown[];
  /** `navigator.userActivation.isActive`, read by the preload at call time. */
  activation: boolean;
}

/**
 * One subscription of one document. `doc` is random per document (made by its preload), so main
 * can tell a new document of the same window from the old one and end the old one's subscriptions.
 */
export interface ShellSubscribeRequest {
  key: string;
  event: string;
  id: number;
  doc: string;
}

export interface ShellUnsubscribeRequest {
  id: number;
  doc: string;
}

export interface ShellEventMessage {
  doc: string;
  id: number;
  payload: unknown;
}

/** The shape of a document id: what the preload makes, and all main accepts. */
export const DOC_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

// A Record, so this fails to compile when the SDK adds a code it lacks.
const CALL_ERRORS: Record<ShellCallError, true> = {
  busy: true,
  no_activation: true,
  cancelled: true,
  failed: true,
};
/** Every `ShellCallError`, as a runtime list: the codes a call result may carry. */
export const SHELL_CALL_ERRORS: readonly ShellCallError[] = Object.keys(
  CALL_ERRORS,
) as ShellCallError[];

/** Errors are carried as data: Electron drops the properties of a thrown Error across IPC. */
export type ShellCallResult = { ok: true; value: unknown } | { ok: false; code: ShellCallError };

export type AddressErrorKind =
  | "invalid"
  | "insecure"
  | "unreachable"
  | "not_capybara"
  | "too_old"
  | "sign_in_unavailable"
  | "locked"
  | "failed";

export type AddressResult =
  | { ok: true; name: string; host: string; icon: string | null }
  | { ok: false; error: AddressErrorKind };

export type AddressOpenResult = { ok: true } | { ok: false; error: AddressErrorKind };

export interface AddressInit {
  locale: "zh" | "en";
  strings: Record<string, string>;
  /** An address to prefill (a `capybara://connect` link); never submitted on its own. */
  prefill: string | null;
}

/** macOS with `titleBarStyle: "hiddenInset"` (desktop spec §7.3). */
export const DESKTOP_INSETS: Insets = { top: 28, right: 0, bottom: 0, left: 0 };
/** The traffic lights' rectangle at `TRAFFIC_LIGHT_POSITION`, margins included. */
export const DESKTOP_CONTROLS: Controls = { x: 0, y: 0, width: 80, height: 28 };
/** The fixed traffic light position the controls rectangle is measured for. */
export const TRAFFIC_LIGHT_POSITION = { x: 12, y: 8 } as const;

/** Insets and controls for a window: fullscreen hides the title bar band and the controls. */
export function chromeState(
  platform: ShellPlatform,
  fullscreen: boolean,
): { insets: Insets; controls: Controls | null } {
  if (platform !== "macos" || fullscreen) {
    return { insets: { ...DESKTOP_INSETS, top: 0 }, controls: null };
  }
  return { insets: { ...DESKTOP_INSETS }, controls: { ...DESKTOP_CONTROLS } };
}

export function platformFrom(nodePlatform: string): ShellPlatform {
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "win32") return "windows";
  return "linux";
}
