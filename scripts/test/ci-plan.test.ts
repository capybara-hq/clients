import { describe, expect, it } from "vitest";
import { planForFile, planFromFiles } from "../ci-plan.ts";

const none = { macosTest: false, e2e: false, ios: false, android: false };
const all = { macosTest: true, e2e: true, ios: true, android: true };

describe("planForFile", () => {
  it.each([
    "README.md",
    "apps/desktop/README.md",
    "docs/fork-guide.md",
    "scripts/verify.ts",
    ".changeset/brave-cats.md",
    ".github/workflows/release.yml",
    "biome.json",
    "apps/mobile/fastlane/Fastfile",
    "apps/mobile/Gemfile.lock",
  ])("%s needs no slow job", (file) => {
    expect(planForFile(file)).toEqual(none);
  });

  it.each([
    ".github/workflows/ci.yml",
    "packages/shell/src/i18n/zh.json",
    "pnpm-lock.yaml",
    "package.json",
    "patches/electron.patch",
    "vitest.config.ts",
    "tsconfig.base.json",
    "something/new.ts",
  ])("%s needs every slow job", (file) => {
    expect(planForFile(file)).toEqual(all);
  });

  it("a desktop file needs the macOS tests and the e2e smoke", () => {
    expect(planForFile("apps/desktop/src/main/tray.ts")).toEqual({
      ...none,
      macosTest: true,
      e2e: true,
    });
  });

  it("native mobile code needs only its own platform's suite", () => {
    expect(planForFile("apps/mobile/ios/App/App/AppDelegate.swift")).toEqual({
      ...none,
      ios: true,
    });
    expect(planForFile("apps/mobile/android/app/build.gradle")).toEqual({ ...none, android: true });
  });

  it("other mobile code needs both native suites", () => {
    expect(planForFile("apps/mobile/src/bridge.ts")).toEqual({ ...none, ios: true, android: true });
  });
});

describe("planFromFiles", () => {
  it("is the union of the files' plans", () => {
    expect(
      planFromFiles(["docs/a.md", "apps/mobile/ios/x.swift", "apps/desktop/src/y.ts"]),
    ).toEqual({ macosTest: true, e2e: true, ios: true, android: false });
  });

  it("an empty diff needs no slow job", () => {
    expect(planFromFiles([])).toEqual(none);
  });
});
