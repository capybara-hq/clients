// The capabilities of this task (spec §8): notify@1, openExternal@1, chrome@1. Each function gets
// the caller's context first and validates the page's arguments itself; a refusal is
// `{ code: "failed" }`. Electron objects come in as parameters.
import { isRecord, sameOriginUrl } from "@capybara-hq/shell";
import {
  type Appearance,
  electronColor,
  isColor,
  isOpaque,
  overlayColors,
  sameAppearance,
  type Tokens,
  validTokens,
} from "./appearance.ts";
import type { CallContext, CapabilityOptions } from "./ipc.ts";
import type { Profile } from "./profiles.ts";

const failed = () => ({ code: "failed" as const });

export const NOTIFY_LIMITS = { title: 1000, body: 4000 } as const;

export interface NotificationLike {
  on(event: "click" | "close", listener: () => void): unknown;
  show(): void;
}

export interface NotificationClass {
  new (options: { title: string; body: string; silent?: boolean }): NotificationLike;
  isSupported(): boolean;
}

export function createNotifyCapability(deps: {
  Notification: NotificationClass;
  /** Focuses the profile's window (opening one when none is open), then loads `url` if given. */
  showProfile(profile: Profile, url?: string): void;
}) {
  // Keep a reference until the notification is clicked or closed: macOS loses the click of a
  // notification that was garbage-collected.
  const live = new Set<NotificationLike>();
  return {
    async notify(ctx: CallContext, input: unknown): Promise<void> {
      if (!isRecord(input)) throw failed();
      const { title, body, path } = input;
      if (typeof title !== "string" || typeof body !== "string") throw failed();
      if (title.length > NOTIFY_LIMITS.title || body.length > NOTIFY_LIMITS.body) throw failed();
      let url: string | undefined;
      if (path !== undefined) {
        if (typeof path !== "string") throw failed();
        const resolved = sameOriginUrl(path, ctx.profile.origin);
        if (resolved === null) throw failed();
        url = resolved;
      }
      if (!deps.Notification.isSupported()) throw failed();
      const n = new deps.Notification({ title, body });
      live.add(n);
      const profile = ctx.profile;
      n.on("click", () => {
        live.delete(n);
        deps.showProfile(profile, url);
      });
      n.on("close", () => live.delete(n));
      n.show();
    },
  };
}

export function createOpenExternalCapability(deps: { openExternal(url: string): Promise<void> }) {
  return {
    async open(_ctx: CallContext, url: unknown): Promise<void> {
      if (typeof url !== "string") throw failed();
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw failed();
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw failed();
      await deps.openExternal(u.href);
    },
  };
}

/**
 * openExternal@1's registration options: `returnScheme`, the app's own scheme (the one in its
 * `<scheme>://auth/callback`), so the web can ask for a handoff that comes back to the app (shell
 * external authorization spec §5).
 */
export function openExternalOptions(returnScheme: string): CapabilityOptions {
  return { fields: { returnScheme } };
}

export interface ChromeContext extends CallContext {
  window: {
    setBackgroundColor(color: string): void;
    /** Windows / Linux, a window with a title bar overlay only (Electron throws otherwise). */
    setTitleBarOverlay?(o: { color: string; symbolColor: string }): void;
  };
}

export interface ChromeDeps {
  /**
   * The profile's report, validated: main stores it on the profile and repaints that profile's
   * local pages and small window (desktop spec §6.10).
   */
  onReport?(profile: Profile, appearance: Appearance): void;
  /** The profile's stored report: an equal one is not reported again (the web sends one per load). */
  stored?(profileId: string): Appearance | undefined;
}

/**
 * chrome@1 (layout spec §9.2, desktop spec §6.10): `{ scheme, background, tokens?, singleScheme? }`.
 * Every color is checked with `isColor` (a hex or `rgb()` / `rgba()`); tokens are all seven or the
 * call fails, never a partial set. The window background is `tokens.bg`, else `background`, handed
 * to Electron as `#rrggbb`.
 */
export function createChromeCapability(deps: ChromeDeps = {}) {
  return {
    async setAppearance(ctx: ChromeContext, input: unknown): Promise<void> {
      if (!isRecord(input)) throw failed();
      const { scheme, background, tokens: rawTokens, singleScheme } = input;
      if (scheme !== "light" && scheme !== "dark") throw failed();
      if (!isColor(background)) throw failed();
      let tokens: Tokens | undefined;
      if (rawTokens !== undefined) {
        tokens = validTokens(rawTokens);
        if (!tokens) throw failed();
        // A see-through token could hide text on the local pages: the set is dropped (the call
        // still succeeds; the pages use the built-in colors of the scheme).
        if (!Object.values(tokens).every(isOpaque)) tokens = undefined;
      }
      if (singleScheme !== undefined && typeof singleScheme !== "boolean") throw failed();
      const appearance: Appearance = {
        scheme,
        ...(tokens ? { tokens } : {}),
        ...(singleScheme === true ? { singleScheme: true } : {}),
      };
      // The macOS window appearance is app-wide (nativeTheme): only the window's own colors follow.
      // A see-through background is not applied to the window (Electron drops the alpha).
      const ground = tokens?.bg ?? background;
      const bg = isOpaque(ground) ? electronColor(ground) : undefined;
      if (bg) ctx.window.setBackgroundColor(bg);
      try {
        ctx.window.setTitleBarOverlay?.(overlayColors(appearance));
      } catch {
        // No overlay on this window (macOS, or a window opened without one).
      }
      if (sameAppearance(deps.stored?.(ctx.profile.id), appearance)) return;
      deps.onReport?.(ctx.profile, appearance);
    },
  };
}
