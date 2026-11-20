// The TypeScript-facing native contract: the Capacitor plugin `CapybaraHost` (ShellPlugin.swift,
// ShellPlugin.kt). Native forwards each gated call as a `call` event; the runtime answers with
// `reply`, and sends state changes and capability events to a profile's current document.
import type { ShellState } from "@capybara-hq/shell";
import { isShellCallMessage, type ShellCallMessage, type ShellCallResult } from "./protocol.ts";

export interface HostPort {
  onCall(listener: (msg: ShellCallMessage) => void): () => void;
  reply(profileId: string, callId: string, result: ShellCallResult): Promise<void>;
  /** A `change` for the profile's current document. */
  pushState(profileId: string, state: ShellState): Promise<void>;
  event(profileId: string, key: string, event: string, payload: unknown): Promise<void>;
}

/** The plugin's JavaScript surface, as `registerPlugin<CapybaraHostPlugin>("CapybaraHost")` gives it. */
export interface CapybaraHostPlugin {
  addListener(
    eventName: "call",
    listener: (msg: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
  reply(options: { profileId: string; callId: string; result: ShellCallResult }): Promise<void>;
  pushState(options: { profileId: string; state: ShellState }): Promise<void>;
  event(options: {
    profileId: string;
    key: string;
    event: string;
    payload: unknown;
  }): Promise<void>;
}

export const HOST_PLUGIN_NAME = "CapybaraHost";

/** A `HostPort` over the plugin. Events that are not a well-formed call message are ignored. */
export function createHostPort(plugin: CapybaraHostPlugin): HostPort {
  return {
    onCall(listener) {
      let removed = false;
      const handle = plugin.addListener("call", (msg) => {
        if (!removed && isShellCallMessage(msg)) listener(msg);
      });
      return () => {
        removed = true;
        handle.then((h) => h.remove()).catch(() => {});
      };
    },
    reply: (profileId, callId, result) => plugin.reply({ profileId, callId, result }),
    pushState: (profileId, state) => plugin.pushState({ profileId, state }),
    event: (profileId, key, event, payload) => plugin.event({ profileId, key, event, payload }),
  };
}

// ---- Profile WebViews: opening, loading, documents and appearance (Task 16) ----

/** What native reports about the shown profile WebView's main-frame loads. */
export type LoadEvent =
  /** The main-frame load finished, whatever the HTTP status (a 500 page stays in the WebView). */
  | { profileId: string; type: "didFinish"; status?: number }
  /**
   * The main frame failed before anything committed (DNS, connection, TLS): no page to show.
   * `code` is native's error for the error page (`ERR_NAME_NOT_RESOLVED`,
   * `NSURLErrorDomain:-1202`); `tls` marks a certificate or TLS failure (there is never a way to
   * proceed past one).
   */
  | { profileId: string; type: "didFailProvisional"; code: string; tls: boolean }
  /** The web content process died (Android recreates the WebView, R11). */
  | { profileId: string; type: "processGone" };

/**
 * A profile document said hello through the gate (`opened`), or the current one ended: a
 * main-frame navigation committed, the web process died, or the WebView went away (`ended`).
 */
export interface DocumentEvent {
  profileId: string;
  docId: string;
  state: "opened" | "ended";
}

export interface OpenProfileRequest {
  profileId: string;
  origin: string;
  base: string;
  dataStoreId: string;
  /** The document-start init: insets, capabilities and events. */
  state: ShellState;
}

/** The profile WebView host on the native side (also the `CapybaraHost` plugin). */
export interface ProfileHostPort {
  /** Shows the profile's WebView (created on first use) and loads its base. */
  open(req: OpenProfileRequest): Promise<void>;
  /** Hides the profile's WebView so the local error state shows instead of its page. */
  showError(profileId: string): Promise<void>;
  /** The background behind the profile's WebView and the status bar style. */
  setAppearance(
    profileId: string,
    look: { background: string; statusBar: "light" | "dark" },
  ): Promise<void>;
  onLoad(listener: (e: LoadEvent) => void): () => void;
  onDocument(listener: (e: DocumentEvent) => void): () => void;
}

export interface ProfileHostPlugin {
  addListener(
    eventName: "load" | "document",
    listener: (e: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
  open(options: OpenProfileRequest): Promise<void>;
  showError(options: { profileId: string }): Promise<void>;
  setAppearance(options: {
    profileId: string;
    background: string;
    statusBar: "light" | "dark";
  }): Promise<void>;
}

function isLoadEvent(v: unknown): v is LoadEvent {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.profileId !== "string") return false;
  if (r.type === "didFinish" || r.type === "processGone") return true;
  return (
    r.type === "didFailProvisional" && typeof r.code === "string" && typeof r.tls === "boolean"
  );
}

function isDocumentEvent(v: unknown): v is DocumentEvent {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.profileId === "string" &&
    typeof r.docId === "string" &&
    (r.state === "opened" || r.state === "ended")
  );
}

function listen<T>(
  plugin: ProfileHostPlugin,
  name: "load" | "document",
  guard: (v: unknown) => v is T,
  listener: (e: T) => void,
): () => void {
  let removed = false;
  const handle = plugin.addListener(name, (e) => {
    if (!removed && guard(e)) listener(e);
  });
  return () => {
    removed = true;
    handle.then((h) => h.remove()).catch(() => {});
  };
}

/** A `ProfileHostPort` over the plugin. Malformed events are ignored. */
export function createProfileHostPort(plugin: ProfileHostPlugin): ProfileHostPort {
  return {
    open: (req) => plugin.open(req),
    showError: (profileId) => plugin.showError({ profileId }),
    setAppearance: (profileId, look) => plugin.setAppearance({ profileId, ...look }),
    onLoad: (listener) => listen(plugin, "load", isLoadEvent, listener),
    onDocument: (listener) => listen(plugin, "document", isDocumentEvent, listener),
  };
}
