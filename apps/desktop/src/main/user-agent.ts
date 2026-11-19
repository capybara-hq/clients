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
 * comment): non-ASCII characters and the comment's own parentheses are percent-encoded.
 */
function headerSafe(text: string): string {
  return text.replace(/[^\x20-\x27\x2a-\x7e]/gu, (c) =>
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

/**
 * Installs the partition's header listener: requests to `origin` (scheme, host and port, so any
 * path of a path-prefix deployment) carry `userAgent`; every other request is left as it is.
 */
export function installDesktopUserAgent(
  session: HeaderSession,
  origin: string,
  userAgent: string,
): void {
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (originOf(details.url) !== origin) {
      callback({});
      return;
    }
    const requestHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(details.requestHeaders)) {
      if (name.toLowerCase() !== "user-agent") requestHeaders[name] = value;
    }
    requestHeaders["User-Agent"] = userAgent;
    callback({ requestHeaders });
  });
}
