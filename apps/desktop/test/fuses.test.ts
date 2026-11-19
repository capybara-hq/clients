import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { expect, test } from "vitest";
import { electronBinaryPath, fuseConfig } from "../scripts/fuses.ts";

test("the fuse config is exactly the security baseline", () => {
  expect(fuseConfig).toEqual({
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
  });
});

test("the fuses are flipped on the .app bundle for mac", () => {
  expect(
    electronBinaryPath({
      appOutDir: "/out/mac",
      packager: { appInfo: { productFilename: "Capybara" }, platform: { name: "mac" } },
    }),
  ).toBe("/out/mac/Capybara.app");
});
