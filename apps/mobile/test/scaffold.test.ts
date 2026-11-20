import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const app = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFile(`${app}${rel}`, "utf8");

// Google Play's target API level requirement for new apps and updates (API 36 since 2026-08-31).
const PLAY_TARGET_SDK = 36;

function gradleInt(source: string, name: string): number {
  const match = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`).exec(source);
  if (!match?.[1]) throw new Error(`${name} not found`);
  return Number(match[1]);
}

describe("the Capacitor configuration", () => {
  test("loads only local pages: no remote server URL and no extra navigation", async () => {
    const { default: config } = await import("../capacitor.config.ts");
    expect(config.server?.url).toBeUndefined();
    expect(config.server?.allowNavigation).toBeUndefined();
    expect(config.webDir).toBe("dist/local");
  });

  test("leaves bundledWebRuntime unset", async () => {
    const { default: config } = await import("../capacitor.config.ts");
    expect("bundledWebRuntime" in config).toBe(false);
  });

  test("takes the app id and name from the brand file", async () => {
    const { default: config } = await import("../capacitor.config.ts");
    const { brand } = await import("../brand.ts");
    expect(config.appId).toBe(brand.appId);
    expect(config.appName).toBe(brand.productName);
  });

  test("keeps CapacitorCookies and CapacitorHttp off", async () => {
    const { default: config } = await import("../capacitor.config.ts");
    expect(config.plugins?.CapacitorCookies).toEqual({ enabled: false });
    expect(config.plugins?.CapacitorHttp).toEqual({ enabled: false });
  });
});

describe("the native projects", () => {
  test("target iOS 17.0 in every build configuration", async () => {
    const pbxproj = await read("ios/App/App.xcodeproj/project.pbxproj");
    const targets = [...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(
      (m) => m[1],
    );
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets)).toEqual(new Set(["17.0"]));
  });

  test("use Capacitor's default Android minSdk and Play's current targetSdk", async () => {
    const variables = await read("android/variables.gradle");
    const capacitor = await read("node_modules/@capacitor/android/capacitor/build.gradle");
    const fallback = /minSdkVersion\s+project\.hasProperty\('minSdkVersion'\)[^:]*:\s*(\d+)/.exec(
      capacitor,
    );
    expect(fallback?.[1]).toBeDefined();
    expect(gradleInt(variables, "minSdkVersion")).toBe(Number(fallback?.[1]));
    expect(gradleInt(variables, "targetSdkVersion")).toBe(PLAY_TARGET_SDK);
  });
});
