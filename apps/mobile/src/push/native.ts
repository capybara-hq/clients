// The TypeScript-facing contract of the native push module (core spec §9, mobile spec §5.2). iOS
// implements it over APNs (Task K2), Android over FCM and the JPush aggregator SDK (Task K3); the
// runtime builds on `unsupportedPushNative` until a native module is wired in, and tests use fakes.
//
// A push token is never logged, kept in an error message or written to preferences by either side.
import type { PushPermission } from "@capybara-hq/plugin-sdk";

export interface PushNative {
  /** The OS notification permission now, without asking. */
  permission(): Promise<PushPermission>;
  /** Shows the OS prompt when the permission is `prompt`; resolves the permission after it. */
  requestPermission(): Promise<PushPermission>;
  /**
   * The OS / vendor token of this install for `provider` (`push-apns`, `push-fcm`, `push-jpush`);
   * rejects when the channel cannot give one (not carried, no Play services, no network).
   */
  token(provider: string): Promise<string>;
  /** The channel rotated its token. Returns how to stop listening. */
  onToken(cb: (provider: string, token: string) => void): () => void;
  /**
   * A push arrived while the app is in the foreground and the OS did not show it: its data
   * (`origin`, `path`, `threadId`) with its `title` and `body`. Returns how to stop listening.
   */
  onForeground(cb: (data: Record<string, unknown>) => void): () => void;
  /**
   * The person tapped a push (also the one that launched the app: native holds it until the
   * first listener attaches). Returns how to stop listening.
   */
  onTap(cb: (data: Record<string, unknown>) => void): () => void;
  /** Shows a banner for a foreground push; tapping it reports `onTap` with `data`. */
  present(data: { title: string; body: string; data: Record<string, unknown> }): Promise<void>;
  /** Android: whether Google Play services are usable. iOS resolves false. */
  googlePlayServices(): Promise<boolean>;
}

const unsupported = () => Promise.reject(new Error("push is not supported by this build"));

/** No native push module: never granted, no token, no events. */
export const unsupportedPushNative: PushNative = {
  permission: async () => "denied",
  requestPermission: async () => "denied",
  token: unsupported,
  onToken: () => () => {},
  onForeground: () => () => {},
  onTap: () => () => {},
  present: unsupported,
  googlePlayServices: async () => false,
};

/**
 * The push methods of the `CapybaraHost` plugin (ShellPlugin.swift / ShellPlugin.kt, K2 / K3):
 * the profile WebView side the runtime needs for removal and foreground suppression.
 */
export interface PushHostNative {
  /**
   * `fetch(url, { method: "DELETE", credentials: "include" })` from the profile WebView's top
   * document, like `signInRevoke`: only while that document is on the profile's origin and only
   * for `<origin>/…/api/v1/me/push-registrations/<id>`; rejects otherwise or when the profile has
   * no WebView.
   */
  pushDeleteRegistration(options: { profileId: string; url: string }): Promise<unknown>;
  /** The profile WebView's current URL (`{ url }`), or `{}` when it has none. */
  currentUrl(options: { profileId: string }): Promise<unknown>;
}

/** The profile WebView's current URL over the plugin; null when it cannot say. */
export async function currentUrlFrom(
  native: Pick<PushHostNative, "currentUrl">,
  profileId: string,
): Promise<string | null> {
  try {
    const answer = await native.currentUrl({ profileId });
    const url =
      typeof answer === "object" && answer !== null ? (answer as { url?: unknown }).url : null;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}
