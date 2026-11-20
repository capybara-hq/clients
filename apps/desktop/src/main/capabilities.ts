// The capabilities of this task (spec §8): notify@1, openExternal@1, chrome@1. Each function gets
// the caller's context first and validates the page's arguments itself; a refusal is
// `{ code: "failed" }`. Electron objects come in as parameters.
import {
  type Appearance,
  electronColor,
  isColor,
  overlayColors,
  type Tokens,
  validTokens,
} from "./appearance.ts";
import type { CallContext } from "./ipc.ts";
import type { Profile } from "./profiles.ts";

const failed = () => ({ code: "failed" as const });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolves an absolute path (`/…`) on `origin`; null when it is not one or would leave the origin
 * (`//host`, `/\host`, which browsers read as another host).
 */
export function sameOriginUrl(path: string, origin: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  try {
    const u = new URL(path, origin);
    return u.origin === origin ? u.href : null;
  } catch {
    return null;
  }
}

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
      }
      if (singleScheme !== undefined && typeof singleScheme !== "boolean") throw failed();
      const appearance: Appearance = {
        scheme,
        ...(tokens ? { tokens } : {}),
        ...(singleScheme === true ? { singleScheme: true } : {}),
      };
      // The macOS window appearance is app-wide (nativeTheme): only the window's own colors follow.
      const bg = electronColor(tokens?.bg ?? background);
      if (bg) ctx.window.setBackgroundColor(bg);
      try {
        ctx.window.setTitleBarOverlay?.(overlayColors(appearance));
      } catch {
        // No overlay on this window (macOS, or a window opened without one).
      }
      deps.onReport?.(ctx.profile, appearance);
    },
  };
}
