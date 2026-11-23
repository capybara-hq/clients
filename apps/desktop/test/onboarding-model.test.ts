import { t } from "@capybara-hq/shell";
import { describe, expect, test } from "vitest";
import {
  accountLine,
  CONNECT_ERRORS,
  connectErrorKeys,
  platformLabel,
  SIGN_IN_ERRORS,
  signInErrorKeys,
} from "../src/local/onboarding-model.ts";

const zh = (key: string, vars?: Record<string, string>) => t("zh", key, vars);

describe("the onboarding page model", () => {
  test("every connect error has its message and button in both catalogs", () => {
    for (const code of CONNECT_ERRORS) {
      const keys = connectErrorKeys(code);
      for (const locale of ["zh", "en"] as const) {
        expect(t(locale, keys.message), code).not.toBe(keys.message);
        expect(t(locale, keys.action), code).not.toBe(keys.action);
      }
    }
    expect(zh(connectErrorKeys("unreachable").message, { host: "a.example.com" })).toBe(
      "连接不上 a.example.com。检查地址是否拼错，或者网络、VPN 是否已连接。",
    );
    expect(zh(connectErrorKeys("cert_invalid").action)).toBe("重试");
    expect(zh(connectErrorKeys("not_https").action)).toBe("继续");
    // Anything unknown reads as a plain failure.
    expect(connectErrorKeys("<script>")).toEqual(connectErrorKeys("failed"));
  });

  test("every sign-in error has its message and button (board ErrorsSignIn)", () => {
    for (const code of SIGN_IN_ERRORS) {
      const keys = signInErrorKeys(code);
      for (const locale of ["zh", "en"] as const) {
        expect(t(locale, keys.message), code).not.toBe(keys.message);
        expect(t(locale, keys.action), code).not.toBe(keys.action);
      }
    }
    expect(zh(signInErrorKeys("account_unusable").action)).toBe("换个账号登录");
    expect(zh(signInErrorKeys("not_allowed").action)).toBe("重试");
    expect(signInErrorKeys("other")).toEqual(signInErrorKeys("link_invalid"));
  });

  test("the platform's label is its name, else its host", () => {
    expect(platformLabel({ name: "Meta1", host: "m.example.com" })).toBe("Meta1");
    expect(platformLabel({ name: " ", host: "m.example.com" })).toBe("m.example.com");
    expect(platformLabel(undefined)).toBe("");
  });

  test("the signed-out account line", () => {
    const account = { name: "Grant", login: "grant@meta1.top" };
    expect(accountLine(account, zh)).toBe("grant@meta1.top");
    expect(accountLine({ name: "Grant", login: "" }, zh)).toBe("Grant");
    expect(accountLine(null, zh)).toBe("");
  });
});
