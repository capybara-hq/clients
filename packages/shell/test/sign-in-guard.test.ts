import { describe, expect, test } from "vitest";
import {
  canonicalPath,
  isInWindowSignIn,
  PATH_LITERALS,
  signInBlockRules,
} from "../src/sign-in-guard.ts";
import vectors from "./fixtures/in-window-sign-in.json" with { type: "json" };

interface Vector {
  method: string;
  url: string;
  base: string;
  blocked: boolean;
  /** iOS rules have no method: a GET of the login route is blocked there too. */
  iosBlocksAnyMethod?: boolean;
}

const all = vectors as Vector[];

/**
 * What WKContentRuleList does with the rules, to the extent the subset allows: the WebView hands
 * the engine its already parsed URL (backslashes become slashes, dot segments are resolved, the
 * host is lower case; escapes and doubled slashes stay), and every url-filter is case-insensitive.
 */
function iosBlocks(base: string, url: string): boolean {
  let href: string;
  try {
    href = new URL(url).href;
  } catch {
    return false;
  }
  return signInBlockRules(base).some((rule) =>
    new RegExp(rule.trigger["url-filter"], "i").test(href),
  );
}

describe("isInWindowSignIn: the shared vectors", () => {
  test.each(all.map((v) => [`${v.method} ${v.url} (base ${v.base})`, v] as const))(
    "%s",
    (_n, v) => {
      expect(isInWindowSignIn(v.method, v.url, v.base)).toBe(v.blocked);
    },
  );
});

describe("signInBlockRules: the WebKit content-blocker emulation", () => {
  test.each(all.map((v) => [`${v.method} ${v.url} (base ${v.base})`, v] as const))(
    "%s",
    (_n, v) => {
      expect(iosBlocks(v.base, v.url)).toBe(v.blocked || v.iosBlocksAnyMethod === true);
    },
  );

  test("every rule stays inside the WebKit url-filter subset and blocks", () => {
    for (const v of all) {
      for (const rule of signInBlockRules(v.base)) {
        const f = rule.trigger["url-filter"];
        expect(rule.action).toEqual({ type: "block" });
        expect(Object.keys(rule.trigger)).toEqual(["url-filter"]);
        let depth = 0;
        let deepest = 0;
        for (const ch of f.replace(/\\./g, "")) {
          if (ch === "(") deepest = Math.max(deepest, ++depth);
          if (ch === ")") depth -= 1;
        }
        expect(deepest, "groups never nest").toBeLessThanOrEqual(1);
        expect(f, "ASCII only").toMatch(/^[\x20-\x7e]*$/);
        expect(f.startsWith("^https://") || f.startsWith("^http://")).toBe(true);
        expect(f, "no alternation").not.toMatch(/(^|[^\\])\|/);
        expect(f, "no counted repetition").not.toMatch(/(^|[^\\])\{/);
        expect(f, "no lookaround or non-capturing group").not.toMatch(/\(\?/);
        expect(f, "no backreference").not.toMatch(/\\[1-9]/);
        expect(f, "no word boundary").not.toMatch(/\\[bB]/);
      }
    }
  });
});

// Every printable ASCII character and two non-ASCII ones, as part of a base path segment.
const CHARS = [
  ...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)),
  "é",
  "团",
];

function escapes(ch: string): string[] {
  const bytes = [...new TextEncoder().encode(ch)].map((b) => b.toString(16).padStart(2, "0"));
  const lower = bytes.map((h) => `%${h}`).join("");
  return [lower, lower.toUpperCase()];
}

/** The parser keeps `ch` as written inside a path segment. */
function parserKeeps(ch: string): boolean {
  return new URL(`https://x.example.com/a${ch}z`).pathname === `/a${ch}z`;
}

describe("signInBlockRules: every character of a base path segment", () => {
  test("PATH_LITERALS is what the URL parser keeps (plus ^, kept by older parsers)", () => {
    const kept = CHARS.filter((ch) => !/[a-zA-Z0-9%/]/.test(ch) && parserKeeps(ch));
    expect([...PATH_LITERALS].filter((ch) => ch !== "^").sort()).toEqual(kept.sort());
    expect(parserKeeps("%"), "a stray % stays as written: the rules accept it").toBe(true);
    expect(parserKeeps("^")).toBe(false);
  });

  const routes = [
    ["POST", "/api/v1/auth/login"],
    ["GET", "/api/v1/auth/sso/lark/start"],
  ] as const;
  test.each(CHARS.map((ch) => [JSON.stringify(ch), ch] as const))(
    "a%sz: the iOS rules block exactly what isInWindowSignIn blocks",
    (_n, ch) => {
      const segments = [`a${ch}z`, ...escapes(ch).map((e) => `a${e}z`)];
      const bases = segments.flatMap((seg) => {
        const literal = `https://x.example.com/${seg}`;
        return [literal, new URL(literal).href];
      });
      let blocked = 0;
      for (const base of bases) {
        for (const seg of segments) {
          for (const [method, route] of routes) {
            for (const suffix of [route, `${route}?next=1`]) {
              const literal = `https://x.example.com/${seg}${suffix}`;
              for (const url of [literal, new URL(literal).href]) {
                const guard = isInWindowSignIn(method, url, base);
                expect(iosBlocks(base, url), `${method} ${url} (base ${base})`).toBe(guard);
                if (guard) blocked += 1;
              }
            }
          }
        }
      }
      // Each spelling of the base matches its escaped URLs at least, so the loop is not vacuous.
      expect(blocked).toBeGreaterThan(0);
    },
  );

  test("a literal ^ is accepted as well as %5E (older WebViews keep it)", () => {
    const filters = signInBlockRules("https://x.example.com/a^z").map(
      (r) => new RegExp(r.trigger["url-filter"], "i"),
    );
    for (const url of [
      "https://x.example.com/a^z/api/v1/auth/login",
      "https://x.example.com/a%5Ez/api/v1/auth/login",
    ]) {
      expect(filters.some((f) => f.test(url))).toBe(true);
    }
  });
});

describe("canonicalPath", () => {
  test("decodes, collapses, resolves dots and lower-cases", () => {
    expect(canonicalPath("/A//b/./c/../%44")).toBe("/a/b/d");
    expect(canonicalPath("/")).toBe("");
  });
});
