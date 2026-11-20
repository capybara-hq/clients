import { t } from "@capybara-hq/shell";
import { describe, expect, test } from "vitest";
import { metaLine } from "../src/local/main-error-model.ts";

const zh = (key: string, vars?: Record<string, string>) => t("zh", key, vars);
const en = (key: string, vars?: Record<string, string>) => t("en", key, vars);

describe("the meta line", () => {
  const host = "capybara.example.com";
  test("expired: the host", () => {
    expect(metaLine({ page: "expired", downSince: null, now: 0, host }, zh)).toBe(host);
  });

  test("unreachable: the host and how long", () => {
    const at = (ms: number) => ({
      page: "unreachable" as const,
      downSince: 1000,
      now: 1000 + ms,
      host,
    });
    expect(metaLine(at(30_500), zh)).toBe(`${host} · 30 秒无响应`);
    expect(metaLine(at(5 * 60_000 + 10), zh)).toBe(`${host} · 5 分钟无响应`);
    expect(metaLine(at(2 * 3_600_000), zh)).toBe(`${host} · 2 小时无响应`);
    expect(metaLine(at(5 * 60_000), en)).toBe(`${host} · no response for 5 min`);
  });
});
