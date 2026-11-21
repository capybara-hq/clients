// Where a navigation of a profile WebView may go (mobile spec §4.4, §15.2; desktop spec §7.1).
//
// - Same-origin main-frame navigations stay in the WebView.
// - A connector OAuth flow may leave the origin top level and come back: a main-frame navigation
//   that starts while the committed page is on the profile origin, to an authorization URL whose
//   `redirect_uri` is on the profile origin, stays, and so does every main-frame navigation while
//   that return is pending (the provider's own login pages), until the WebView is back on the
//   profile origin or the OAuth state's lifetime ends. A foreign page can never start (or renew)
//   one.
// - Every other origin, and every new window (`target=_blank`, `window.open`), goes to the in-app
//   browser sheet: popups never get a WebView (R14).
// - Anything that is not http(s) top level is blocked (`javascript:`, `file:`, `data:`, `blob:`,
//   `about:`, custom schemes), and so are the two in-WebView sign-in routes (spec §4.3; Task 17
//   adds the request block).
//
// Native decides synchronously (Android's `shouldOverrideUrlLoading` cannot wait for the runtime),
// so this module is ported to Navigation.swift and Navigation.kt; all three pass
// test/fixtures/navigation.json.
import { isInWindowSignIn } from "@capybara-hq/shell";

export type NavigationDecision = "allow" | "sheet" | "block";

export interface NavigationContext {
  /** The profile's origin and its base (origin plus path prefix, `normalizeAddress`). */
  profile: { origin: string; base: string };
  isMainFrame: boolean;
  /** A new window: `target=_blank` or `window.open`. */
  targetBlank: boolean;
  /** A connector OAuth leave-and-return is under way (`nextOauthReturn`). */
  oauthReturnPending: boolean;
  /**
   * The main frame's committed page is on the profile origin when the navigation starts (a server
   * redirect keeps the page it started from). Only then may an authorization URL leave.
   */
  fromProfileOrigin: boolean;
}

/** The kernel's OAuth state lives 10 minutes (OAUTH_STATE_TTL_SECONDS); so does a pending return. */
export const OAUTH_RETURN_TTL_MS = 600_000;

/** What a sub frame may load besides http(s): the documents the web's own frames use. */
const FRAME_SCHEMES = new Set(["http:", "https:", "about:", "data:", "blob:"]);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const isHttp = (u: URL) => u.protocol === "http:" || u.protocol === "https:";

/**
 * True for an OAuth authorization request that returns to the profile: http(s), a `response_type`,
 * a `client_id`, a `state` and a `redirect_uri` on exactly the profile origin (the kernel's
 * connector flow always sends all four; its callback is `<publicUrl>/api/v1/oauth/callback`).
 */
export function isAuthorizationUrl(url: string, profileOrigin: string): boolean {
  const u = parse(url);
  if (!u || !isHttp(u)) return false;
  for (const name of ["response_type", "client_id", "state"]) {
    if (!u.searchParams.has(name)) return false;
  }
  const back = parse(u.searchParams.get("redirect_uri") ?? "");
  return back !== null && isHttp(back) && back.origin === profileOrigin;
}

export function decideNavigation(url: string, ctx: NavigationContext): NavigationDecision {
  const u = parse(url);
  if (!u) return "block";
  if (
    isHttp(u) &&
    u.origin === ctx.profile.origin &&
    isInWindowSignIn("POST", u.href, ctx.profile.base)
  ) {
    // Both routes, whatever the method (a navigation is a GET or a form POST).
    return "block";
  }
  if (ctx.targetBlank) return isHttp(u) ? "sheet" : "block";
  if (!ctx.isMainFrame) return FRAME_SCHEMES.has(u.protocol) ? "allow" : "block";
  if (!isHttp(u)) return "block";
  if (u.origin === ctx.profile.origin) return "allow";
  if (ctx.oauthReturnPending) return "allow";
  if (ctx.fromProfileOrigin && isAuthorizationUrl(u.href, ctx.profile.origin)) return "allow";
  return "sheet";
}

/** A pending OAuth return: since when the WebView has been off the profile origin. */
export interface OauthReturn {
  since: number;
}

/**
 * The pending return after a main-frame decision. An allowed navigation off the profile origin
 * starts it; while one is pending its start never moves (a new authorization URL does not renew
 * it); one back on the origin ends it, and it ends on its own after `OAUTH_RETURN_TTL_MS`. A sheet
 * or a block changes nothing.
 */
/** Whether a return is still pending at `now` (the `oauthReturnPending` of a decision). */
export function oauthReturnPending(state: OauthReturn | null, now: number): boolean {
  return state !== null && now - state.since < OAUTH_RETURN_TTL_MS;
}

export function nextOauthReturn(
  prev: OauthReturn | null,
  nav: {
    url: string;
    decision: NavigationDecision;
    profile: { origin: string };
    now: number;
  },
): OauthReturn | null {
  const live = oauthReturnPending(prev, nav.now) ? prev : null;
  if (nav.decision !== "allow") return live;
  const u = parse(nav.url);
  if (!u || !isHttp(u)) return live;
  if (u.origin === nav.profile.origin) return null;
  return live ?? { since: nav.now };
}

/** Android's system back (amended 2026-11-21): no tab roots, no `nav@1`. */
export function decideBack(state: { canGoBack: boolean }): "history" | "background" {
  return state.canGoBack ? "history" : "background";
}
