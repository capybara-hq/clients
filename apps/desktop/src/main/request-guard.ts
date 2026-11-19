// Enforcement in the window (spec §6.5): the profile's partition can never sign in inside the
// window, even when a web version still shows the form. Sign-in goes through the system browser.
//
// Electron keeps only ONE `onBeforeRequest` listener per session (a second call replaces the
// first), so any later request filter on a profile partition must be composed into this listener
// instead of registering its own.

export interface BeforeRequestDetails {
  url: string;
  method: string;
}

export interface WebRequestSession {
  webRequest: {
    onBeforeRequest(
      listener: (
        details: BeforeRequestDetails,
        callback: (response: { cancel?: boolean }) => void,
      ) => void,
    ): void;
  };
}

const LOGIN = /^\/api\/v1\/auth\/login$/;
// Any provider segment(s): blocking more than the kernel routes is harmless, missing one is not.
const SSO_START = /^\/api\/v1\/auth\/sso\/.+\/start$/;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * True for `POST <base>/api/v1/auth/login` and `<base>/api/v1/auth/sso/<provider>/start` (any
 * method: the route is a GET, a HEAD or anything else starts nothing useful). Matches on the parsed
 * URL: same origin as `base`, the base path prefix, then the route; the query is ignored, and the
 * comparison tolerates case, doubled slashes and a trailing slash, so no spelling the server may
 * route the same slips through.
 */
export function isInWindowSignIn(method: string, url: string, base: string): boolean {
  const target = parse(url);
  const home = parse(base);
  if (!target || !home || target.origin !== home.origin) return false;
  const clean = (p: string) =>
    p
      .replace(/\/{2,}/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  const prefix = clean(home.pathname);
  const path = clean(target.pathname);
  if (!path.startsWith(`${prefix}/`)) return false;
  const route = path.slice(prefix.length);
  if (SSO_START.test(route)) return true;
  return method.toUpperCase() === "POST" && LOGIN.test(route);
}

/** Installs the partition's request filter: the two sign-in routes are cancelled, nothing else. */
export function blockInWindowSignIn(session: WebRequestSession, base: string): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: isInWindowSignIn(details.method, details.url, base) });
  });
}
