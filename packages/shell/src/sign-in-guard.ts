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
//  - an escaped dot segment the engine cannot resolve (`..%2f`, `%2e%2e%2f`, `%2f..`): a separate
//    rule blocks every URL of the origin that holds one (`DOTS`), whatever its route, because
//    the words of the route rules stay adjacent (`/api/v1/auth/refresh/login` is not the login
//    route, as in `isInWindowSignIn`). No real request carries one.
// WebKit compiles the rules to automata: nested quantified groups and repeated optional parts
// made the compile of a three-segment base never finish (scripts/compile-rules.swift), so a
// rule has no nested groups and no optional part but the escape digits.
// Deliberate non-goals, on all three platforms: a double-encoded `%25xx` (the server never
// decodes twice), and an escaped `x` in a pop pair.

const SEP = "([/%]5?c?2?f?)";
const NOT_QS = "[^?#]";
const DOTS = "[.%]2?e?[.%]2?e?";

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ASCII characters the URL parser leaves unescaped in a path (they may also arrive as `%XX`); any
 * other character (a space, quotes, `<>`, a backtick, braces, non-ASCII) appears only as `%XX` bytes.
 */
const LITERAL_OK = /[-._~+,:;=@!$&'()*]/;

/**
 * `login` -> `[l%][46]?c?...`: each letter or digit, or `%` and its two hex digits. Other
 * characters of a base segment are their literal when a URL may keep it (`-._~`) or else only the
 * UTF-8 `%XX` bytes the WebView keeps (a space, a CJK character): every rule stays ASCII.
 */
function word(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      const hex = ch.charCodeAt(0).toString(16);
      // An upper-case escape (`%54` for `t`) has the high digit 4 / 5 where the lower case has 6 / 7.
      const hi = /[a-o]/.test(ch) ? "[46]" : /[p-z]/.test(ch) ? "[57]" : "3";
      out += `[${ch}%]${hi}?${hex.charAt(1)}?`;
      continue;
    }
    const bytes = [...new TextEncoder().encode(ch)];
    if (bytes.length === 1 && LITERAL_OK.test(ch)) {
      // `-` is last in the class, so it is a literal.
      const hex = (bytes[0] as number).toString(16).padStart(2, "0");
      out += `[%${ch}]${hex.charAt(0)}?${hex.charAt(1)}?`;
      continue;
    }
    for (const byte of bytes) out += `%${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** The path words of the rules: `SEP+ word` per segment. */
function words(segments: string[]): string {
  return segments.map((seg) => `${SEP}+${word(seg)}`).join("");
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
  const origin = `^${escapeLiteral(home.protocol)}//([^/@]*@)?${escapeLiteral(home.host)}`;
  const head = `${origin}${words([...prefix, "api", "v1", "auth"])}`;
  const login = `${head}${words(["login"])}${SEP}*`;
  const ssoStart = `${head}${words(["sso"])}${SEP}+[^?#/%]${NOT_QS}*${SEP}+${word("start")}${SEP}*`;
  // `$` and `[?#]` are the two ends: no alternation, so one rule each.
  const routes = [login, ssoStart].flatMap((filter) => [`${filter}$`, `${filter}[?#]`]);
  // An escaped dot segment next to an escaped slash, anywhere on the origin: `..%2f`, `%2f..`.
  const dots = [`${origin}${NOT_QS}*${DOTS}%[25][fc]`, `${origin}${NOT_QS}*%[25][fc]${DOTS}`];
  return [...routes, ...dots].map((f) => ({
    trigger: { "url-filter": f },
    action: { type: "block" as const },
  }));
}
