import { expect, test } from "vitest";
import { brand } from "../brand.ts";
import config, { createConfig } from "../electron-builder.config.mjs";

const none = () => false;

test("brand values come from brand.ts", () => {
  const c = createConfig({}, none);
  expect(c.appId).toBe(brand.appId);
  expect(c.productName).toBe(brand.productName);
  expect(c.protocols).toEqual([{ name: brand.productName, schemes: [brand.scheme] }]);
});

test("without secrets: unsigned, no notarization, no binaries entry", () => {
  const c = createConfig({}, none);
  expect(c.mac?.identity).toBeNull();
  expect(c.mac?.notarize).toBe(false);
  expect(c.mac?.binaries).toBeUndefined();
  expect(c.mac?.icon).toBeUndefined();
});

test("with the bundled node present its binary is signed; notarize needs all API vars", () => {
  const signing = {
    CSC_LINK: "x",
    APPLE_API_KEY: "k",
    APPLE_API_KEY_ID: "i",
    APPLE_API_ISSUER: "u",
  };
  const c = createConfig(signing, () => true);
  expect(c.mac?.identity).toBeUndefined();
  expect(c.mac?.notarize).toBe(true);
  expect(c.mac?.binaries).toEqual(["Contents/Resources/node/node"]);
  expect(createConfig({ CSC_LINK: "x" }, none).mac?.notarize).toBe(false);
  expect(
    createConfig({ APPLE_API_KEY: "k", APPLE_API_KEY_ID: "i", APPLE_API_ISSUER: "u" }, none).mac
      ?.identity,
  ).toBeNull();
});

test("the committed icon.icns is the app icon", () => {
  expect(config.mac?.icon).toBe("build/icons/icon.icns");
});

test("the app ships zh and en locales and declares them to macOS (spec §12)", () => {
  const c = createConfig({}, none);
  expect(c.electronLanguages).toEqual(["zh_CN", "en"]);
  // macOS localizes the items it injects into the menus (and the standard dialogs) only for the
  // languages the bundle declares.
  expect(c.mac?.extendInfo).toEqual({
    CFBundleDevelopmentRegion: "en",
    CFBundleLocalizations: ["zh_CN", "en"],
  });
});
