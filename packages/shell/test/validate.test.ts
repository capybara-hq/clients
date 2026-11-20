import { describe, expect, test } from "vitest";
import { isBackgroundColor, isRecord, sameOriginUrl } from "../src/validate.ts";

const ORIGIN = "https://capybara.example.com";

describe("sameOriginUrl", () => {
  test("resolves an absolute path on the origin", () => {
    expect(sameOriginUrl("/a?b=1", ORIGIN)).toBe("https://capybara.example.com/a?b=1");
  });
  test("refuses what could leave the origin", () => {
    for (const p of ["//x.example.com/a", "/\\x.example.com", "a", "https://x.example.com/"]) {
      expect(sameOriginUrl(p, ORIGIN), p).toBeNull();
    }
  });
});

describe("isBackgroundColor", () => {
  test("accepts #rgb and #rrggbb only", () => {
    for (const c of ["#fff", "#FFFFFF", "#101418"]) expect(isBackgroundColor(c)).toBe(true);
    for (const c of ["#ffff", "#ffffffff", "red", "fff", "rgb(0,0,0)"]) {
      expect(isBackgroundColor(c), c).toBe(false);
    }
  });
});

describe("isRecord", () => {
  test("plain objects only", () => {
    expect(isRecord({})).toBe(true);
    for (const v of [null, [], "x", 1, undefined]) expect(isRecord(v)).toBe(false);
  });
});
