// The user agent the deployment sees (Ruling R11). The kernel records a session's user agent from
// each refresh request, so the shell names itself on every request to the profile's own origin,
// and only there: connector OAuth providers, CDNs and every other origin keep Chromium's default.
//
// Electron keeps only ONE `onBeforeSendHeaders` listener per session (a second call replaces the
// first), so any later header rewrite on a profile partition must be composed into this listener.

/** The product token; the kernel shows it as the session's client. */
export const DESKTOP_PRODUCT = "Capybara Desktop";

const MACHINE_NAME_MAX = 64;
const APP_VERSION_MAX = 32;

/** The machine name the kernel shows: printable, trimmed, no `.local`, at most 64 characters. */
export function machineNameFrom(hostname: string): string {
  const printable = hostname
    .replace(/\p{C}/gu, "")
    .trim()
    .replace(/\.local$/i, "");
  const capped = [...printable].slice(0, MACHINE_NAME_MAX).join("").trim();
  return capped === "" ? "Desktop" : capped;
}

/** The app version as sent: no control characters, at most 32 characters. */
export function appVersionFrom(version: string): string {
  return [...version.replace(/\p{C}/gu, "").trim()].slice(0, APP_VERSION_MAX).join("");
}

/**
 * A header value must be bytes (Fetch rejects anything beyond Latin-1, and the name sits inside a
 * comment): non-ASCII characters, `%` and the comment's own parentheses are percent-encoded, so
 * the value reads back unambiguously.
 */
function headerSafe(text: string): string {
  return text.replace(/[^\x20-\x24\x26\x27\x2a-\x7e]/gu, (c) =>
    c === "(" || c === ")"
      ? `%${c.charCodeAt(0).toString(16).toUpperCase()}`
      : encodeURIComponent(c),
  );
}

/** `Capybara Desktop/<appVersion> (<machine name>)`, sanitised like the sign-in `name`. */
export function desktopUserAgent(appVersion: string, hostname: string): string {
  const version = headerSafe(appVersionFrom(appVersion));
  return `${DESKTOP_PRODUCT}/${version} (${headerSafe(machineNameFrom(hostname))})`;
}

export interface SendHeadersDetails {
  url: string;
  requestHeaders: Record<string, string>;
}

export interface HeaderSession {
  /** Chromium's default user agent for the session (never changed by the app). */
  getUserAgent(): string;
  webRequest: {
    onBeforeSendHeaders(
      listener: (
        details: SendHeadersDetails,
        callback: (response: { requestHeaders?: Record<string, string> }) => void,
      ) => void,
    ): void;
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The headers with every spelling of `user-agent` replaced by one `User-Agent: value`. */
function withUserAgent(headers: Record<string, string>, value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(headers)) {
    if (name.toLowerCase() !== "user-agent") out[name] = v;
  }
  out["User-Agent"] = value;
  return out;
}

function carriesDesktopUserAgent(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(
    ([name, v]) => name.toLowerCase() === "user-agent" && v.startsWith(`${DESKTOP_PRODUCT}/`),
  );
}

/**
 * Installs the partition's header listener: requests to `origin` (scheme, host and port, so any
 * path of a path-prefix deployment) carry `userAgent`. Every other request keeps Chromium's
 * default: Chromium runs the listener again for each redirect hop with the headers the earlier hop
 * was given, so a hop from the origin to another one (a connector's OAuth start redirecting to the
 * provider) gets the session's default user agent back instead of the desktop one.
 */
export function installDesktopUserAgent(
  session: HeaderSession,
  origin: string,
  userAgent: string,
): void {
  // Read before anything could change it; the app never sets a session-wide user agent.
  const chromiumDefault = session.getUserAgent();
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (originOf(details.url) === origin) {
      callback({ requestHeaders: withUserAgent(details.requestHeaders, userAgent) });
    } else if (carriesDesktopUserAgent(details.requestHeaders)) {
      callback({ requestHeaders: withUserAgent(details.requestHeaders, chromiumDefault) });
    } else {
      callback({});
    }
  });
}
