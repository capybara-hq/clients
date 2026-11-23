// The IPC protocol between the main process and the preloads, plus the desktop's Shell
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

/** The app's own scheme: the local pages. */
export const APP_SCHEME = "app";
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
   * Key → event names (`name@major.event`): each becomes a function that takes a listener and
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

/**
 * The main window's top row (desktop spec §7.3): the web runs to the window's top edge and its
 * first row (the sidebar's brand row, the conversation title bar) is as high as the controls
 * rectangle the shell reports; 48 is design's `layout.title-bar`.
 */
export const MAIN_TOP_ROW = 48;
/**
 * macOS: the traffic lights at the main window's top left, vertically centred in the top row
 * (the buttons are 14 high: (48 - 14) / 2 = 17).
 */
export const MAIN_TRAFFIC_LIGHT_POSITION = { x: 16, y: 17 } as const;
/**
 * The traffic lights' rectangle in the main window: from the window's top-left corner, as high as
 * the top row and as wide as the lights (60) with their left margin repeated on the right.
 */
export const MAIN_CONTROLS: Controls = { x: 0, y: 0, width: 92, height: MAIN_TOP_ROW };
/** The main window reports no inset: no title bar band (desktop spec §7.3). */
export const MAIN_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The small window: `titleBarStyle: "hiddenInset"`, the lights at their fixed position. */
export const SMALL_TRAFFIC_LIGHT_POSITION = { x: 12, y: 8 } as const;
/** The traffic lights' rectangle in the small window, margins included. */
export const SMALL_CONTROLS: Controls = { x: 0, y: 0, width: 80, height: 28 };

/**
 * Insets and controls for a main window: macOS reports the traffic lights in the top row,
 * fullscreen hides them; Windows and Linux keep the system title bar for now (nothing to report).
 */
export function chromeState(
  platform: ShellPlatform,
  fullscreen: boolean,
): { insets: Insets; controls: Controls | null } {
  if (platform !== "macos" || fullscreen) return { insets: { ...MAIN_INSETS }, controls: null };
  return { insets: { ...MAIN_INSETS }, controls: { ...MAIN_CONTROLS } };
}

export function platformFrom(nodePlatform: string): ShellPlatform {
  if (nodePlatform === "darwin") return "macos";
  if (nodePlatform === "win32") return "windows";
  return "linux";
}
