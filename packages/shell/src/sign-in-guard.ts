// Enforcement in the WebView (spec §6.5): a profile's WebView can never sign in inside itself,
// even when a web version still shows the form. Sign-in goes through the system browser. The
// desktop cancels the requests in `onBeforeRequest`; iOS loads `signInBlockRules` as a
// WKContentRuleList; Android ports `isInWindowSignIn` to Kotlin. All three pass one vector file.

const LOGIN = /^\/api\/v1\/auth\/login$/;
// Any provider segment(s): blocking more than the kernel routes is harmless, missing one is not.
const SSO_START = /^\/api\/v1\/auth\/sso\/.+\/start$/;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape stays as written; the rest of the path is still compared.
    return segment;
  }
}

/**
 * The path as a server may end up routing it: percent-escapes decoded (an encoded slash or
 * backslash becomes a separator, which blocks more than it must: block when in doubt), doubled
 * slashes and dot segments resolved, no trailing slash, lower case.
 */
export function canonicalPath(pathname: string): string {
  const decoded = pathname.split("/").map(decodeSegment).join("/").replace(/\\/g, "/");
  const out: string[] = [];
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part.toLowerCase());
  }
  return out.length === 0 ? "" : `/${out.join("/")}`;
}

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
  const prefix = canonicalPath(home.pathname);
  const path = canonicalPath(target.pathname);
  if (!path.startsWith(`${prefix}/`)) return false;
  const route = path.slice(prefix.length);
  if (SSO_START.test(route)) return true;
  return method.toUpperCase() === "POST" && LOGIN.test(route);
}

// The WebKit content-blocker `url-filter` subset: literals, `.`, character classes, `^` `$`, the
// quantifiers `* + ?` on a character, a class or a group. No `|`, no `{n}`, no lookarounds, no
// non-capturing groups, no backreferences. Rules are case-insensitive by default.
//
// The engine matches the URL the WebView has parsed: `\` is already `/`, dot segments are
// resolved, the host is lower case, while percent-escapes and doubled slashes stay as written.
// What the rules therefore tolerate, in place of `canonicalPath`:
//  - a separator is `/`, `%2f` or `%5c`, repeated (`SEP`);
//  - each letter of a route word is the letter or its `%xx` escape: `[l%]6?c?` (the first digit
//    and the letter's own hex digit are optional, which also accepts a few look-alikes such as
//    `l6c`: block when in doubt);
//  - anything may sit between `v1` and the final word (`..%2f` segments the engine cannot
//    resolve), but the word before the last separator and after it stay literal.
// Not reproduced: a double-encoded `%25xx`, which `canonicalPath` does not decode either.

const SEP = "([/%]5?c?2?f?)";
const NOT_QS = "[^?#]";

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `login` -> `[l%]6?c?[o%]6?f?...`: each letter, or `%` and its two hex digits. */
function word(text: string): string {
  let out = "";
  for (const ch of text) {
    const hex = ch.charCodeAt(0).toString(16);
    const hi = hex.charAt(0);
    const lo = hex.charAt(1);
    // The letter itself, or `%`, then the high digit, then the low digit, each optional.
    out += `[${ch}%]${hi}?${lo}?`;
  }
  return out;
}

/**
 * WebKit content-blocker rules (no `|`, case-insensitive by default) that block the two routes:
 * `<base>/api/v1/auth/login` and `<base>/api/v1/auth/sso/<provider>/start`. They match every
 * method (iOS rules know none), so a GET of the login route is blocked too. `base` is a
 * normalized deployment address; a base that does not parse yields no rules.
 */
export function signInBlockRules(
  base: string,
): { trigger: { "url-filter": string }; action: { type: "block" } }[] {
  const home = parse(base);
  if (!home || (home.protocol !== "https:" && home.protocol !== "http:")) return [];
  const prefix = escapeLiteral(home.pathname.replace(/\/+$/, ""));
  const head = `^${escapeLiteral(`${home.protocol}//${home.host}`)}${prefix}${SEP}+${word("api")}${SEP}+${word("v1")}`;
  const login = `${head}${NOT_QS}*${word("auth")}${NOT_QS}*${SEP}${word("login")}${SEP}*`;
  const ssoStart = `${head}${NOT_QS}*${word("auth")}${NOT_QS}*${word("sso")}${SEP}+[^?#/%]${NOT_QS}*${SEP}+${word("start")}${SEP}*`;
  // `$` and `[?#]` are the two ends: no alternation, so one rule each.
  return [login, ssoStart].flatMap((filter) =>
    [`${filter}$`, `${filter}[?#]`].map((f) => ({
      trigger: { "url-filter": f },
      action: { type: "block" as const },
    })),
  );
}
