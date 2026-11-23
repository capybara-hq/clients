// electron-builder configuration. Every brand value comes from brand.ts (the only brand file).
// Signing and notarization are conditional on their secrets being present: without them the build
// is unsigned and never reads the Keychain (spec §11; the release workflow enforces the secrets).
import { existsSync } from "node:fs";
import { brand } from "./brand.ts";
import { afterPack } from "./scripts/fuses.ts";

/**
 * @param {Record<string, string | undefined>} env
 * @param {(path: string) => boolean} exists whether a path relative to apps/desktop exists
 * @returns {import("electron-builder").Configuration}
 */
export function createConfig(env, exists) {
  const canSign = Boolean(env.CSC_LINK || env.CSC_NAME);
  const canNotarize = Boolean(
    canSign && env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER,
  );
  const icon = `${brand.icons}/icon.icns`;
  return {
    appId: brand.appId,
    productName: brand.productName,
    directories: { buildResources: "build", output: "release" },
    files: ["dist/**/*", "package.json"],
    asar: true,
    // The app's UI languages (spec §12): Electron's other locales are dropped, and macOS learns
    // them from CFBundleLocalizations below, so the items it injects into menus localize too.
    electronLanguages: ["zh_CN", "en"],
    protocols: [{ name: brand.productName, schemes: [brand.scheme] }],
    afterPack,
    publish: { ...brand.updateFeed },
    mac: {
      target: [
        { target: "dmg", arch: ["universal"] },
        { target: "zip", arch: ["universal"] },
      ],
      category: "public.app-category.productivity",
      extendInfo: { CFBundleDevelopmentRegion: "en", CFBundleLocalizations: ["zh_CN", "en"] },
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: "build/entitlements.mac.plist",
      // electron-builder's inherit plist for the Electron helpers.
      entitlementsInherit: "build/entitlements.node.plist",
      ...(exists(icon) ? { icon } : {}),
      // null: no identity lookup, so an unsigned build never touches the Keychain.
      ...(canSign ? {} : { identity: null }),
      notarize: canNotarize,
    },
  };
}

export default createConfig(process.env, (path) => existsSync(new URL(path, import.meta.url)));
