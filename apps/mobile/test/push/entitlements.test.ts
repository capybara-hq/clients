// The APNs entitlement plumbing (K2): Push.entitlements carries only `aps-environment`, its value
// from Brand.xcconfig; only a brand with APNs push names the file there (apply-brand), so the
// official build's device builds carry no entitlements file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { brand } from "../../brand.ts";

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

  test("Brand.xcconfig names the entitlements file only when the brand carries APNs", () => {
    const xcconfig = readFileSync(join(app, "Brand.xcconfig"), "utf8");
    const apns = brand.push?.apns !== undefined;
    expect(xcconfig.includes("CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*] = Push.entitlements")).toBe(
      apns,
    );
    expect(xcconfig.includes("BRAND_APS_ENVIRONMENT = ")).toBe(apns);
  });
});
