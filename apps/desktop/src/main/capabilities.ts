// The capabilities of this task (spec §8): notify@1, openExternal@1, chrome@1. Each function gets
// the caller's context first and validates the page's arguments itself; a refusal is
// `{ code: "failed" }`. Electron objects come in as parameters.
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

/**
 * `#rgb` or `#rrggbb` only: Electron reads 4 and 8 digits as alpha first while CSS reads alpha
 * last, so those forms would paint the wrong colour.
 */
export function isBackgroundColor(v: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
}

export interface ChromeContext extends CallContext {
  window: { setBackgroundColor(color: string): void };
}

export function createChromeCapability() {
  return {
    async setAppearance(ctx: ChromeContext, input: unknown): Promise<void> {
      if (!isRecord(input)) throw failed();
      const { scheme, background } = input;
      if (scheme !== "light" && scheme !== "dark") throw failed();
      if (typeof background !== "string" || !isBackgroundColor(background)) throw failed();
      // The scheme is validated but the macOS window appearance is app-wide (nativeTheme), so
      // only the window background follows the page.
      ctx.window.setBackgroundColor(background);
    },
  };
}
