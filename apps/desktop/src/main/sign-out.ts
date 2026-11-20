// Sign-out (desktop spec §6.9): from the web's own account menu or from the app menu's 「平台」.
//
// The web's 「退出登录」 posts `/api/v1/auth/logout` and navigates to `/login`. The shell sees the
// successful logout on the profile's partition (`webRequest.onCompleted`, `watchLogout`) and
// treats the next main-frame navigation to `<base>/login` within 30 s as the end of a sign-out
// (`takeLoggedOut`), not an expiry. The app menu's entry asks in a shell dialog, posts the logout
// itself through the partition's fetch and completes whatever the POST answered: a dead session
// is signed out too. Completing marks the profile signed out, shows the small window's signed-out
// page and closes the profile's main windows; the profile stays.
//
// Electron keeps ONE listener per `webRequest` event and session: this module owns `onCompleted`
// on profile partitions (request-guard.ts owns `onBeforeRequest`, user-agent.ts
// `onBeforeSendHeaders`); any later completion filter must be composed into `watchLogout`.
//
// Electron objects come in as parameters.
import type { Profile } from "./profiles.ts";
import type { FetchLike } from "./sign-in.ts";

/** How long a completed logout waits for its `/login` navigation. */
export const LOGGED_OUT_WINDOW_MS = 30_000;
/** The app menu's logout POST gives up after this long (the sign-out completes anyway). */
export const LOGOUT_TIMEOUT_MS = 10_000;

const LOGOUT_ROUTE = "/api/v1/auth/logout";
const LOGIN_ROUTE = "/login";

export interface CompletedDetails {
  url: string;
  method: string;
  statusCode: number;
}

/** The part of a session `watchLogout` uses. */
export interface CompletedSession {
  webRequest: {
    onCompleted(listener: (details: CompletedDetails) => void): void;
  };
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** `url`'s path below `base` (same origin, under the base path), without a trailing slash. */
function routeUnder(url: string, base: string): string | null {
  const target = parse(url);
  const home = parse(base);
  if (!target || !home || target.origin !== home.origin) return null;
  const prefix = home.pathname.replace(/\/+$/, "");
  const path = target.pathname.replace(/\/+$/, "");
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null;
  return path.slice(prefix.length) || "/";
}

/**
 * True for a completed `POST <base>/api/v1/auth/logout` answered 2xx, on the profile's own
 * deployment only. A detection, not a guard: a spelling it misses only makes the next `/login`
 * read as an expiry.
 */
export function isLogoutCompletion(details: CompletedDetails, base: string): boolean {
  if (details.method.toUpperCase() !== "POST") return false;
  if (details.statusCode < 200 || details.statusCode > 299) return false;
  return routeUnder(details.url, base) === LOGOUT_ROUTE;
}

/** True for the deployment's sign-in page, `<base>/login` (any query or fragment). */
export function isLoginUrl(profile: Pick<Profile, "base">, url: string): boolean {
  return routeUnder(url, profile.base) === LOGIN_ROUTE;
}

/** Installs the partition's completion listener (once per partition: see the header). */
export function watchLogout(session: CompletedSession, base: string, onLogout: () => void): void {
  session.webRequest.onCompleted((details) => {
    if (isLogoutCompletion(details, base)) onLogout();
  });
}

/** A main-frame navigation of a profile window to its `/login`. */
export interface LoginNavigation {
  url: string;
  /** Electron allows stopping it (`will-navigate`, `will-redirect`); else it has committed. */
  stoppable: boolean;
  /** Stops it when `stoppable`; a no-op otherwise. */
  stop(): void;
}

/** The webContents events the login watch listens to. */
export interface NavigationContents {
  // biome-ignore lint/suspicious/noExplicitAny: Electron's per-event listener signatures differ.
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Watches a profile window's main frame for navigations to `<base>/login`: `will-navigate` and
 * `will-redirect` (stoppable), `did-navigate` and `did-navigate-in-page` (a client navigation
 * that cannot be stopped). One navigation may be reported more than once (stopped or not), so
 * `onLogin` must be idempotent; `takeLoggedOut` is, being true once.
 *
 * K9 takes this over for the expired page: it passes its own `onLogin` (the session-watch
 * decision) instead of `signOutOnLogin`, and calls `signOut.takeLoggedOut` / `complete` from it.
 */
export function watchLoginNavigations(
  contents: NavigationContents,
  profile: Pick<Profile, "base">,
  onLogin: (nav: LoginNavigation) => void,
): void {
  const stoppable =
    (mainFrameArg: number) =>
    (event: { preventDefault(): void }, url: string, ...rest: unknown[]) => {
      // `will-navigate` is main frame only; `will-redirect` says (isInPlace, isMainFrame).
      if (mainFrameArg >= 0 && rest[mainFrameArg] === false) return;
      if (!isLoginUrl(profile, url)) return;
      onLogin({ url, stoppable: true, stop: () => event.preventDefault() });
    };
  const committed =
    (event: string) =>
    (_event: unknown, url: string, ...rest: unknown[]) => {
      // `did-navigate-in-page`: (url, isMainFrame); `did-navigate` is main frame only.
      if (event === "did-navigate-in-page" && rest[0] === false) return;
      if (!isLoginUrl(profile, url)) return;
      onLogin({ url, stoppable: false, stop: () => {} });
    };
  contents.on("will-navigate", stoppable(-1));
  contents.on("will-redirect", stoppable(1));
  contents.on("did-navigate", committed("did-navigate"));
  contents.on("did-navigate-in-page", committed("did-navigate-in-page"));
}

/**
 * The decision until K9 adds the expired page: a `/login` right after a logout ends the sign-out
 * (the navigation is stopped where it can be; the window closes anyway); any other `/login` is
 * left to the web for now.
 */
export function signOutOnLogin(
  signOut: Pick<SignOut, "takeLoggedOut" | "complete">,
  profileId: string,
): (nav: LoginNavigation) => void {
  return (nav) => {
    if (!signOut.takeLoggedOut(profileId)) return;
    nav.stop();
    void signOut.complete(profileId);
  };
}

export interface SignOutDeps {
  /** The profile as stored now; undefined once removed. */
  getProfile(id: string): Profile | undefined;
  /** `profiles.update(id, { signedIn: false })`. */
  markSignedOut(id: string): Profile | undefined;
  /** The small window's signed-out page (onboarding.showSignedOut). */
  showSignedOut(profile: Profile): void;
  /** Closes the profile's main windows (windows.closeProfileWindows). */
  closeProfileWindows(id: string): void;
  /** Board `SignOut` in a shell dialog: true only for 退出登录. */
  confirm(profile: Profile): Promise<boolean>;
  /** The profile partition's own fetch: the logout carries its cookies. */
  fetchFor(profile: Profile): FetchLike;
  /** Removes `cap_at` / `cap_rt` from the partition's cookie jar. */
  clearSessionCookies(profile: Profile): Promise<void>;
  /** The profiles changed (menus, tray). */
  onSignedOut?(profile: Profile): void;
  /** One dialog at a time per profile (the bridge's gate); absent: no gate. */
  gate?: {
    isConfirmingCallAllowed(profileId: string, activationActive: boolean): string;
    release(profileId: string): void;
  };
  now?(): number;
  timeoutMs?: number;
  log?: (message: string, err?: unknown) => void;
}

export interface SignOut {
  /** The logout POST of the profile's partition completed with 2xx (webRequest). */
  noteLoggedOut(profileId: string): void;
  /** True once after noteLoggedOut, within 30 s: the next /login is the end of a sign-out. */
  takeLoggedOut(profileId: string): boolean;
  /** Marks signed out, closes the main windows, shows the signed-out small window. */
  complete(profileId: string): Promise<void>;
  /** The 「平台」 menu entry: shell dialog, then logout POST, then complete. */
  confirmAndSignOut(profileId: string): Promise<void>;
}

export function createSignOut(deps: SignOutDeps): SignOut {
  const log = (message: string, err?: unknown) => deps.log?.(message, err);
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? LOGOUT_TIMEOUT_MS;
  /** Profile id → when its logout completed. */
  const loggedOut = new Map<string, number>();

  async function postLogout(profile: Profile): Promise<void> {
    try {
      const res = await deps.fetchFor(profile)(`${profile.base}${LOGOUT_ROUTE}`, {
        method: "POST",
        headers: { "X-Capybara-Csrf": "1" },
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) log(`the logout answered ${res.status}; signing out locally`);
    } catch (err) {
      log("the logout request failed; signing out locally", err instanceof Error ? err.name : err);
    }
  }

  const signOut: SignOut = {
    noteLoggedOut(profileId) {
      // A profile already signed out (the menu's own POST, completed first) waits for nothing.
      if (!deps.getProfile(profileId)?.signedIn) return;
      loggedOut.set(profileId, now());
    },

    takeLoggedOut(profileId) {
      const at = loggedOut.get(profileId);
      loggedOut.delete(profileId);
      return at !== undefined && now() - at <= LOGGED_OUT_WINDOW_MS;
    },

    async complete(profileId) {
      loggedOut.delete(profileId);
      const profile = deps.getProfile(profileId);
      if (!profile) return;
      let updated = profile;
      try {
        updated = deps.markSignedOut(profileId) ?? { ...profile, signedIn: false };
      } catch (err) {
        log("could not mark the profile signed out", err);
        updated = { ...profile, signedIn: false };
      }
      // The small window first: closing the last window quits the app on Windows / Linux.
      deps.showSignedOut(updated);
      deps.closeProfileWindows(profileId);
      deps.onSignedOut?.(updated);
    },

    async confirmAndSignOut(profileId) {
      const profile = deps.getProfile(profileId);
      if (!profile?.signedIn) return;
      // A menu click is a user action in the app's own UI: the activation is given.
      if (deps.gate && deps.gate.isConfirmingCallAllowed(profileId, true) !== "ok") {
        log("a dialog is already open for this platform");
        return;
      }
      let confirmed = false;
      try {
        confirmed = await deps.confirm(profile);
      } catch (err) {
        log("the sign-out dialog failed", err);
      } finally {
        deps.gate?.release(profileId);
      }
      if (!confirmed) return;
      const current = deps.getProfile(profileId);
      if (!current?.signedIn) return;
      await postLogout(current);
      try {
        await deps.clearSessionCookies(current);
      } catch (err) {
        log("could not clear the session cookies", err);
      }
      await signOut.complete(profileId);
    },
  };
  return signOut;
}
