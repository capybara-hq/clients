// The APNs entitlement plumbing (K2): Push.entitlements carries only `aps-environment`, its value
// from Brand.xcconfig; only a brand with APNs push names the file there (apply-brand, K4), so the
// official build's device builds carry no entitlements file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const app = join(import.meta.dirname, "..", "..", "ios", "App");

describe("APNs entitlements", () => {
  test("Push.entitlements holds only aps-environment from the brand", () => {
    const text = readFileSync(join(app, "Push.entitlements"), "utf8");
    const keys = [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys).toEqual(["aps-environment"]);
    expect(text).toMatch(
      /<key>aps-environment<\/key>\s*<string>\$\(BRAND_APS_ENVIRONMENT\)<\/string>/,
    );
  });

  test("the official brand names no entitlements file", () => {
    const xcconfig = readFileSync(join(app, "Brand.xcconfig"), "utf8");
    expect(xcconfig).not.toContain("CODE_SIGN_ENTITLEMENTS");
    expect(xcconfig).not.toContain("BRAND_APS_ENVIRONMENT");
  });
});
