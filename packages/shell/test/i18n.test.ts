import { describe, expect, test } from "vitest";
import { checkCatalogs } from "../scripts/check-i18n.ts";
import en from "../src/i18n/en.json" with { type: "json" };
import { createT, t } from "../src/i18n/index.ts";
import zh from "../src/i18n/zh.json" with { type: "json" };

describe("t", () => {
  test("looks up per locale and fills placeholders", () => {
    expect(t("zh", "address.error.too_old")).toBe("该平台版本过旧");
    expect(t("zh", "platform.add")).toBe("添加平台");
    expect(t("en", "platform.add")).toBe("Add a platform");
  });
  test("placeholders", () => {
    const tt = createT({ zh: { hi: "你好，{name}" }, en: { hi: "Hello, {name} {name}" } });
    expect(tt("en", "hi", { name: "A" })).toBe("Hello, A A");
    expect(tt("zh", "hi", {})).toBe("你好，{name}");
  });
  test("prototype keys fall back to the key", () => {
    expect(t("en", "__proto__")).toBe("__proto__");
    expect(t("en", "constructor")).toBe("constructor");
  });
  test("an unknown key returns the key", () => {
    expect(t("en", "no.such.key")).toBe("no.such.key");
  });
});

describe("shipped catalogs", () => {
  test("zh and en have the same keys", () => {
    expect(checkCatalogs(zh, en)).toEqual([]);
  });
});

describe("checkCatalogs", () => {
  test("reports keys present in one language only", () => {
    const problems = checkCatalogs({ a: "1", b: "2" }, { a: "1", c: "3" });
    expect(problems).toEqual(['"b" is missing in en', '"c" is missing in zh']);
  });
  test("reports differing placeholders", () => {
    expect(checkCatalogs({ a: "{x} y" }, { a: "{x} {z}" })).toEqual([
      '"a" has different placeholders in zh and en',
    ]);
    expect(checkCatalogs({ a: "{x} {y}" }, { a: "{y}{x}" })).toEqual([]);
  });
});
