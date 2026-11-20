// What a local page (app://local/<page>.html) receives from the main process and sends back.
// Shared by main, the local preload and the pages' runtime; no Electron imports.
import type { Appearance } from "./appearance.ts";
import type { Controls, ShellPlatform } from "./protocol.ts";

export type LocalLocale = "zh" | "en";

/** The platform a page is about: name and host from `/api/v1/meta`, the icon as a data: URL. */
export interface PagePlatform {
  name: string;
  host: string;
  /** `data:image/png|jpeg|webp;base64,…` fetched by main; never a remote URL. */
  iconUrl?: string;
}

/** The fields every page gets. A page's own fields sit next to them (`PageState<Extra>`). */
export interface BasePageState {
  /** Which view of the page to show (`connect`, `found`, `expired`, …). */
  page: string;
  locale: LocalLocale;
  appearance: Appearance;
  platform?: PagePlatform;
  /** The window controls' rectangle to keep clear of (desktop spec §7.3); null = none. */
  controls: Controls | null;
  os: ShellPlatform;
  /** The app's product name (`brand.productName`) and version, for the footer. */
  appName: string;
  version: string;
}

export type PageState<Extra extends object = Record<string, unknown>> = BasePageState & Extra;

export interface LocalActRequest {
  action: string;
  args?: Record<string, unknown>;
}

/** Errors travel as data: Electron drops a thrown Error's properties across IPC. */
export type LocalActResult = { ok: true; value: unknown } | { ok: false; error: LocalActError };

/**
 * `refused`: the sender is not a registered local page or the action is not allowed for its kind;
 * `invalid`: the arguments failed the action's check; `unavailable`: no handler is installed yet;
 * `failed`: the handler threw.
 */
export type LocalActError = "refused" | "invalid" | "unavailable" | "failed";

/** `window.capybaraLocal`, as the preload exposes it. */
export interface CapybaraLocal {
  state(): Promise<PageState>;
  /** Called with every state main pushes; returns an unsubscribe. */
  onState(cb: (state: PageState) => void): () => void;
  /** Resolves with the handler's value; rejects with an Error whose message is the error code. */
  act(action: string, args?: Record<string, unknown>): Promise<unknown>;
}
