// Errors after sign-in stay in the main window (desktop spec §6.8, board MainErrors). Each profile
// window is watched for two things, and either covers the web contents with a local page (an
// overlay, overlay.ts) instead of ever going back to the small window:
//
// - Session expired. A main-frame navigation to the deployment's `/login` is stopped where
//   Electron allows (`will-navigate`, `will-redirect`) and in any case decided the same way
//   (`did-navigate`, `did-navigate-in-page` for client navigations): right after a logout of the
//   profile (`signOut.takeLoggedOut`) it is the end of a sign-out (`signOut.complete`); otherwise it
//   is recorded (`signOut.noteLogin`, so a logout completion that arrives after it still ends the
//   sign-out) and the expired page shows. 在浏览器中重新登录 runs the sign-in (sign-in.ts `begin`;
//   one attempt per profile, shared by its expired windows); on success the profile is marked
//   signed in with the account, each expired window of the profile drops its overlay and loads its
//   return URL: the `returnTo` of the stopped URL when it is a path on the deployment, else the
//   last page the window showed, else `/` (and `/` when another account signed in). A failure is
//   shown inline. 退出登录 completes the sign-out without asking (the session is gone already);
//   切换平台 pops the 「平台」 menu up.
//
//   While an expired page shows, the window counts as being on `/login` for the sign-out
//   (`showsExpired`): a logout completion of the profile then ends the sign-out at once, whatever
//   time passed since the `/login`. The signed-out small window is the end state of a sign-out.
//
// - Platform unreachable. A main-frame load of a deployment page that fails with a network error
//   (anything but an abort, `-3`), or a deployment document answered 502 / 503 / 504, shows the
//   unreachable page with how long it has been down. `/api/v1/meta` is probed through the
//   partition's fetch every 5 s for the first minute, then every 30 s (an injected scheduler); a
//   2xx drops the overlay and loads the page that failed. 重试 probes now. 退出登录 there is the
//   「平台」 menu's sign-out (with its confirmation: the session may still be alive). Probing stops
//   when the window closes. A failure elsewhere (another origin) is not the platform's.
//
// The expired page wins over the unreachable one (a re-sign-in loads the page again, and a failure
// then shows the unreachable page). Electron objects come in as parameters.
import type { MainErrorFields, MainErrorPage, MainErrorState } from "../local/main-error-model.ts";
import type { BasePageState, PagePlatform } from "../shared/local-page.ts";
import type { Controls } from "../shared/protocol.ts";
import type { LocalActContext, LocalPages } from "./local-pages.ts";
import type { Overlay, OverlayOptions, OverlayParent } from "./overlay.ts";
import type { Profile } from "./profiles.ts";
import type { FetchLike, SignedInAccount, SignIn, SignInOutcome } from "./sign-in.ts";
import {
  isLoginUrl,
  type LoginNavigation,
  type NavigationContents,
  routeUnder,
  type SignOut,
  watchLoginNavigations,
} from "./sign-out.ts";

/** Probes run this often for the first minute a window is down, then every `PROBE_SLOW_MS`. */
export const PROBE_FAST_MS = 5_000;
export const PROBE_SLOW_MS = 30_000;
export const PROBE_FAST_FOR_MS = 60_000;
/** A probe gives up after this long (and counts as down). */
export const PROBE_TIMEOUT_MS = 10_000;
/** Chromium's `net::ERR_ABORTED`: a stopped or replaced navigation, not a failure. */
export const ERR_ABORTED = -3;
/** Main documents answered with these show the unreachable page. */
export const UNREACHABLE_STATUS: ReadonlySet<number> = new Set([502, 503, 504]);

/** The delay before the next probe, by how long the window has been down. */
export function probeDelay(downForMs: number): number {
  return downForMs < PROBE_FAST_FOR_MS ? PROBE_FAST_MS : PROBE_SLOW_MS;
}

/**
 * True when `/api/v1/meta` of the deployment answers 2xx with a JSON object, without a redirect,
 * through the partition's fetch: a captive portal or a proxy's own page does not count as up.
 */
export async function probeMeta(fetch: FetchLike, base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/v1/meta`, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return typeof body === "object" && body !== null && !Array.isArray(body);
  } catch {
    return false;
  }
}

/** True for a URL on the deployment (the profile origin, under its base path). */
export function onDeployment(profile: Pick<Profile, "base">, url: string): boolean {
  return routeUnder(url, profile.base) !== null;
}

/**
 * Where a successful re-sign-in returns (spec §6.8): the `returnTo` query of the intercepted
 * `/login` URL when it is a path on the deployment (never `/login` itself, never another origin),
 * else the last page the window showed on the deployment, else `<base>/`.
 */
export function returnUrlFor(
  profile: Pick<Profile, "base" | "origin">,
  loginUrl: string,
  lastUrl: string | undefined,
): string {
  const home = `${profile.base}/`;
  const usable = (url: string) => onDeployment(profile, url) && !isLoginUrl(profile, url);
  let returnTo: string | null = null;
  try {
    returnTo = new URL(loginUrl).searchParams.get("returnTo");
  } catch {
    returnTo = null;
  }
  // A path only: `//host`, `/\host` and absolute URLs are refused before resolving.
  if (returnTo?.startsWith("/") && !/^\/[/\\]/.test(returnTo)) {
    try {
      const target = new URL(returnTo, profile.origin);
      if (target.origin === profile.origin && usable(target.href)) return target.href;
    } catch {
      // Not a URL: fall through.
    }
  }
  if (lastUrl && usable(lastUrl)) return lastUrl;
  return home;
}

/** A profile window as the watch drives it (a BrowserWindow). */
export interface SessionWindow extends OverlayParent {
  webContents: NavigationContents & { focus?(): void };
  // biome-ignore lint/suspicious/noExplicitAny: Electron's per-event listener signatures differ.
  on(event: string, listener: (...args: any[]) => void): unknown;
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  loadURL(url: string): Promise<void>;
  isFullScreen?(): boolean;
}

export interface SessionWatchDeps {
  /** Shows the overlay on a window (overlay.ts `showOverlay`, its deps bound). */
  showOverlay(parent: SessionWindow, o: OverlayOptions): Overlay;
  localPages: Pick<LocalPages, "handle">;
  /** The profile as stored now; undefined once removed. */
  getProfile(id: string): Profile | undefined;
  signOut: Pick<
    SignOut,
    "takeLoggedOut" | "noteLogin" | "complete" | "confirmAndSignOut" | "signOutNow"
  >;
  signIn: Pick<SignIn, "begin" | "pendingUrl" | "cancel">;
  /** The system browser. */
  openExternal(url: string): Promise<unknown> | unknown;
  /** `profiles.update(id, { signedIn: true, account })` (and the menus' refresh). */
  markSignedIn(id: string, account: SignedInAccount): Profile | undefined;
  /**
   * A window of a profile that is not signed in (or was removed) met the deployment's /login: show
   * the profile's small-window page (signed out, or found) and close that window. A backstop: no
   * entry opens a main window for a profile that is not signed in.
   */
  notSignedIn(profileId: string, window: SessionWindow): void;
  /** Pops the 「平台」 menu up over the window. */
  popupPlatformMenu(window: SessionWindow): void;
  /** `probeMeta` through the profile partition's fetch. */
  probe(profile: Profile): Promise<boolean>;
  /** One-shot timer; returns its cancel. */
  schedule(run: () => void, ms: number): () => void;
  now(): number;
  /** Locale, appearance, OS and footer fields for a page about `profile`. */
  pageBase(profile: Profile): Omit<BasePageState, "page" | "platform" | "controls">;
  /** The platform the page names: name, host, cached icon. */
  platformOf(profile: Profile): PagePlatform;
  /** The window controls' rectangle in the window now (traffic lights), or null. */
  controls(window: SessionWindow): Controls | null;
  /** The overlay's ground before its page paints. */
  background(profile: Profile): string;
  log?(message: string, err?: unknown): void;
}

interface Watched {
  profileId: string;
  window: SessionWindow;
  /** The last deployment page the window showed (not `/login`). */
  lastUrl: string | undefined;
  mode: "none" | MainErrorPage;
  overlay: Overlay | undefined;
  /** Expired: where a successful re-sign-in goes. */
  returnUrl: string;
  /** Expired: the last re-sign-in's failure. */
  error: string | null;
  /** Unreachable: the page that failed, loaded again when the platform answers. */
  failedUrl: string;
  downSince: number | null;
  probing: boolean;
  cancelProbe: (() => void) | undefined;
  /** The window closed, or is closing at the end of a sign-out: nothing more is shown. */
  ended: boolean;
}

export function createSessionWatch(deps: SessionWatchDeps) {
  const log = (message: string, err?: unknown) => deps.log?.(message, err);
  const watched = new Set<Watched>();
  /** Profile id → the sequence number of its pending re-sign-in. */
  const pending = new Map<string, number>();
  let attemptSeq = 0;

  const ofProfile = (id: string, mode?: MainErrorPage) =>
    [...watched].filter((w) => w.profileId === id && !w.ended && (!mode || w.mode === mode));

  function stateOf(w: Watched, profile: Profile): MainErrorState {
    const fields: MainErrorFields = {
      page: w.mode === "unreachable" ? "unreachable" : "expired",
      error: w.mode === "expired" ? w.error : null,
      waiting: w.mode === "expired" && pending.has(w.profileId),
      probing: w.mode === "unreachable" && w.probing,
      downSince: w.mode === "unreachable" ? w.downSince : null,
    };
    return {
      ...deps.pageBase(profile),
      platform: deps.platformOf(profile),
      controls: deps.controls(w.window),
      ...fields,
    };
  }

  /** Shows the overlay for the window's mode, or tells the shown one the new state. */
  function render(w: Watched): void {
    if (w.ended || w.mode === "none") return;
    if (w.overlay && !w.overlay.isRemoved()) {
      w.overlay.push();
      return;
    }
    const profile = deps.getProfile(w.profileId);
    if (!profile) return;
    try {
      w.overlay = deps.showOverlay(w.window, {
        profileId: w.profileId,
        background: deps.background(profile),
        state: () => stateOf(w, deps.getProfile(w.profileId) ?? profile),
      });
    } catch (err) {
      log("could not show the error overlay", err);
    }
  }

  function stopProbe(w: Watched): void {
    w.cancelProbe?.();
    w.cancelProbe = undefined;
  }

  /** Back to the web contents: no overlay, no probe. */
  function clear(w: Watched): void {
    stopProbe(w);
    w.mode = "none";
    w.error = null;
    w.downSince = null;
    w.probing = false;
    const overlay = w.overlay;
    w.overlay = undefined;
    overlay?.remove();
    try {
      w.window.webContents.focus?.();
    } catch {
      // Gone meanwhile.
    }
  }

  function load(w: Watched, url: string): void {
    if (w.ended || w.window.isDestroyed()) return;
    w.window.loadURL(url).catch((err: unknown) => log(`could not load ${url}`, err));
  }

  function showExpired(w: Watched, loginUrl: string): void {
    if (w.ended || w.mode === "expired") return;
    const profile = deps.getProfile(w.profileId);
    if (!profile) return;
    stopProbe(w);
    w.probing = false;
    w.returnUrl = returnUrlFor(profile, loginUrl, w.lastUrl);
    w.error = null;
    w.mode = "expired";
    render(w);
  }

  function showUnreachable(w: Watched, url: string): void {
    if (w.ended || w.mode === "expired") return;
    w.failedUrl = url;
    if (w.mode === "unreachable") {
      // A reload after a successful probe failed again: same overlay, same backoff.
      if (!w.cancelProbe && !w.probing) scheduleProbe(w);
      render(w);
      return;
    }
    w.mode = "unreachable";
    w.downSince = deps.now();
    render(w);
    scheduleProbe(w);
  }

  function scheduleProbe(w: Watched): void {
    stopProbe(w);
    if (w.ended || w.mode !== "unreachable" || w.downSince === null) return;
    const delay = probeDelay(deps.now() - w.downSince);
    w.cancelProbe = deps.schedule(() => {
      w.cancelProbe = undefined;
      void runProbe(w);
    }, delay);
  }

  async function runProbe(w: Watched): Promise<void> {
    if (w.ended || w.mode !== "unreachable" || w.probing) return;
    const profile = deps.getProfile(w.profileId);
    if (!profile) return;
    stopProbe(w);
    w.probing = true;
    render(w);
    let up = false;
    try {
      up = await deps.probe(profile);
    } catch {
      up = false;
    }
    w.probing = false;
    if (w.ended || w.mode !== "unreachable") return;
    render(w);
    // The overlay stays until a document of the deployment loads (the did-navigate 200–499 branch):
    // meta may answer while documents still fail, and that must neither flash nor reset the
    // backoff. The next probe stays scheduled from the first failure.
    scheduleProbe(w);
    if (up) load(w, w.failedUrl);
  }

  function onLogin(w: Watched, nav: LoginNavigation): void {
    if (w.ended) return;
    nav.stop();
    // Not signed in (signed out meanwhile, or a window opened by mistake): never a blank window.
    if (!deps.getProfile(w.profileId)?.signedIn) {
      w.ended = true;
      stopProbe(w);
      deps.notSignedIn(w.profileId, w.window);
      return;
    }
    if (deps.signOut.takeLoggedOut(w.profileId)) {
      w.ended = true;
      stopProbe(w);
      void deps.signOut.complete(w.profileId);
      return;
    }
    deps.signOut.noteLogin(w.profileId);
    showExpired(w, nav.url);
  }

  function failSignIn(profileId: string, error: string): void {
    for (const w of ofProfile(profileId, "expired")) {
      w.error = error;
      render(w);
    }
  }

  function onOutcome(profileId: string, seq: number, outcome: SignInOutcome): void {
    if (pending.get(profileId) !== seq) return;
    pending.delete(profileId);
    if (!outcome.ok) {
      failSignIn(profileId, outcome.reason);
      return;
    }
    const before = deps.getProfile(profileId);
    let saved: Profile | undefined;
    try {
      saved = deps.markSignedIn(profileId, outcome.account);
    } catch (err) {
      log("could not mark the profile signed in", err);
    }
    const profile = saved ?? before;
    if (!profile) return;
    // Another account: the page the last one was on may not be this one's, in any window.
    const sameAccount = !before?.account || before.account.login === outcome.account.login;
    recover(profile, sameAccount, false);
  }

  /**
   * The profile is signed in again: every expired window drops its overlay and loads its return
   * URL (`/` for another account, whose other windows go to `/` as well; with `reloadOthers`, the
   * same account's other windows reload their page too). Returns how many expired windows were
   * recovered.
   */
  function recover(profile: Profile, sameAccount: boolean, reloadOthers: boolean): number {
    const home = `${profile.base}/`;
    let recovered = 0;
    for (const w of ofProfile(profile.id)) {
      if (w.mode === "expired") {
        const url = sameAccount ? w.returnUrl : home;
        clear(w);
        load(w, url);
        recovered += 1;
      } else if (!sameAccount) {
        if (w.mode === "unreachable") w.failedUrl = home;
        load(w, home);
      } else if (reloadOthers && w.mode === "none") {
        load(w, w.lastUrl ?? home);
      }
    }
    return recovered;
  }

  async function startSignIn(w: Watched): Promise<void> {
    const profile = deps.getProfile(w.profileId);
    if (!profile) return;
    const id = profile.id;
    if (pending.has(id)) {
      // Pending already: the same authorize URL again (the attempt is unchanged).
      const url = deps.signIn.pendingUrl(id);
      if (url) await deps.openExternal(url);
      return;
    }
    const seq = ++attemptSeq;
    pending.set(id, seq);
    for (const e of ofProfile(id, "expired")) e.error = null;
    const { url, outcome } = deps.signIn.begin(profile);
    void outcome.then((o) => onOutcome(id, seq, o));
    for (const e of ofProfile(id, "expired")) render(e);
    try {
      await deps.openExternal(url);
    } catch (err) {
      log("could not open the browser for sign-in", err instanceof Error ? err.name : undefined);
      if (pending.get(id) !== seq) return;
      pending.delete(id);
      deps.signIn.cancel(id);
      failSignIn(id, "link_invalid");
    }
  }

  function signOutFrom(w: Watched): void {
    const id = w.profileId;
    if (w.mode === "expired") {
      // No confirmation (spec §6.8); the session may still live server side, so signOutNow posts
      // the logout best effort and clears the session cookies before completing.
      if (pending.has(id)) {
        pending.delete(id);
        deps.signIn.cancel(id);
      }
      for (const e of ofProfile(id)) {
        e.ended = true;
        stopProbe(e);
      }
      void deps.signOut.signOutNow(id);
      return;
    }
    // The host may hang: the logout POST gives up after 2 s (sign-out.ts).
    void deps.signOut.confirmAndSignOut(id, { unreachable: true });
  }

  /** The watched window whose overlay sent an action. */
  const fromOverlay = (ctx: LocalActContext) =>
    [...watched].find((w) => !w.ended && w.overlay?.contents === ctx.contents);

  deps.localPages.handle("main-error", "mainError.signIn", (ctx) => {
    const w = fromOverlay(ctx);
    if (w?.mode !== "expired") return false;
    void startSignIn(w);
    return true;
  });
  deps.localPages.handle("main-error", "mainError.retry", (ctx) => {
    const w = fromOverlay(ctx);
    if (w?.mode !== "unreachable") return false;
    void runProbe(w);
    return true;
  });
  deps.localPages.handle("main-error", "mainError.signOut", (ctx) => {
    const w = fromOverlay(ctx);
    if (!w || w.mode === "none") return false;
    signOutFrom(w);
    return true;
  });
  deps.localPages.handle("main-error", "mainError.switchPlatform", (ctx) => {
    const w = fromOverlay(ctx);
    if (!w || w.mode === "none") return false;
    deps.popupPlatformMenu(w.window);
    return true;
  });

  return {
    /** Watches a profile window from its creation (before its first load) until it closes. */
    watch(profile: Pick<Profile, "id" | "base">, window: SessionWindow): void {
      const w: Watched = {
        profileId: profile.id,
        window,
        lastUrl: undefined,
        mode: "none",
        overlay: undefined,
        returnUrl: `${profile.base}/`,
        error: null,
        failedUrl: `${profile.base}/`,
        downSince: null,
        probing: false,
        cancelProbe: undefined,
        ended: false,
      };
      watched.add(w);
      const wc = window.webContents;
      watchLoginNavigations(wc, profile, (nav) => onLogin(w, nav));

      const seen = (url: string) => {
        if (onDeployment(profile, url) && !isLoginUrl(profile, url)) w.lastUrl = url;
      };
      wc.on("did-navigate", (_e: unknown, url: string, code: number) => {
        if (!onDeployment(profile, url) || isLoginUrl(profile, url)) return;
        if (UNREACHABLE_STATUS.has(code)) {
          showUnreachable(w, url);
          return;
        }
        seen(url);
        // The deployment answered a document: the platform is back.
        if (w.mode === "unreachable" && code >= 200 && code < 500) clear(w);
      });
      wc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
        if (isMainFrame !== false) seen(url);
      });
      wc.on(
        "did-fail-load",
        (_e: unknown, code: number, _desc: string, url: string, isMainFrame: boolean) => {
          if (isMainFrame !== true || code === ERR_ABORTED) return;
          if (!onDeployment(profile, url)) return;
          showUnreachable(w, url);
        },
      );
      const recontrol = () => {
        if (w.mode !== "none") render(w);
      };
      window.on("enter-full-screen", recontrol);
      window.on("leave-full-screen", recontrol);
      window.on("closed", () => {
        w.ended = true;
        stopProbe(w);
        const overlay = w.overlay;
        w.overlay = undefined;
        overlay?.remove();
        watched.delete(w);
        // The last window of the profile is gone: its re-sign-in has nowhere to return to.
        const id = profile.id;
        if (pending.has(id) && ![...watched].some((x) => x.profileId === id)) {
          pending.delete(id);
          deps.signIn.cancel(id);
        }
      });
    },

    /**
     * The profile was signed in another way (signIn@1, the small window), as `account` when known
     * (the profile is updated with it). With a window on the expired page, or another account, the
     * watch takes care of every window: expired ones load their return URL, the others reload
     * their page (another account: everything goes to `/`); returns true. Otherwise returns false
     * and the caller reloads as before. A signIn@1 call that replaced the overlay's own attempt
     * first shows "cancelled" in the overlay (accepted: this clears it right after).
     */
    signedIn(profileId: string, account?: SignedInAccount): boolean {
      const before = deps.getProfile(profileId);
      if (!before) return false;
      let profile: Profile = before;
      if (account) {
        try {
          profile = deps.markSignedIn(profileId, account) ?? before;
        } catch (err) {
          log("could not mark the profile signed in", err);
        }
      }
      const sameAccount = !account || !before.account || before.account.login === account.login;
      if (sameAccount && ofProfile(profileId, "expired").length === 0) return false;
      recover(profile, sameAccount, true);
      return true;
    },

    /** A window of the profile shows the expired page (sign-out: it counts as on `/login`). */
    showsExpired(profileId: string): boolean {
      return ofProfile(profileId, "expired").length > 0;
    },
  };
}

export type SessionWatch = ReturnType<typeof createSessionWatch>;
