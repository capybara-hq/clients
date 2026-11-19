// electron-builder configuration. Every brand value comes from brand.ts (the only brand file).
// Signing and notarization are conditional on their secrets being present: without them the build
// is unsigned and never reads the Keychain (spec §11; the release workflow enforces the secrets).
import { existsSync } from "node:fs";
import { brand } from "./brand.ts";
import { afterPack } from "./scripts/fuses.ts";

const env = process.env;
const canSign = Boolean(env.CSC_LINK || env.CSC_NAME);
const canNotarize = Boolean(
  canSign && env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER,
);
const icon = `${brand.icons}/icon.icns`;

/** @type {import("electron-builder").Configuration} */
export default {
  appId: brand.appId,
  productName: brand.productName,
  directories: { buildResources: "build", output: "release" },
  files: ["dist/**/*", "package.json"],
  asar: true,
  // The bundled device program and Node runtime stay outside ASAR (spec §5.2); Task 17 fills
  // build/device and build/node. A missing directory is skipped.
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
    binaries: ["Contents/Resources/node/node"],
    ...(existsSync(new URL(icon, import.meta.url)) ? { icon } : {}),
    // null: no identity lookup, so an unsigned build never touches the Keychain.
    ...(canSign ? {} : { identity: null }),
    notarize: canNotarize,
  },
};
