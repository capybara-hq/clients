import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { expect, test, vi } from "vitest";
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

test("afterPack flips the fuses on the .app path", async () => {
  vi.resetModules();
  const flipFuses = vi.fn(async () => 0);
  vi.doMock("@electron/fuses", async (orig) => ({
    ...(await orig<typeof import("@electron/fuses")>()),
    flipFuses,
  }));
  const { afterPack, fuseConfig: config } = await import("../scripts/fuses.ts");
  await afterPack({
    appOutDir: "/out/mac",
    packager: { appInfo: { productFilename: "Capybara" }, platform: { name: "mac" } },
  });
  expect(flipFuses).toHaveBeenCalledWith("/out/mac/Capybara.app", config);
  vi.doUnmock("@electron/fuses");
});
