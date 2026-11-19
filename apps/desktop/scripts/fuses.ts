// Electron fuses, flipped in the electron-builder afterPack hook (before signing), so the signed
// and notarized app carries them. Spec §7.2: the app binary never doubles as a Node interpreter.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";
import { verifyPackedResources } from "./verify-resources.ts";

export const fuseConfig = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
} as const;

/** The subset of electron-builder's AfterPackContext this hook reads. */
export interface AfterPackContext {
  appOutDir: string;
  packager: { appInfo: { productFilename: string }; platform: { name: string } };
}

/** Where the Electron executable sits inside a packed app directory. */
export function electronBinaryPath(context: AfterPackContext): string {
  const { productFilename } = context.packager.appInfo;
  switch (context.packager.platform.name) {
    case "mac":
      return join(context.appOutDir, `${productFilename}.app`);
    case "windows":
      return join(context.appOutDir, `${productFilename}.exe`);
    default:
      return join(context.appOutDir, productFilename);
  }
}

export async function afterPack(context: AfterPackContext): Promise<void> {
  // macOS: the bundled Node and device must be exactly what bundle-node made (each arch slice).
  if (context.packager.platform.name === "mac") {
    verifyPackedResources(electronBinaryPath(context), {
      root: fileURLToPath(new URL("..", import.meta.url)),
    });
  }
  await flipFuses(electronBinaryPath(context), fuseConfig);
}
