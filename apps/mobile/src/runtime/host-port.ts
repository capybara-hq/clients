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
