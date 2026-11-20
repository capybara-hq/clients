// Sign-out (desktop spec §6.9): from the web's own account menu or from the app menu's 「平台」.
//
// The web's 「退出登录」 posts `/api/v1/auth/logout` and navigates to `/login`. The shell sees the
// successful logout on the profile's partition (`webRequest.onCompleted`, `watchLogout`) and
// treats the next main-frame navigation to `<base>/login` within 30 s as the end of a sign-out
// (`takeLoggedOut`), not an expiry. The two can arrive in either order: the page's fetch resolves
// on the response headers and the completion comes with the body, so the navigation may be seen
// first. A `/login` that was not the end of a sign-out is recorded (`noteLogin`); a completion
// that follows it within 5 s, or that finds a window of the profile on `/login`, completes the
// sign-out at once. The shell's own logout POSTs (the menu's, sign-in's revoke of an unwanted
// session) also complete on the partition (`session.fetch` passes through `webRequest`, after
// its promise resolved); they run inside `suppress` and leave no note. The app menu's entry asks in a shell dialog, posts the logout
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
/** A completion this soon after a `/login` the web already reached pairs with it. */
export const LOGIN_PAIR_MS = 5_000;
/** A suppressed (shell-initiated) logout's completion may arrive this long after its run ended. */
export const SUPPRESS_GRACE_MS = 5_000;

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
  /** Stops it where Electron allows (`will-navigate`, `will-redirect`); else a no-op. */
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
 * decision) instead of `signOutOnLogin`, and calls `signOut.takeLoggedOut` / `complete` from it,
 * and `signOut.noteLogin` for a `/login` that was not the end of a sign-out (so a completion that
 * arrives after it still ends the sign-out).
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
      onLogin({ url, stop: () => event.preventDefault() });
    };
  const committed =
    (event: string) =>
    (_event: unknown, url: string, ...rest: unknown[]) => {
      // `did-navigate-in-page`: (url, isMainFrame); `did-navigate` is main frame only.
      if (event === "did-navigate-in-page" && rest[0] === false) return;
      if (!isLoginUrl(profile, url)) return;
      onLogin({ url, stop: () => {} });
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
  signOut: Pick<SignOut, "takeLoggedOut" | "complete" | "noteLogin">,
  profileId: string,
): (nav: LoginNavigation) => void {
  return (nav) => {
    if (!signOut.takeLoggedOut(profileId)) {
      signOut.noteLogin(profileId);
      return;
    }
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
  /** Whether a main window of the profile is open (absent: assumed). */
  hasProfileWindows?(id: string): boolean;
  /** Whether a main window of the profile shows its `/login` now (absent: never). */
  showsLogin?(id: string): boolean;
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
  /**
   * The logout POST of the profile's partition completed with 2xx (webRequest). After a `/login`
   * the window already reached (`noteLogin`, or a window on `/login`), it completes at once.
   */
  noteLoggedOut(profileId: string): void;
  /** A main-frame `/login` of the profile that did not end a sign-out (yet). */
  noteLogin(profileId: string): void;
  /**
   * Runs a logout the shell itself sends for the profile: its completion (until 5 s after `run`
   * settled) leaves no note.
   */
  suppress<T>(profileId: string, run: () => Promise<T>): Promise<T>;
  /** The profile was removed: its notes go. */
  forget(profileId: string): void;
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
  /** Profile id → when its window last reached `/login` without ending a sign-out. */
  const loginSeen = new Map<string, number>();
  /** Profile id → the shell's own logouts: each expects one completion, until `until`. */
  const suppressed = new Map<string, { until: number }[]>();

  function sweep(): void {
    const t = now();
    for (const [id, at] of loggedOut) if (t - at > LOGGED_OUT_WINDOW_MS) loggedOut.delete(id);
    for (const [id, at] of loginSeen) if (t - at > LOGIN_PAIR_MS) loginSeen.delete(id);
    for (const [id, tokens] of suppressed) {
      const live = tokens.filter((k) => k.until >= t);
      if (live.length > 0) suppressed.set(id, live);
      else suppressed.delete(id);
    }
  }

  /** Consumes one suppression token of the profile; true when there was one. */
  function takeSuppressed(profileId: string): boolean {
    const tokens = suppressed.get(profileId);
    if (!tokens || tokens.length === 0) return false;
    tokens.shift();
    if (tokens.length === 0) suppressed.delete(profileId);
    return true;
  }

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
      sweep();
      // The shell's own logout (the menu's, sign-in's revoke): not the web's sign-out.
      if (takeSuppressed(profileId)) return;
      // A profile already signed out waits for nothing.
      if (!deps.getProfile(profileId)?.signedIn) return;
      // The window reached /login first (the completion came with the body, after the page's
      // fetch resolved on the headers): the sign-out ends now.
      const seen = loginSeen.get(profileId);
      if (seen !== undefined || deps.showsLogin?.(profileId) === true) {
        loginSeen.delete(profileId);
        void signOut.complete(profileId);
        return;
      }
      loggedOut.set(profileId, now());
    },

    noteLogin(profileId) {
      sweep();
      loginSeen.set(profileId, now());
    },

    async suppress(profileId, run) {
      const token = { until: Number.POSITIVE_INFINITY };
      suppressed.set(profileId, [...(suppressed.get(profileId) ?? []), token]);
      try {
        return await run();
      } finally {
        token.until = now() + SUPPRESS_GRACE_MS;
      }
    },

    forget(profileId) {
      loggedOut.delete(profileId);
      loginSeen.delete(profileId);
      suppressed.delete(profileId);
    },

    takeLoggedOut(profileId) {
      const at = loggedOut.get(profileId);
      loggedOut.delete(profileId);
      return at !== undefined && now() - at <= LOGGED_OUT_WINDOW_MS;
    },

    async complete(profileId) {
      loggedOut.delete(profileId);
      loginSeen.delete(profileId);
      const profile = deps.getProfile(profileId);
      if (!profile) return;
      // Completed already (both entries, or one event reported twice): nothing left to do.
      if (!profile.signedIn && deps.hasProfileWindows?.(profileId) === false) return;
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
      await signOut.suppress(profileId, () => postLogout(current));
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
