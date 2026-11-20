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
// The engine matches the URL the WebView has parsed: `\` is already `/`, literal dot segments are
// resolved, the host is lower case; percent-escapes, doubled slashes and userinfo stay as
// written. What the rules tolerate, in place of `canonicalPath`:
//  - userinfo before the host (`user:pass@`);
//  - a separator is `/`, `%2f` or `%5c`, repeated (`SEP`);
//  - each letter or digit of a path word (the base path segments and the route) is the character
//    or its `%xx` escape: `[l%][46]?c?` (the two hex digits are optional, which also accepts a few
//    look-alikes such as `l6c`: block when in doubt);
//  - a pop pair `x<SEP>..` with an escaped dot or slash the engine could not resolve (`POP`),
//    allowed after the host and after every word, nowhere else: the words stay adjacent, so
//    `/api/v1/auth/refresh/login` is not the login route (as in `isInWindowSignIn`).
// Deliberate non-goals, on all three platforms: a double-encoded `%25xx` (the server never
// decodes twice), and an escaped `x` in a pop pair.

const SEP = "([/%]5?c?2?f?)";
const NOT_QS = "[^?#]";
const POP = `(${SEP}+[^?#/%]+${SEP}+[.%]2?e?[.%]2?e?)*`;

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `login` -> `[l%]6?c?[o%]6?f?...`: each letter or digit, or `%` and its two hex digits. */
function word(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase()) {
    if (!/[a-z0-9]/.test(ch)) {
      out += escapeLiteral(ch);
      continue;
    }
    const hex = ch.charCodeAt(0).toString(16);
    // The character itself, or `%`, then the high digit, then the low digit, each optional.
    // An upper-case escape (`%54` for `t`) has the high digit 4 / 5 where the lower case has 6 / 7.
    const hi = /[a-o]/.test(ch) ? "[46]" : /[p-z]/.test(ch) ? "[57]" : "3";
    out += `[${ch}%]${hi}?${hex.charAt(1)}?`;
  }
  return out;
}

/** The path words of the rules: `SEP+ word POP` per segment. */
function words(segments: string[]): string {
  return segments.map((seg) => `${SEP}+${word(seg)}${POP}`).join("");
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
  const prefix = canonicalPath(home.pathname).split("/").filter(Boolean);
  const head = `^${escapeLiteral(home.protocol)}//([^/@]*@)?${escapeLiteral(home.host)}${POP}${words([...prefix, "api", "v1", "auth"])}`;
  const login = `${head}${words(["login"])}${SEP}*`;
  const ssoStart = `${head}${words(["sso"])}${SEP}+[^?#/%]${NOT_QS}*${SEP}+${word("start")}${POP}${SEP}*`;
  // `$` and `[?#]` are the two ends: no alternation, so one rule each.
  return [login, ssoStart].flatMap((filter) =>
    [`${filter}$`, `${filter}[?#]`].map((f) => ({
      trigger: { "url-filter": f },
      action: { type: "block" as const },
    })),
  );
}
