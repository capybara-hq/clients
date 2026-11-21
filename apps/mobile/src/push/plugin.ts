// `PushNative` over the Capacitor plugin `CapybaraPush` (iOS: Push/PushBridge.swift; Android:
// push/PushModule.kt). The plugin lives on the bridge of the app's local pages: only this runtime
// calls it, and a profile page reaches push only as `push@1` through the shell's gated handler. Answers of the wrong shape count
// as nothing (a permission that is not one of the three is `denied`, a token that is not a
// non-empty string is a rejection); events that are not objects are dropped.
//
// Plugin surface (the same on every platform that implements it):
//   permission() / requestPermission() -> { permission }   token({ provider }) -> { token }
//   present({ title, body, data })                          googlePlayServices() -> { available }
//   events: "foreground" (data), "tap" (data, held until the first listener), "token" ({ provider, token })
import type { PushPermission } from "@capybara-hq/plugin-sdk";
import type { PushNative } from "./native.ts";

export const PUSH_PLUGIN_NAME = "CapybaraPush";

type Handle = Promise<{ remove(): Promise<void> }>;

/** The plugin's JavaScript surface, as `registerPlugin<PushPlugin>(PUSH_PLUGIN_NAME)` gives it. */
export interface PushPlugin {
  permission(): Promise<unknown>;
  requestPermission(): Promise<unknown>;
  token(options: { provider: string }): Promise<unknown>;
  present(options: { title: string; body: string; data: Record<string, unknown> }): Promise<void>;
  googlePlayServices(): Promise<unknown>;
  addListener(eventName: "foreground" | "tap" | "token", listener: (e: unknown) => void): Handle;
}

const PERMISSIONS: readonly string[] = ["granted", "denied", "prompt"];

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function permissionOf(answer: unknown): PushPermission {
  const p = record(answer)?.permission;
  return typeof p === "string" && PERMISSIONS.includes(p) ? (p as PushPermission) : "denied";
}

function listen(
  plugin: PushPlugin,
  event: "foreground" | "tap" | "token",
  cb: (e: Record<string, unknown>) => void,
) {
  let removed = false;
  const handle = plugin.addListener(event, (e) => {
    const data = record(e);
    if (!removed && data) cb(data);
  });
  return () => {
    removed = true;
    handle.then((h) => h.remove()).catch(() => {});
  };
}

export function pushNativeFrom(plugin: PushPlugin): PushNative {
  return {
    permission: async () => permissionOf(await plugin.permission()),
    requestPermission: async () => permissionOf(await plugin.requestPermission()),
    async token(provider) {
      const token = record(await plugin.token({ provider }))?.token;
      // The message never carries the answer: it may be a token of the wrong shape.
      if (typeof token !== "string" || token.length === 0) throw new Error("no push token");
      return token;
    },
    onToken: (cb) =>
      listen(plugin, "token", (e) => {
        if (typeof e.provider === "string" && typeof e.token === "string") cb(e.provider, e.token);
      }),
    onForeground: (cb) => listen(plugin, "foreground", cb),
    onTap: (cb) => listen(plugin, "tap", cb),
    present: (data) => plugin.present(data),
    googlePlayServices: async () => record(await plugin.googlePlayServices())?.available === true,
  };
}
