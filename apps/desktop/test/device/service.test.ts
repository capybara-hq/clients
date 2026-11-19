import { expect, test } from "vitest";
import type { DeviceCli } from "../../src/main/device/cli.ts";
import { createDeviceService, type ServiceStatus } from "../../src/main/device/service.ts";

const RES = "/Applications/Capybara.app/Contents/Resources";
const OWN_BIN = `${RES}/device/bin/capybara-device.mjs`;
const OWN_NODE = `${RES}/node/node`;

/** A fake device CLI: `service status --json` answers `status`; other commands are recorded. */
function fakeCli(status: Partial<ServiceStatus> | undefined, codes: Record<string, number> = {}) {
  const calls: string[] = [];
  const cli: DeviceCli = async (args, o) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    if (cmd === "service status --json") {
      if (status) {
        o?.onLine?.({
          installed: false,
          loaded: false,
          running: false,
          binExists: false,
          ...status,
        });
      }
      return { code: status?.running ? 0 : 1, stderr: "" };
    }
    return { code: codes[cmd] ?? 0, stderr: codes[cmd] ? "launchctl failed" : "" };
  };
  return { cli, calls };
}

function service(cli: DeviceCli, resourcesPath = RES) {
  // Paths compare as given (no real files behind them in tests).
  return createDeviceService({ cli, resourcesPath, realpath: (p) => p });
}

const appCopy: Partial<ServiceStatus> = {
  installed: true,
  loaded: true,
  running: true,
  pid: 7,
  nodePath: OWN_NODE,
  binPath: OWN_BIN,
  binExists: true,
  runningVersion: "0.1.0-rc.18",
  installedVersion: "0.1.0-rc.18",
};

test("ensureService installs when no service is installed", async () => {
  const f = fakeCli({ installed: false });
  await expect(service(f.cli).ensureService()).resolves.toBe("installed");
  expect(f.calls).toEqual(["service status --json", "service install"]);
});

test("ensureService keeps the app's own service", async () => {
  const f = fakeCli(appCopy);
  await expect(service(f.cli).ensureService()).resolves.toBe("kept");
  expect(f.calls).toEqual(["service status --json"]);
});

test("ensureService keeps a CLI-installed service", async () => {
  const f = fakeCli({
    ...appCopy,
    nodePath: "/opt/homebrew/bin/node",
    binPath: "/opt/homebrew/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs",
  });
  await expect(service(f.cli).ensureService()).resolves.toBe("kept");
  expect(f.calls).toEqual(["service status --json"]);
});

test("ensureService reinstalls when the service's bin is gone (the app moved)", async () => {
  const f = fakeCli({
    ...appCopy,
    binPath: "/Users/me/Downloads/Capybara.app/Contents/Resources/device/bin/capybara-device.mjs",
    binExists: false,
  });
  await expect(service(f.cli).ensureService()).resolves.toBe("reinstalled");
  expect(f.calls).toEqual(["service status --json", "service install"]);
});

test("ensureService reinstalls when the service runs another app bundle's copy", async () => {
  const f = fakeCli({
    ...appCopy,
    binPath:
      "/Users/me/Applications/Capybara.app/Contents/Resources/device/bin/capybara-device.mjs",
    nodePath: "/Users/me/Applications/Capybara.app/Contents/Resources/node/node",
  });
  await expect(service(f.cli).ensureService()).resolves.toBe("reinstalled");
  expect(f.calls).toEqual(["service status --json", "service install"]);
});

test("ensureService reinstalls the app's copy when it runs another node", async () => {
  const f = fakeCli({ ...appCopy, nodePath: "/usr/local/bin/node" });
  await expect(service(f.cli).ensureService()).resolves.toBe("reinstalled");
});

test("a failed install rejects with the CLI's stderr", async () => {
  const f = fakeCli({ installed: false }, { "service install": 1 });
  await expect(service(f.cli).ensureService()).rejects.toThrow(/launchctl failed/);
});

test("an unreadable service status rejects", async () => {
  const f = fakeCli(undefined);
  await expect(service(f.cli).ensureService()).rejects.toThrow(/service status/);
});

test("ensureService refuses to install from a translocated or mounted app", async () => {
  for (const res of [
    "/private/var/folders/x/AppTranslocation/ABC/d/Capybara.app/Contents/Resources",
    "/Volumes/Capybara/Capybara.app/Contents/Resources",
  ]) {
    const f = fakeCli({ installed: false });
    await expect(service(f.cli, res).ensureService()).rejects.toMatchObject({
      code: "app_location",
    });
    expect(f.calls).not.toContain("service install");
  }
});

test("repairService leaves a machine without a service alone", async () => {
  const f = fakeCli({ installed: false });
  await expect(service(f.cli).repairService()).resolves.toBe("absent");
  expect(f.calls).toEqual(["service status --json"]);
});

test("repairService reinstalls a loaded app service whose bin moved", async () => {
  const f = fakeCli({ ...appCopy, running: false, binExists: false });
  await expect(service(f.cli).repairService()).resolves.toBe("reinstalled");
  expect(f.calls).toEqual(["service status --json", "service install"]);
});

test("repairService does not start a service that is not loaded (paused)", async () => {
  const f = fakeCli({ ...appCopy, loaded: false, running: false, binExists: false });
  await expect(service(f.cli).repairService()).resolves.toBe("kept");
  expect(f.calls).toEqual(["service status --json"]);
});

test("afterUpdate restarts the app's copy when it runs an older version", async () => {
  const f = fakeCli({ ...appCopy, runningVersion: "0.1.0-rc.17" });
  await service(f.cli).afterUpdate();
  expect(f.calls).toEqual(["service status --json", "service restart"]);
});

test("afterUpdate leaves the app's copy alone when its version is current", async () => {
  const f = fakeCli(appCopy);
  await service(f.cli).afterUpdate();
  expect(f.calls).toEqual(["service status --json"]);
});

test("afterUpdate never restarts a CLI-installed service", async () => {
  const f = fakeCli({
    ...appCopy,
    runningVersion: "0.1.0-rc.17",
    nodePath: "/usr/local/bin/node",
    binPath: "/usr/local/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs",
  });
  await service(f.cli).afterUpdate();
  expect(f.calls).toEqual(["service status --json"]);
});

test("afterUpdate never starts a service that is not running", async () => {
  const { runningVersion: _gone, pid: _pid, ...stopped } = appCopy;
  const f = fakeCli({ ...stopped, running: false, installedVersion: "0.1.0-rc.19" });
  await service(f.cli).afterUpdate();
  expect(f.calls).toEqual(["service status --json"]);
});
