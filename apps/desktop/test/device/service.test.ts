import { expect, test, vi } from "vitest";
import type { DeviceCli } from "../../src/main/device/cli.ts";
import {
  createDeviceService,
  type ServiceStatus,
  withDockerPath,
} from "../../src/main/device/service.ts";

const RES = "/Applications/Capybara.app/Contents/Resources";
const OWN_BIN = `${RES}/device/bin/capybara-device.mjs`;
const OWN_NODE = `${RES}/node/node`;

/**
 * A fake device CLI: `service status -c <id> --json` answers `status`, or `byId[id]` when
 * `byId` is set (one status per connection); other commands are recorded.
 */
function fakeCli(
  status: Partial<ServiceStatus> | undefined,
  codes: Record<string, number> = {},
  byId?: Record<string, Partial<ServiceStatus>>,
) {
  const calls: string[] = [];
  const cli: DeviceCli = async (args, o) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    const m = /^service status -c (\S+) --json$/.exec(cmd);
    if (m) {
      const one = byId ? byId[m[1] ?? ""] : status;
      if (one) {
        o?.onLine?.({
          installed: false,
          loaded: false,
          running: false,
          binExists: false,
          ...one,
        });
      }
      return { code: one?.running ? 0 : 1, stderr: "" };
    }
    return { code: codes[cmd] ?? 0, stderr: codes[cmd] ? "launchctl failed" : "" };
  };
  return { cli, calls };
}

function service(cli: DeviceCli, resourcesPath = RES, ids = ["dev_1"]) {
  // Paths compare as given (no real files behind them in tests).
  return createDeviceService({
    cli,
    resourcesPath,
    realpath: (p) => p,
    connections: async () => ids.map((deviceId) => ({ deviceId })),
  });
}

const ST = "service status -c dev_1 --json";

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
  await expect(service(f.cli).ensureService("dev_1")).resolves.toBe("installed");
  expect(f.calls).toEqual([ST, "service install -c dev_1"]);
});

test("ensureService keeps the app's own service", async () => {
  const f = fakeCli(appCopy);
  await expect(service(f.cli).ensureService("dev_1")).resolves.toBe("kept");
  expect(f.calls).toEqual([ST]);
});

test("ensureService keeps a CLI-installed service", async () => {
  const f = fakeCli({
    ...appCopy,
    nodePath: "/opt/homebrew/bin/node",
    binPath: "/opt/homebrew/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs",
  });
  await expect(service(f.cli).ensureService("dev_1")).resolves.toBe("kept");
  expect(f.calls).toEqual([ST]);
});

test("ensureService reinstalls when the service's bin is gone (the app moved)", async () => {
  const f = fakeCli({
    ...appCopy,
    binPath: "/Users/me/Downloads/Capybara.app/Contents/Resources/device/bin/capybara-device.mjs",
    binExists: false,
  });
  await expect(service(f.cli).ensureService("dev_1")).resolves.toBe("reinstalled");
  expect(f.calls).toEqual([ST, "service install -c dev_1"]);
});

test("ensureService keeps another app bundle's copy while its bin exists", async () => {
  const f = fakeCli({
    ...appCopy,
    binPath:
      "/Users/me/Applications/Capybara.app/Contents/Resources/device/bin/capybara-device.mjs",
    nodePath: "/Users/me/Applications/Capybara.app/Contents/Resources/node/node",
  });
  await expect(service(f.cli).ensureService("dev_1")).resolves.toBe("kept");
  expect(f.calls).toEqual([ST]);
});

test("two app copies never take the service back and forth", async () => {
  const other = "/Users/me/Applications/Capybara.app/Contents/Resources";
  const f = fakeCli({
    ...appCopy,
    binPath: `${other}/device/bin/capybara-device.mjs`,
    nodePath: `${other}/node/node`,
  });
  await expect(service(f.cli).repairService()).resolves.toEqual(new Map([["dev_1", "kept"]]));
  await expect(service(f.cli, other).repairService()).resolves.toEqual(
    new Map([["dev_1", "kept"]]),
  );
  expect(f.calls).not.toContain("service install -c dev_1");
});

test("ensureService reinstalls the app's copy when it runs another node", async () => {
  const f = fakeCli({ ...appCopy, nodePath: "/usr/local/bin/node" });
  await expect(service(f.cli).ensureService("dev_1")).resolves.toBe("reinstalled");
});

test("a failed install rejects with the CLI's stderr", async () => {
  const f = fakeCli({ installed: false }, { "service install -c dev_1": 1 });
  await expect(service(f.cli).ensureService("dev_1")).rejects.toThrow(/launchctl failed/);
});

test("an unreadable service status rejects", async () => {
  const f = fakeCli(undefined);
  await expect(service(f.cli).ensureService("dev_1")).rejects.toThrow(/service status/);
});

test("ensureService refuses to install from a translocated or mounted app", async () => {
  for (const res of [
    "/private/var/folders/x/AppTranslocation/ABC/d/Capybara.app/Contents/Resources",
    "/Volumes/Capybara/Capybara.app/Contents/Resources",
  ]) {
    const f = fakeCli({ installed: false });
    await expect(service(f.cli, res).ensureService("dev_1")).rejects.toMatchObject({
      code: "app_location",
    });
    expect(f.calls).not.toContain("service install -c dev_1");
  }
});

test("repairService leaves a machine without a service alone", async () => {
  const f = fakeCli({ installed: false });
  await expect(service(f.cli).repairService()).resolves.toEqual(new Map([["dev_1", "absent"]]));
  expect(f.calls).toEqual([ST]);
});

test("repairService reinstalls a loaded app service whose bin moved", async () => {
  const f = fakeCli({ ...appCopy, running: false, binExists: false });
  await expect(service(f.cli).repairService()).resolves.toEqual(
    new Map([["dev_1", "reinstalled"]]),
  );
  expect(f.calls).toEqual([ST, "service install -c dev_1"]);
});

test("repairService keeps a loaded CLI service whose bin is gone", async () => {
  const f = fakeCli({
    ...appCopy,
    nodePath: "/Users/me/.nvm/versions/node/v22.12.0/bin/node",
    binPath:
      "/Users/me/.nvm/versions/node/v22.12.0/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs",
    binExists: false,
  });
  await expect(service(f.cli).repairService()).resolves.toEqual(new Map([["dev_1", "kept"]]));
  expect(f.calls).toEqual([ST]);
});

test("repairService reinstalls another app copy whose bin is gone", async () => {
  const f = fakeCli({
    ...appCopy,
    binPath: "/Users/me/Downloads/Capybara.app/Contents/Resources/device/bin/capybara-device.mjs",
    binExists: false,
  });
  await expect(service(f.cli).repairService()).resolves.toEqual(
    new Map([["dev_1", "reinstalled"]]),
  );
});

test("repairService does not start a service that is not loaded (paused)", async () => {
  const f = fakeCli({ ...appCopy, loaded: false, running: false, binExists: false });
  await expect(service(f.cli).repairService()).resolves.toEqual(new Map([["dev_1", "kept"]]));
  expect(f.calls).toEqual([ST]);
});

test("afterUpdate restarts the app's copy when it runs an older version", async () => {
  const f = fakeCli({ ...appCopy, runningVersion: "0.1.0-rc.17" });
  await service(f.cli).afterUpdate();
  expect(f.calls).toEqual([ST, "service restart -c dev_1"]);
});

test("afterUpdate leaves the app's copy alone when its version is current", async () => {
  const f = fakeCli(appCopy);
  await service(f.cli).afterUpdate();
  expect(f.calls).toEqual([ST]);
});

test("afterUpdate never restarts a CLI-installed service", async () => {
  const f = fakeCli({
    ...appCopy,
    runningVersion: "0.1.0-rc.17",
    nodePath: "/usr/local/bin/node",
    binPath: "/usr/local/lib/node_modules/@capybara-hq/device/bin/capybara-device.mjs",
  });
  await service(f.cli).afterUpdate();
  expect(f.calls).toEqual([ST]);
});

test("afterUpdate never starts a service that is not running", async () => {
  const { runningVersion: _gone, pid: _pid, ...stopped } = appCopy;
  const f = fakeCli({ ...stopped, running: false, installedVersion: "0.1.0-rc.19" });
  await service(f.cli).afterUpdate();
  expect(f.calls).toEqual([ST]);
});

test("withDockerPath adds the usual docker locations to the inherited PATH, once each", () => {
  expect(withDockerPath("/usr/bin:/bin:/usr/sbin:/sbin")).toBe(
    "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin",
  );
  // The person's own order wins; nothing is doubled.
  expect(withDockerPath("/opt/homebrew/bin:/usr/bin:/usr/local/bin")).toBe(
    "/opt/homebrew/bin:/usr/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin",
  );
  expect(withDockerPath(undefined)).toBe(
    "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin",
  );
  expect(withDockerPath("::/usr/bin:")).toBe(
    "/usr/bin:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin",
  );
});

test("service install records a PATH that finds docker, not launchd's short one", async () => {
  const envs: (Record<string, string> | undefined)[] = [];
  const cli: DeviceCli = async (args, o) => {
    if (args.join(" ") === ST) {
      o?.onLine?.({ installed: false, loaded: false, running: false, binExists: false });
      return { code: 1, stderr: "" };
    }
    if (args[0] === "service" && args[1] === "install") envs.push(o?.env);
    return { code: 0, stderr: "" };
  };
  const s = createDeviceService({
    cli,
    resourcesPath: RES,
    realpath: (p) => p,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    connections: async () => [],
  });
  expect(await s.ensureService("dev_1")).toBe("installed");
  expect(envs).toEqual([
    {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin",
    },
  ]);
});

test("the start-up checks go over every connection, each by its own -c, past a failure", async () => {
  const f = fakeCli(
    undefined,
    { "service install -c dev_a": 1 },
    {
      dev_a: { ...appCopy, running: false, binExists: false },
      dev_b: { installed: false },
      dev_c: { ...appCopy, runningVersion: "0.1.0-rc.17" },
    },
  );
  const log = vi.fn();
  const s = createDeviceService({
    cli: f.cli,
    resourcesPath: RES,
    realpath: (p) => p,
    connections: async () => [{ deviceId: "dev_a" }, { deviceId: "dev_b" }, { deviceId: "dev_c" }],
    log,
  });
  // dev_a's install fails: dev_b and dev_c are still checked, and the failure is thrown last.
  await expect(s.repairService()).rejects.toThrow(/launchctl failed/);
  expect(f.calls).toEqual([
    "service status -c dev_a --json",
    "service install -c dev_a",
    "service status -c dev_b --json",
    "service status -c dev_c --json",
  ]);
  expect(log).toHaveBeenCalledOnce();
  f.calls.length = 0;
  await s.afterUpdate();
  expect(f.calls).toEqual([
    "service status -c dev_a --json",
    "service status -c dev_b --json",
    "service status -c dev_c --json",
    "service restart -c dev_c",
  ]);
});

test("no connection: the start-up checks run nothing", async () => {
  const f = fakeCli(appCopy);
  const s = service(f.cli, RES, []);
  await expect(s.repairService()).resolves.toEqual(new Map());
  await s.afterUpdate();
  expect(f.calls).toEqual([]);
});
