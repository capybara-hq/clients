import { describe, expect, test } from "vitest";
import { checkCatalogs } from "../scripts/check-i18n.ts";
import en from "../src/i18n/en.json" with { type: "json" };
import { t } from "../src/i18n/index.ts";
import zh from "../src/i18n/zh.json" with { type: "json" };

describe("t", () => {
  test("looks up per locale and fills placeholders", () => {
    expect(t("zh", "address.error.too_old")).toBe("该平台版本过旧");
    expect(t("zh", "platform.add")).toBe("添加平台");
    expect(t("en", "platform.add")).toBe("Add a platform");
  });
  test("placeholders", () => {
    expect(t("en", "greeting.test", { name: "A" })).toContain("A");
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
});
