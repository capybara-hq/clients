import { describe, expect, test } from "vitest";
import { canonicalPath, isInWindowSignIn, signInBlockRules } from "../src/sign-in-guard.ts";
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

describe("canonicalPath", () => {
  test("decodes, collapses, resolves dots and lower-cases", () => {
    expect(canonicalPath("/A//b/./c/../%44")).toBe("/a/b/d");
    expect(canonicalPath("/")).toBe("");
  });
});
