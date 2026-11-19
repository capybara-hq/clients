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
    // The bundled device program and Node runtime stay outside ASAR (spec §5.2);
    // scripts/bundle-node.ts fills build/device and build/node. A missing directory is skipped.
    extraResources: [
      { from: "build/device", to: "device" },
      { from: "build/node", to: "node" },
    ],
    protocols: [{ name: brand.productName, schemes: [brand.scheme] }],
    afterPack,
    publish: { ...brand.updateFeed },
    mac: {
      target: [
        { target: "dmg", arch: ["universal"] },
        { target: "zip", arch: ["universal"] },
      ],
      category: "public.app-category.productivity",
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: "build/entitlements.mac.plist",
      // electron-builder applies one inherit plist to the helpers and to the binaries below.
      entitlementsInherit: "build/entitlements.node.plist",
      // Only once scripts/bundle-node.ts has filled build/node: signing a missing path would fail
      // a signed run. That node is already one lipo'd universal binary, identical in the x64 and
      // arm64 slices, which @electron/universal keeps as is (no x64ArchFiles entry needed).
      ...(exists("build/node/node") ? { binaries: ["Contents/Resources/node/node"] } : {}),
      ...(exists(icon) ? { icon } : {}),
      // null: no identity lookup, so an unsigned build never touches the Keychain.
      ...(canSign ? {} : { identity: null }),
      notarize: canNotarize,
    },
  };
}

export default createConfig(process.env, (path) => existsSync(new URL(path, import.meta.url)));
