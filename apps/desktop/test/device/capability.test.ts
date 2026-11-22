import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DeviceCeilingRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  BUNDLED_DEVICE_PROTOCOL,
  createDeviceAvailability,
  deviceOffered,
} from "../../src/main/device/availability.ts";
import { createDeviceCapability } from "../../src/main/device/capability.ts";
import type { SpawnLike } from "../../src/main/device/cli.ts";
import {
  type CeilingField,
  ceilingSetArgs,
  connectionsHere,
  connectionView,
  type MachineConnection,
  type OwnerCeiling,
  parseCeilingRequest,
  readCeiling,
  readConnections,
  readKeepAwake,
} from "../../src/main/device/machine.ts";
import { createDeviceTexts } from "../../src/main/device/texts.ts";
import type { Profile } from "../../src/main/profiles.ts";
import {
  carriesSecret,
  connectionJson,
  ctxFor,
  fakeCli,
  fakeControls,
  fakeDialogs,
  fakeService,
  fakeVerification,
  live,
  loggedIn,
  profileA,
  profileB,
  SECRET,
  threeConnections,
} from "./fake-device.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The installed device package: what scripts/bundle-node.ts copies into Resources/device. */
const DEVICE_PKG = join(here, "../../node_modules/@capybara-hq/device");

const TEXTS = {
  ceilingWidening: "WIDENING (from the program)",
  otherConnections: "OTHERS (from the program)",
  outsideSandboxRisk: "RISK (program)",
};

const meta = (over: Record<string, unknown> = {}) => ({
  name: "Acme",
  icon: null,
  protocols: { device: { min: 6, max: 6 } },
  features: { localDevices: true, appSignIn: true },
  ...over,
});

/** The calls that name a device (A's two connections and B's one live on the machine). */
const A1 = { deviceId: "dev_a1" };
const A2 = { deviceId: "dev_a2" };
const B1 = { deviceId: "dev_b1" };

function setup(
  state: Parameters<typeof fakeCli>[0] = {},
  o: {
    answer?: Parameters<typeof fakeDialogs>[0];
    handlers?: Parameters<typeof fakeCli>[1];
    running?: unknown[];
    service?: Parameters<typeof fakeService>[0];
    texts?: () => Promise<typeof TEXTS>;
  } = {},
) {
  const cli = fakeCli({ status: threeConnections(), ...state }, o.handlers);
  const dialogs = fakeDialogs(o.answer ?? true);
  const service = fakeService(o.service);
  const controls = fakeControls(cli.cli, { running: o.running ?? [] });
  const log = vi.fn();
  const device = createDeviceCapability({
    cli: cli.cli,
    controls: controls.controls,
    service,
    dialogs: dialogs.dialogs,
    texts: o.texts ?? (async () => TEXTS),
    openVerification: fakeVerification().open,
    log,
  });
  return { device, cli, dialogs, service, controls, log };
}

describe("when device@2 is offered", () => {
  const base = { platform: "darwin", managed: {}, meta: meta() };

  test("macOS or Linux, not turned off, localDevices, a range holding the bundled protocol", () => {
    expect(deviceOffered(base)).toBe(true);
    expect(deviceOffered({ ...base, platform: "linux" })).toBe(true);
    expect(deviceOffered({ ...base, platform: "win32" })).toBe(false);
    expect(deviceOffered({ ...base, managed: { connectThisMachine: false } })).toBe(false);
    expect(deviceOffered({ ...base, managed: { connectThisMachine: true } })).toBe(true);
    expect(
      deviceOffered({
        ...base,
        meta: meta({ features: { localDevices: false, appSignIn: true } }),
      }),
    ).toBe(false);
    expect(
      deviceOffered({ ...base, meta: meta({ protocols: { device: { min: 7, max: 8 } } }) }),
    ).toBe(false);
    expect(
      deviceOffered({ ...base, meta: meta({ protocols: { device: { min: 1, max: 5 } } }) }),
    ).toBe(false);
    expect(
      deviceOffered({ ...base, meta: meta({ protocols: { device: { min: 5, max: 7 } } }) }),
    ).toBe(true);
    expect(deviceOffered({ ...base, meta: { error: "unreachable" } })).toBe(false);
  });

  test("the bundled protocol is the one the bundled device package speaks", async () => {
    const sdk = join(
      DEVICE_PKG,
      "dist/node_modules/@capybara-hq/plugin-sdk/dist/device-protocol.js",
    );
    const mod = (await import(pathToFileURL(sdk).href)) as { DEVICE_PROTOCOL_VERSION: number };
    expect(BUNDLED_DEVICE_PROTOCOL).toBe(mod.DEVICE_PROTOCOL_VERSION);
  });

  test("availability appears after discovery and announces the change", async () => {
    const onChange = vi.fn();
    const fetchMeta = vi.fn(async () => meta());
    const a = createDeviceAvailability({ platform: "darwin", managed: {}, fetchMeta, onChange });
    expect(a.isAvailable(profileA)).toBe(false);
    await a.evaluate(profileA);
    expect(fetchMeta).toHaveBeenCalledWith(profileA.base);
    expect(a.isAvailable(profileA)).toBe(true);
    expect(onChange).toHaveBeenCalledWith(profileA.id);
    // The same answer again: no change event.
    await a.evaluate(profileA);
    expect(onChange).toHaveBeenCalledTimes(1);
    fetchMeta.mockResolvedValueOnce(meta({ features: { localDevices: false, appSignIn: true } }));
    await a.evaluate(profileA);
    expect(a.isAvailable(profileA)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("no discovery at all where it can never be offered", async () => {
    const fetchMeta = vi.fn(async () => meta());
    const a = createDeviceAvailability({
      platform: "darwin",
      managed: { connectThisMachine: false },
      fetchMeta,
      onChange: vi.fn(),
    });
    await a.evaluate(profileA);
    expect(fetchMeta).not.toHaveBeenCalled();
    expect(a.isAvailable(profileA)).toBe(false);
  });

  test("a failed discovery leaves it off", async () => {
    const a = createDeviceAvailability({
      platform: "linux",
      managed: {},
      fetchMeta: vi.fn(async () => {
        throw new Error("offline");
      }),
      onChange: vi.fn(),
    });
    await a.evaluate(profileA);
    expect(a.isAvailable(profileA)).toBe(false);
  });
});

describe("status", () => {
  test("status answers only this deployment's connections and never names another", async () => {
    const s = setup();
    const st = await s.device.impl.status(ctxFor());
    expect(st.connections.map((c) => c.deviceId)).toEqual(["dev_a1", "dev_a2"]);
    expect(JSON.stringify(st)).not.toMatch(/b\.example\.com|dev_b1/);
    const b = await s.device.impl.status(ctxFor(profileB));
    expect(b.connections.map((c) => c.deviceId)).toEqual(["dev_b1"]);
    expect(JSON.stringify(b)).not.toMatch(/a\.example\.com|dev_a/);
  });

  test("each connection's view: the runner's live state, or stopped with the policy's mode", async () => {
    const s = setup({
      status: threeConnections({
        dev_a1: {
          live: live({
            deviceId: "dev_a1",
            connection: "offline",
            offlineReason: "network",
            keepAwake: { mode: "connected", held: true },
            lastWakeAt: "2026-11-20T07:00:00.000Z",
          }),
        },
        dev_a2: { control: "absent", live: null, serviceInstalled: false },
      }),
      keepAwake: "off",
    });
    expect(await s.device.impl.status(ctxFor())).toEqual({
      connections: [
        {
          deviceId: "dev_a1",
          orgId: "org_1",
          mode: "os",
          connection: "offline",
          offlineReason: "network",
          serviceInstalled: true,
          keepAwake: { mode: "connected", held: true },
          lastWakeAt: "2026-11-20T07:00:00.000Z",
        },
        {
          deviceId: "dev_a2",
          orgId: "org_2",
          mode: "os",
          connection: "stopped",
          serviceInstalled: false,
          keepAwake: { mode: "off", held: false },
        },
      ],
    });
    // The policy is read only for the connection no runner answers for.
    expect(s.cli.commands()).toEqual(["status --json", "keep-awake show -c dev_a2 --json"]);
  });

  test("origins compare normalized (case, default port, trailing slash)", async () => {
    const s = setup({
      status: threeConnections({ dev_a2: { url: "HTTPS://A.EXAMPLE.COM:443/team/" } }),
    });
    const st = await s.device.impl.status(ctxFor());
    expect(st.connections.map((c) => c.deviceId)).toEqual(["dev_a1", "dev_a2"]);
  });

  test("no connection into this deployment: an empty list", async () => {
    const s = setup({ status: { connections: [], unreadable: [] } });
    expect(await s.device.impl.status(ctxFor())).toEqual({ connections: [] });
    const t = setup();
    const other: Profile = {
      ...profileA,
      id: "pc",
      base: "https://c.example.com",
      origin: "https://c.example.com",
    };
    expect(await t.device.impl.status(ctxFor(other))).toEqual({ connections: [] });
  });

  test("an unreadable status fails", async () => {
    const s = setup({}, { handlers: { "status --json": () => ({ code: 1, lines: [] }) } });
    await expect(s.device.impl.status(ctxFor())).rejects.toMatchObject({ code: "failed" });
  });
});

describe("the deployment boundary", () => {
  test("every per-device call naming another deployment's device refuses and runs nothing", async () => {
    const s = setup({}, { answer: true });
    const ctxA = ctxFor();
    const impl = s.device.impl;
    for (const call of [
      () => impl.pause(ctxA, B1),
      () => impl.resume(ctxA, B1),
      () => impl.disconnect(ctxA, B1),
      () => impl.running(ctxA, B1),
      () => impl.requestCeiling(ctxA, { ...B1, outsideSandbox: false }),
      () => impl.requestCeiling(ctxA, { ...B1, outsideSandbox: true }),
      () => impl.setKeepAwake(ctxA, { ...B1, mode: "off" }),
      () => impl.setKeepAwake(ctxA, { ...B1, mode: "connected" }),
    ]) {
      await expect(call()).rejects.toEqual({ code: "failed" });
    }
    expect(s.cli.calls.flatMap((c) => c.args)).not.toContain("dev_b1");
    expect(s.cli.writes()).toEqual([]);
    expect(s.controls.controls.forDevice).not.toHaveBeenCalled();
    expect(s.service.ensureService).not.toHaveBeenCalled();
    expect(s.service.status).not.toHaveBeenCalled();
    expect(s.dialogs.asked).toEqual([]);
    expect(ctxA.confirm).not.toHaveBeenCalled();
  });

  test("an unsafe or unknown device id refuses the same way", async () => {
    const s = setup();
    const ctx = ctxFor();
    const impl = s.device.impl;
    for (const input of [
      undefined,
      null,
      "dev_a1",
      {},
      { deviceId: 7 },
      { deviceId: "" },
      { deviceId: "../dev_a1" },
      { deviceId: "dev_a1 " },
      { deviceId: "-c" },
      { deviceId: "dev_unknown" },
      { deviceId: "a".repeat(200) },
    ]) {
      for (const call of [
        () => impl.pause(ctx, input),
        () => impl.resume(ctx, input),
        () => impl.disconnect(ctx, input),
        () => impl.running(ctx, input),
        () =>
          impl.requestCeiling(ctx, {
            ...(typeof input === "object" && input !== null ? input : {}),
            network: "open",
          }),
        () =>
          impl.setKeepAwake(ctx, {
            ...(typeof input === "object" && input !== null ? input : {}),
            mode: "connected",
          }),
      ]) {
        await expect(call()).rejects.toEqual({ code: "failed" });
      }
    }
    expect(s.cli.writes()).toEqual([]);
    expect(s.controls.controls.forDevice).not.toHaveBeenCalled();
    expect(s.dialogs.asked).toEqual([]);
  });

  test("two connections to one deployment act separately", async () => {
    const s = setup();
    await s.device.impl.pause(ctxFor(), A2);
    expect(s.controls.client("dev_a2").drain).toHaveBeenCalledOnce();
    expect(s.controls.client("dev_a1").drain).not.toHaveBeenCalled();
    await s.device.impl.setKeepAwake(ctxFor(), { ...A1, mode: "off" });
    await s.device.impl.disconnect(ctxFor(), A2);
    expect(s.cli.writes()).toEqual(["keep-awake off -c dev_a1", "stop -c dev_a2"]);
    expect(s.service.status).toHaveBeenCalledWith("dev_a2");
  });

  test("a device another window's deployment owns is refused even when the window is B's twin", async () => {
    // B's window cannot reach A's connections either.
    const s = setup();
    await expect(s.device.impl.pause(ctxFor(profileB), A1)).rejects.toEqual({ code: "failed" });
    await s.device.impl.pause(ctxFor(profileB), B1);
    expect(s.controls.client("dev_b1").drain).toHaveBeenCalledOnce();
    expect(s.controls.client("dev_a1").drain).not.toHaveBeenCalled();
  });
});

describe("running", () => {
  test("lists the named connection's operations, field by field", async () => {
    const op = {
      tag: "t1",
      conversationId: "c1",
      accountId: null,
      isolation: "restricted",
      startedAt: "2026-11-20T08:01:00.000Z",
      command: "rm -rf /",
    };
    const s = setup({}, { running: [op] });
    expect(await s.device.impl.running(ctxFor(), A2)).toEqual([
      {
        tag: "t1",
        conversationId: "c1",
        accountId: null,
        isolation: "restricted",
        startedAt: "2026-11-20T08:01:00.000Z",
      },
    ]);
    expect(s.controls.controls.forDevice).toHaveBeenCalledWith("dev_a2");
    // The socket the read just showed: the read came first.
    expect(s.controls.controls.read.mock.invocationCallOrder[0]).toBeLessThan(
      s.controls.controls.forDevice.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe("pause, disconnect, resume", () => {
  test("pause drains the runner, with no dialog", async () => {
    const s = setup();
    await s.device.impl.pause(ctxFor(), A1);
    expect(s.controls.client("dev_a1").drain).toHaveBeenCalledOnce();
    expect(s.dialogs.asked).toEqual([]);
  });

  test("a drain no runner answers fails", async () => {
    const s = setup();
    s.controls.client("dev_a1").drain.mockRejectedValueOnce(new Error("no_runner"));
    await expect(s.device.impl.pause(ctxFor(), A1)).rejects.toEqual({ code: "failed" });
  });

  test("disconnect stops the connection's login service", async () => {
    const s = setup({}, { service: { installed: true, loaded: true, running: true } });
    await s.device.impl.disconnect(ctxFor(), A1);
    expect(s.cli.writes()).toEqual(["service stop -c dev_a1"]);
    expect(s.dialogs.asked).toEqual([]);
  });

  test("disconnect stops a terminal runner with stop; nothing runs for a stopped one", async () => {
    const s = setup({
      status: threeConnections({ dev_a2: { control: "absent", live: null } }),
    });
    await s.device.impl.disconnect(ctxFor(), A1);
    await s.device.impl.disconnect(ctxFor(), A2);
    expect(s.cli.writes()).toEqual(["stop -c dev_a1"]);
  });

  test("resume asks natively, then the connection's service starts", async () => {
    const s = setup({ status: threeConnections({ dev_a1: { control: "absent", live: null } }) });
    const ctx = ctxFor();
    expect(await s.device.impl.resume(ctx, A1)).toBe("resumed");
    expect(s.dialogs.asked[0]).toEqual({ name: "confirmResume", args: [ctx.window, profileA] });
    expect(s.service.ensureService).toHaveBeenCalledWith("dev_a1");
    expect(s.cli.writes()).toEqual(["service start -c dev_a1"]);
  });

  test("resume refused: cancelled, nothing started", async () => {
    const s = setup({}, { answer: false });
    expect(await s.device.impl.resume(ctxFor(), A1)).toBe("cancelled");
    expect(s.cli.writes()).toEqual([]);
    expect(s.service.ensureService).not.toHaveBeenCalled();
  });

  test("resume and connect are the statically confirming functions", () => {
    const s = setup();
    expect(s.device.confirming).toEqual(["connect", "resume"]);
  });
});

describe("requestCeiling", () => {
  /** Everything allowed on the connection. */
  const wide = { outsideSandbox: true, network: "open", projectReach: "machine" } as const;
  /** The ceiling as `ceiling show -c dev_a1 --json` prints it. */
  const shown = (c: { outsideSandbox: boolean; network: string; projectReach: string }) => ({
    lines: [{ ...c, allowedDomains: [], projectPaths: [], revision: null }],
  });
  /** Only dev_a1 on the machine. */
  const alone = { connections: [connectionJson("dev_a1")], unreadable: [] };

  test("a narrowing applies at once, with no dialog, no confirmation slot and no --yes", async () => {
    const s = setup({ ceiling: wide });
    const ctx = ctxFor();
    expect(await s.device.impl.requestCeiling(ctx, { ...A1, network: "allowlist" })).toBe(
      "applied",
    );
    // Without --yes: the program decides again under its lock, so a race cannot widen.
    expect(s.cli.writes()).toEqual(["ceiling set -c dev_a1 --network allowlist"]);
    expect(s.dialogs.asked).toEqual([]);
    expect(ctx.confirm).not.toHaveBeenCalled();
  });

  test("only the requested fields reach the program: the others are never sent", async () => {
    const s = setup({ ceiling: wide });
    await s.device.impl.requestCeiling(ctxFor(), { ...A1, outsideSandbox: false });
    await s.device.impl.requestCeiling(ctxFor(), { ...A2, projectReach: "paths" });
    await s.device.impl.requestCeiling(ctxFor(), { ...A2, projectReach: "workspace" });
    expect(s.cli.writes()).toEqual([
      "ceiling set -c dev_a1 --outside-sandbox off",
      "ceiling set -c dev_a2 --project-reach paths",
      "ceiling set -c dev_a2 --project-reach workspace",
    ]);
  });

  test("a narrowing the program refuses (it became a widening under its lock) fails", async () => {
    const s = setup(
      { ceiling: wide },
      { handlers: { "ceiling set -c dev_a1 --network allowlist": () => ({ code: 2 }) } },
    );
    await expect(
      s.device.impl.requestCeiling(ctxFor(), { ...A1, network: "allowlist" }),
    ).rejects.toMatchObject({ code: "failed" });
    expect(s.dialogs.asked).toEqual([]);
  });

  test("a widening names each widened field, shows the program's texts, applies only on yes", async () => {
    const s = setup({ status: alone });
    const ctx = ctxFor();
    expect(await s.device.impl.requestCeiling(ctx, { ...A1, ...wide })).toBe("applied");
    expect(ctx.confirm).toHaveBeenCalledOnce();
    expect(s.dialogs.asked[0]).toEqual({
      name: "confirmWidenCeiling",
      args: [
        ctx.window,
        { outsideSandbox: true, network: true, projectReach: "machine" },
        [TEXTS.ceilingWidening, TEXTS.outsideSandboxRisk],
        ctx.profile,
      ],
    });
    expect(s.cli.writes()).toEqual([
      "ceiling set -c dev_a1 --outside-sandbox on --network open --project-reach machine --yes",
    ]);
  });

  test("outside the sandbox beside other connections also shows the program's sentence on them", async () => {
    const s = setup();
    await s.device.impl.requestCeiling(ctxFor(), { ...A1, outsideSandbox: true });
    expect(s.dialogs.asked[0]?.args.slice(1, 3)).toEqual([
      { outsideSandbox: true, network: false, projectReach: false },
      [TEXTS.ceilingWidening, TEXTS.otherConnections, TEXTS.outsideSandboxRisk],
    ]);
    // Its texts are the named connection's (the risk text names the device id).
    expect(s.cli.writes()).toEqual(["ceiling set -c dev_a1 --outside-sandbox on --yes"]);
  });

  test("widening the network alone names only it and shows the widening text alone", async () => {
    const s = setup();
    await s.device.impl.requestCeiling(ctxFor(), { ...A1, network: "open" });
    expect(s.dialogs.asked[0]?.args.slice(1, 3)).toEqual([
      { outsideSandbox: false, network: true, projectReach: false },
      [TEXTS.ceilingWidening],
    ]);
    expect(s.cli.writes()).toEqual(["ceiling set -c dev_a1 --network open --yes"]);
  });

  test("the project reach widens workspace < paths < machine and names the reach asked for", async () => {
    const s = setup();
    await s.device.impl.requestCeiling(ctxFor(), { ...A1, projectReach: "paths" });
    expect(s.dialogs.asked[0]?.args[1]).toEqual({
      outsideSandbox: false,
      network: false,
      projectReach: "paths",
    });
    const t = setup({
      ceiling: { outsideSandbox: false, network: "allowlist", projectReach: "paths" },
    });
    await t.device.impl.requestCeiling(ctxFor(), { ...A1, projectReach: "machine" });
    expect(t.dialogs.asked[0]?.args[1]).toMatchObject({ projectReach: "machine" });
    // From machine, paths is a narrowing: no dialog.
    const u = setup({ ceiling: wide });
    await u.device.impl.requestCeiling(ctxFor(), { ...A1, projectReach: "paths" });
    expect(u.dialogs.asked).toEqual([]);
    expect(u.cli.writes()).toEqual(["ceiling set -c dev_a1 --project-reach paths"]);
  });

  test("a widening with a narrowing names only the widened field", async () => {
    const s = setup({
      ceiling: { outsideSandbox: true, network: "allowlist", projectReach: "workspace" },
    });
    await s.device.impl.requestCeiling(ctxFor(), {
      ...A1,
      outsideSandbox: false,
      projectReach: "machine",
    });
    expect(s.dialogs.asked[0]?.args.slice(1, 3)).toEqual([
      { outsideSandbox: false, network: false, projectReach: "machine" },
      [TEXTS.ceilingWidening],
    ]);
    expect(s.cli.writes()).toEqual([
      "ceiling set -c dev_a1 --outside-sandbox off --project-reach machine --yes",
    ]);
  });

  test("in docker mode widening outside the sandbox still names it, without the os risk text", async () => {
    const s = setup({
      status: { connections: [connectionJson("dev_a1", { mode: "docker" })], unreadable: [] },
    });
    await s.device.impl.requestCeiling(ctxFor(), { ...A1, outsideSandbox: true });
    expect(s.dialogs.asked[0]?.args.slice(1, 3)).toEqual([
      { outsideSandbox: true, network: false, projectReach: false },
      [TEXTS.ceilingWidening],
    ]);
  });

  test("a widening that grew while the dialog was open is refused", async () => {
    let reads = 0;
    const s = setup(
      {},
      {
        handlers: {
          "ceiling show -c dev_a1 --json": () => {
            reads++;
            // Before: the network already open; after the dialog it was narrowed meanwhile.
            return shown({
              outsideSandbox: false,
              network: reads === 1 ? "open" : "allowlist",
              projectReach: "workspace",
            });
          },
        },
      },
    );
    await expect(s.device.impl.requestCeiling(ctxFor(), { ...A1, ...wide })).rejects.toMatchObject({
      code: "failed",
    });
    expect(reads).toBe(2);
    expect(s.cli.writes()).toEqual([]);
  });

  test("a widening that shrank meanwhile still applies what was confirmed", async () => {
    let reads = 0;
    const s = setup(
      {},
      {
        handlers: {
          "ceiling show -c dev_a1 --json": () => {
            reads++;
            return shown({
              outsideSandbox: reads === 2,
              network: "allowlist",
              projectReach: "workspace",
            });
          },
        },
      },
    );
    expect(await s.device.impl.requestCeiling(ctxFor(), { ...A1, ...wide })).toBe("applied");
    expect(s.cli.writes()).toEqual([
      "ceiling set -c dev_a1 --outside-sandbox on --network open --project-reach machine --yes",
    ]);
  });

  test("a widening refused: cancelled, nothing written", async () => {
    const s = setup({}, { answer: false });
    expect(await s.device.impl.requestCeiling(ctxFor(), { ...A1, ...wide })).toBe("cancelled");
    expect(s.cli.writes()).toEqual([]);
  });

  test("the widening is decided from the connection, not the page", async () => {
    // Already wide on the machine: the same request is no widening, needs no dialog, writes nothing.
    const s = setup({ ceiling: wide });
    expect(await s.device.impl.requestCeiling(ctxFor(), { ...A1, ...wide })).toBe("applied");
    expect(s.dialogs.asked).toEqual([]);
    expect(s.cli.writes()).toEqual([]);
  });

  test("a busy confirmation slot refuses the widening before any dialog", async () => {
    const s = setup();
    const ctx = ctxFor();
    ctx.confirm.mockImplementationOnce(() => Promise.reject({ code: "busy" }));
    await expect(s.device.impl.requestCeiling(ctx, { ...A1, ...wide })).rejects.toMatchObject({
      code: "busy",
    });
    expect(s.dialogs.asked).toEqual([]);
    expect(s.cli.writes()).toEqual([]);
  });

  test("texts the program cannot give refuse the widening", async () => {
    const s = setup(
      {},
      {
        texts: async () => {
          throw new Error("no texts");
        },
      },
    );
    await expect(s.device.impl.requestCeiling(ctxFor(), { ...A1, ...wide })).rejects.toMatchObject({
      code: "failed",
    });
    expect(s.dialogs.asked).toEqual([]);
    expect(s.cli.writes()).toEqual([]);
  });

  test("an unreadable ceiling (an older program's shape) refuses before anything", async () => {
    for (const old of [
      { fullAccess: false, projectReach: "workspace", revision: null },
      { outsideSandbox: false, network: "allowlist", projectReach: "os-user", revision: null },
    ]) {
      const s = setup(
        {},
        { handlers: { "ceiling show -c dev_a1 --json": () => ({ lines: [old] }) } },
      );
      await expect(
        s.device.impl.requestCeiling(ctxFor(), { ...A1, network: "open" }),
      ).rejects.toMatchObject({ code: "failed" });
      expect(s.dialogs.asked).toEqual([]);
      expect(s.cli.writes()).toEqual([]);
    }
  });

  test("malformed input fails: empty, unknown fields (the old shapes), bad values", async () => {
    const s = setup();
    for (const input of [
      undefined,
      null,
      [],
      { ...A1 },
      { ...A1, fullAccess: true, projectReach: "machine" },
      { ...A1, network: "open", fullAccess: true },
      { ...A1, outsideSandbox: "on" },
      { ...A1, network: "none" },
      { ...A1, projectReach: "os-user" },
      { ...A1, projectReach: "anywhere" },
      { ...A1, network: undefined },
      { network: "open" },
    ]) {
      await expect(s.device.impl.requestCeiling(ctxFor(), input)).rejects.toMatchObject({
        code: "failed",
      });
    }
    expect(s.cli.writes()).toEqual([]);
    expect(s.dialogs.asked).toEqual([]);
  });
});

describe("setKeepAwake", () => {
  test("lowering applies at once, with no dialog", async () => {
    const s = setup({ keepAwake: "connected" });
    const ctx = ctxFor();
    expect(await s.device.impl.setKeepAwake(ctx, { ...A1, mode: "while-busy" })).toBe("applied");
    expect(s.cli.writes()).toEqual(["keep-awake while-busy -c dev_a1"]);
    expect(s.dialogs.asked).toEqual([]);
    expect(ctx.confirm).not.toHaveBeenCalled();
  });

  test("raising asks, then keep-awake <mode> -c <id> --yes", async () => {
    const s = setup({ keepAwake: "off" });
    const ctx = ctxFor();
    expect(await s.device.impl.setKeepAwake(ctx, { ...A2, mode: "connected" })).toBe("applied");
    expect(ctx.confirm).toHaveBeenCalledOnce();
    expect(s.dialogs.asked[0]).toEqual({
      name: "confirmRaiseKeepAwake",
      args: [ctx.window, "connected", ctx.profile],
    });
    expect(s.cli.writes()).toEqual(["keep-awake connected -c dev_a2 --yes"]);
  });

  test("a raise that grew while the dialog was open is refused", async () => {
    let reads = 0;
    const s = setup(
      {},
      {
        handlers: {
          "keep-awake show -c dev_a1 --json": () => {
            reads++;
            return { lines: [{ keepAwake: reads === 1 ? "while-busy" : "off" }] };
          },
        },
      },
    );
    await expect(
      s.device.impl.setKeepAwake(ctxFor(), { ...A1, mode: "connected" }),
    ).rejects.toMatchObject({ code: "failed" });
    expect(s.cli.writes()).toEqual([]);
  });

  test("raising refused: cancelled", async () => {
    const s = setup({ keepAwake: "off" }, { answer: false });
    expect(await s.device.impl.setKeepAwake(ctxFor(), { ...A1, mode: "while-busy" })).toBe(
      "cancelled",
    );
    expect(s.cli.writes()).toEqual([]);
  });

  test("an unknown mode fails", async () => {
    const s = setup();
    for (const input of [{ ...A1, mode: "always" }, { ...A1 }, "off"]) {
      await expect(s.device.impl.setKeepAwake(ctxFor(), input)).rejects.toMatchObject({
        code: "failed",
      });
    }
  });
});

describe("onStatus", () => {
  test("onStatus fires for a profile only when its own connections changed", async () => {
    let status = threeConnections();
    const s = setup({}, { handlers: { "status --json": () => ({ lines: [status] }) } });
    const seenA: unknown[][] = [];
    const seenB: unknown[][] = [];
    const offA = s.device.events.onStatus(ctxFor(), (...a) => seenA.push(a));
    const offB = s.device.events.onStatus(ctxFor(profileB), (...a) => seenB.push(a));
    expect(s.controls.controls.subscribeAll).toHaveBeenCalledOnce();
    // What each has now is recorded, not sent.
    await vi.waitFor(() => expect(s.controls.controls.read.mock.calls.length).toBeGreaterThan(1));
    s.controls.changed();
    await vi.waitFor(() => expect(s.controls.controls.read.mock.calls.length).toBeGreaterThan(2));
    expect(seenA).toEqual([]);
    expect(seenB).toEqual([]);

    // B's connection goes offline: only B hears of it, with no payload.
    status = threeConnections({
      dev_b1: { live: live({ deviceId: "dev_b1", connection: "offline" }) },
    });
    s.controls.changed();
    await vi.waitFor(() => expect(seenB).toHaveLength(1));
    expect(seenB[0]).toEqual([]);
    expect(seenA).toEqual([]);

    // A gains a third connection: only A hears of it.
    status = {
      ...status,
      connections: [...status.connections, connectionJson("dev_a3")],
    };
    s.controls.changed();
    await vi.waitFor(() => expect(seenA).toHaveLength(1));
    expect(seenB).toHaveLength(1);

    offA();
    expect(s.controls.unsubscribe).not.toHaveBeenCalled();
    offB();
    expect(s.controls.unsubscribe).toHaveBeenCalledOnce();
  });

  test("an unchanged status is not sent again", async () => {
    const s = setup();
    const seen: unknown[] = [];
    s.device.events.onStatus(ctxFor(), () => seen.push(1));
    for (let i = 0; i < 3; i++) s.controls.changed();
    await vi.waitFor(() => expect(s.controls.controls.read.mock.calls.length).toBeGreaterThan(1));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([]);
  });

  test("an action on a connection makes its listeners read again", async () => {
    let status = threeConnections();
    const s = setup({}, { handlers: { "status --json": () => ({ lines: [status] }) } });
    const seen: unknown[] = [];
    s.device.events.onStatus(ctxFor(), () => seen.push(1));
    await vi.waitFor(() => expect(s.controls.controls.read).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));
    status = threeConnections({ dev_a1: { control: "absent", live: null } });
    await s.device.impl.disconnect(ctxFor(), A1);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
  });
});

describe("removing a profile", () => {
  test("removing a profile asks once and logs out each of its connections, not another deployment's", async () => {
    const s = setup({}, { handlers: { "logout -c dev_a1": () => ({ code: 1 }) } });
    const parent = { id: "w" };
    await s.device.beforeRemoveProfile(profileA, parent);
    expect(s.dialogs.asked).toEqual([{ name: "confirmRemoveDevice", args: [parent, profileA, 2] }]);
    // In order, past the first one's failure (logged).
    expect(s.cli.writes()).toEqual(["logout -c dev_a1", "logout -c dev_a2"]);
    expect(s.log).toHaveBeenCalledWith(
      "a device connection could not be logged out",
      expect.anything(),
    );
  });

  test("「否」 keeps every connection", async () => {
    const s = setup({}, { answer: false });
    await s.device.beforeRemoveProfile(profileA, null);
    expect(s.cli.writes()).toEqual([]);
  });

  test("no connection into it: no question", async () => {
    const s = setup();
    const other: Profile = {
      ...profileA,
      id: "pc",
      base: "https://c.example.com",
      origin: "https://c.example.com",
    };
    await s.device.beforeRemoveProfile(other, null);
    expect(s.dialogs.asked).toEqual([]);
    expect(s.cli.writes()).toEqual([]);
  });
});

describe("no function returns the credential", () => {
  test("every result, for this deployment's connections and another's", async () => {
    const s = setup(
      { service: { installed: true, loaded: true, running: true }, keepAwake: "off" },
      {
        running: [
          {
            tag: "t",
            conversationId: null,
            accountId: null,
            isolation: "full",
            startedAt: "x",
            credential: SECRET,
          },
        ],
      },
    );
    const results: unknown[] = [];
    const settle = async (p: () => Promise<unknown>) => {
      try {
        results.push(await p());
      } catch (e) {
        results.push(e);
      }
    };
    for (const profile of [profileA, profileB]) {
      const ctx = ctxFor(profile);
      for (const named of [A1, A2, B1]) {
        await settle(() => s.device.impl.running(ctx, named));
        await settle(() => s.device.impl.pause(ctx, named));
        await settle(() => s.device.impl.resume(ctx, named));
        await settle(() => s.device.impl.disconnect(ctx, named));
        await settle(() =>
          s.device.impl.requestCeiling(ctx, {
            ...named,
            outsideSandbox: true,
            projectReach: "machine",
          }),
        );
        await settle(() => s.device.impl.setKeepAwake(ctx, { ...named, mode: "connected" }));
      }
      await settle(() => s.device.impl.status(ctx));
    }
    const seen: unknown[][] = [];
    s.device.events.onStatus(ctxFor(), (...a) => seen.push(a));
    s.controls.changed();
    results.push(...seen);
    expect(results.length).toBeGreaterThan(36);
    for (const r of results) expect(carriesSecret(r)).toBe(false);
  });
});

describe("the program's risk texts", () => {
  test("come from the bundled package, run on Node, not from a copy", async () => {
    // Resources/device is a copy of this package; Resources/node/node is replaced by this Node.
    const realSpawn: SpawnLike = (_cmd, args, options) =>
      spawn(process.execPath, [...args], options) as unknown as ReturnType<SpawnLike>;
    const texts = createDeviceTexts({
      resourcesPath: dirname(DEVICE_PKG),
      spawn: realSpawn,
      env: process.env,
    });
    const ceiling = (await import(
      pathToFileURL(join(DEVICE_PKG, "dist/commands/ceiling.js")).href
    )) as { CEILING_WIDENING_TEXT: string; CEILING_OTHER_CONNECTIONS_TEXT: string };
    const login = (await import(
      pathToFileURL(join(DEVICE_PKG, "dist/commands/login.js")).href
    )) as {
      outsideSandboxRiskText: (deviceId: string) => string;
    };
    const got = await texts("dev_1");
    expect(got).toEqual({
      ceilingWidening: ceiling.CEILING_WIDENING_TEXT,
      otherConnections: ceiling.CEILING_OTHER_CONNECTIONS_TEXT,
      outsideSandboxRisk: login.outsideSandboxRiskText("dev_1"),
    });
    expect(got.outsideSandboxRisk).toContain("logout -c dev_1");
    // Asked once per connection per app run.
    expect(await texts("dev_1")).toBe(got);
    // An unsafe device id never reaches the program.
    await expect(texts("../evil")).rejects.toThrow(/invalid device id/);
  });

  test("a program that prints nothing usable refuses", async () => {
    const quietSpawn: SpawnLike = (_cmd, _args, options) =>
      spawn(
        process.execPath,
        ["-e", "console.log('{}')"],
        options,
      ) as unknown as ReturnType<SpawnLike>;
    const texts = createDeviceTexts({ resourcesPath: "/nowhere", spawn: quietSpawn, env: {} });
    await expect(texts("dev_1")).rejects.toThrow();
  });
});

describe("the request shape", () => {
  test("the shell's ceiling fields are exactly the SDK's DeviceCeilingRequest", () => {
    expectTypeOf<Partial<OwnerCeiling>>().toEqualTypeOf<DeviceCeilingRequest>();
    expectTypeOf<keyof DeviceCeilingRequest>().toEqualTypeOf<CeilingField>();
    expectTypeOf(parseCeilingRequest).returns.toEqualTypeOf<DeviceCeilingRequest | undefined>();
  });
});

describe("the connection readers", () => {
  const MACHINE = "/m/capybara-device";
  const SOCKET = `${MACHINE}/run/0123456789abcdef.sock`;
  /** One connection as `status --json` prints it, with fields the readers must not pass on. */
  const entry = (over: Record<string, unknown> = {}) => ({
    deviceId: "dev_1",
    orgId: "org_1",
    orgName: "Acme",
    deviceName: "laptop",
    url: "https://a.example.com/team",
    host: "a.example.com",
    mode: "os",
    dir: "/Users/me/capybara-device/dev_1",
    serviceInstalled: true,
    controlSocket: SOCKET,
    control: "ok",
    live: live(),
    credential: SECRET,
    ...over,
  });
  const statusCli = (connections: unknown[], extra: Record<string, unknown> = {}) =>
    fakeCli({ status: { connections, unreadable: [], ...extra } });

  test("readConnections keeps only the named fields and drops an unsafe device id", async () => {
    const f = statusCli([
      entry(),
      entry({ deviceId: "../evil", controlSocket: `${MACHINE}/run/fedcba9876543210.sock` }),
      entry({ deviceId: "dev 2" }),
      entry({ deviceId: "dev_3", mode: "vm" }),
    ]);
    const all = await readConnections(f.cli, MACHINE);
    expect(f.commands()).toEqual(["status --json"]);
    expect(all).toEqual([
      {
        deviceId: "dev_1",
        orgId: "org_1",
        orgName: "Acme",
        deviceName: "laptop",
        url: "https://a.example.com/team",
        host: "a.example.com",
        mode: "os",
        serviceInstalled: true,
        controlSocket: SOCKET,
        control: "ok",
        live: live(),
      },
    ]);
    expect(carriesSecret(all)).toBe(false);
  });

  test("no connection is an empty list; another shape fails", async () => {
    await expect(readConnections(statusCli([]).cli, MACHINE)).resolves.toEqual([]);
    const old = fakeCli({ status: loggedIn() });
    await expect(readConnections(old.cli, MACHINE)).rejects.toEqual({ code: "failed" });
  });

  test("a control socket outside <machineDir>/run/<16 hex>.sock is never kept", async () => {
    for (const controlSocket of [
      "/tmp/evil.sock",
      `${MACHINE}/run/0123456789ABCDEF.sock`,
      `${MACHINE}/run/../run/0123456789abcdef.sock`,
      `${MACHINE}/connections/dev_1/control.sock`,
      `/other/run/0123456789abcdef.sock`,
      "",
      5,
    ]) {
      const [c] = await readConnections(statusCli([entry({ controlSocket })]).cli, MACHINE);
      expect(c).toMatchObject({ controlSocket: null, control: "unavailable", live: null });
      expect(c?.controlReason).toBeTypeOf("string");
    }
    // The program's own reason survives when it already said unavailable.
    const [u] = await readConnections(
      statusCli([
        entry({
          controlSocket: "",
          control: "unavailable",
          controlReason: "status failed: x",
          live: null,
        }),
      ]).cli,
      MACHINE,
    );
    expect(u).toMatchObject({ control: "unavailable", controlReason: "status failed: x" });
  });

  test("a live status is kept only when control is ok and it has the runner's shape", async () => {
    const [absent] = await readConnections(
      statusCli([entry({ control: "absent", live: live() })]).cli,
      MACHINE,
    );
    expect(absent?.live).toBeNull();
    const [bad] = await readConnections(statusCli([entry({ live: { pid: "x" } })]).cli, MACHINE);
    expect(bad?.live).toBeNull();
  });

  const conn = (over: Partial<MachineConnection> = {}): MachineConnection => ({
    deviceId: "dev_1",
    orgId: "org_1",
    orgName: null,
    deviceName: null,
    url: "https://a.example.com/team",
    host: "a.example.com",
    mode: "os",
    serviceInstalled: false,
    controlSocket: SOCKET,
    control: "ok",
    live: live(),
    ...over,
  });

  test("connectionsHere keeps only the profile's own origin", () => {
    const here1 = conn();
    const here2 = conn({ deviceId: "dev_2", url: "https://A.example.com/other" });
    const elsewhere = conn({ deviceId: "dev_3", url: "https://b.example.com" });
    const port = conn({ deviceId: "dev_4", url: "https://a.example.com:8443" });
    expect(connectionsHere([here1, elsewhere, here2, port], profileA)).toEqual([here1, here2]);
  });

  test("connectionView: live, unavailable, stopped", () => {
    const long = "x".repeat(400);
    expect(
      connectionView(
        conn({
          serviceInstalled: true,
          live: live({
            connection: "offline",
            offlineReason: long,
            keepAwake: { mode: "connected", held: true, unavailable: long },
            lastWakeAt: "2026-11-20T09:00:00.000Z",
          }),
        }),
        "off",
      ),
    ).toEqual({
      deviceId: "dev_1",
      orgId: "org_1",
      mode: "os",
      serviceInstalled: true,
      connection: "offline",
      offlineReason: "x".repeat(300),
      keepAwake: { mode: "connected", held: true, unavailable: "x".repeat(300) },
      lastWakeAt: "2026-11-20T09:00:00.000Z",
    });
    expect(
      connectionView(
        conn({ control: "unavailable", controlReason: long, live: null }),
        "while-busy",
      ),
    ).toMatchObject({
      connection: "offline",
      offlineReason: "x".repeat(300),
      keepAwake: { mode: "while-busy", held: false },
    });
    expect(connectionView(conn({ control: "absent", live: null }), "off")).toEqual({
      deviceId: "dev_1",
      orgId: "org_1",
      mode: "os",
      serviceInstalled: false,
      connection: "stopped",
      keepAwake: { mode: "off", held: false },
    });
  });

  test("the per-connection reads and writes name the connection", async () => {
    const f = fakeCli({ keepAwake: "connected" });
    await expect(readKeepAwake(f.cli, "dev_1")).resolves.toBe("connected");
    await expect(readCeiling(f.cli, "dev_1")).resolves.toEqual({
      outsideSandbox: false,
      network: "allowlist",
      projectReach: "workspace",
    });
    expect(f.commands()).toEqual([
      "keep-awake show -c dev_1 --json",
      "ceiling show -c dev_1 --json",
    ]);
    expect(ceilingSetArgs("dev_1", { network: "open" })).toEqual([
      "ceiling",
      "set",
      "-c",
      "dev_1",
      "--network",
      "open",
    ]);
  });
});

describe("the connection is checked again after a confirmation dialog", () => {
  /** A `status --json` that answers `all` until `drop()` removes dev_a1. */
  function droppable() {
    let dropped = false;
    const answer = () => ({
      lines: [
        dropped ? { connections: [connectionJson("dev_a2")], unreadable: [] } : threeConnections(),
      ],
    });
    return { handlers: { "status --json": answer }, drop: () => (dropped = true) };
  }

  test("resume: a connection gone while the dialog was open starts nothing", async () => {
    const d = droppable();
    const s = setup({}, { handlers: d.handlers });
    s.dialogs.dialogs.confirmResume = async () => {
      d.drop();
      return true;
    };
    await expect(s.device.impl.resume(ctxFor(), A1)).rejects.toEqual({ code: "failed" });
    expect(s.cli.writes()).toEqual([]);
    expect(s.service.ensureService).not.toHaveBeenCalled();
  });

  test("a widening: a connection gone while the dialog was open widens nothing", async () => {
    const d = droppable();
    const s = setup({}, { handlers: d.handlers });
    s.dialogs.dialogs.confirmWidenCeiling = async () => {
      d.drop();
      return true;
    };
    await expect(
      s.device.impl.requestCeiling(ctxFor(), { ...A1, network: "open" }),
    ).rejects.toEqual({ code: "failed" });
    expect(s.cli.writes()).toEqual([]);
  });

  test("a keep-awake raise: a connection gone while the dialog was open raises nothing", async () => {
    const d = droppable();
    const s = setup({ keepAwake: "off" }, { handlers: d.handlers });
    s.dialogs.dialogs.confirmRaiseKeepAwake = async () => {
      d.drop();
      return true;
    };
    await expect(
      s.device.impl.setKeepAwake(ctxFor(), { ...A1, mode: "connected" }),
    ).rejects.toEqual({ code: "failed" });
    expect(s.cli.writes()).toEqual([]);
  });
});

describe("the other-connections sentence counts unreadable connections too", () => {
  const status = (unreadable: unknown[]) => ({
    connections: [connectionJson("dev_a1")],
    unreadable,
  });

  test("one readable connection and an unreadable one: the sentence is shown", async () => {
    const s = setup({ status: status([{ deviceId: "dev_x", reason: "bad json" }]) });
    await s.device.impl.requestCeiling(ctxFor(), { ...A1, outsideSandbox: true });
    expect(s.dialogs.asked[0]?.args[2]).toEqual([
      TEXTS.ceilingWidening,
      TEXTS.otherConnections,
      TEXTS.outsideSandboxRisk,
    ]);
  });

  test("a single connection alone: no sentence", async () => {
    const s = setup({ status: status([]) });
    await s.device.impl.requestCeiling(ctxFor(), { ...A1, outsideSandbox: true });
    expect(s.dialogs.asked[0]?.args[2]).toEqual([TEXTS.ceilingWidening, TEXTS.outsideSandboxRisk]);
  });
});

describe("profile removal and the -c fallback", () => {
  test("removal logs out only what is still a connection after the dialog", async () => {
    let dropped = false;
    const s = setup(
      {},
      {
        handlers: {
          "status --json": () => ({
            lines: [
              dropped
                ? { connections: [connectionJson("dev_a2")], unreadable: [] }
                : threeConnections(),
            ],
          }),
        },
      },
    );
    s.dialogs.dialogs.confirmRemoveDevice = async () => {
      dropped = true;
      return true;
    };
    await s.device.beforeRemoveProfile(profileA, null);
    expect(s.cli.writes()).toEqual(["logout -c dev_a2"]);
  });

  test("an id that another connection's name or host also equals is refused", async () => {
    const s = setup({
      status: {
        connections: [
          connectionJson("dev_a1"),
          connectionJson("dev_b1", {
            deviceName: "dev_a1",
            url: "https://b.example.com",
            host: "b.example.com",
          }),
        ],
        unreadable: [],
      },
    });
    await expect(s.device.impl.running(ctxFor(), A1)).rejects.toEqual({ code: "failed" });
    await expect(s.device.impl.disconnect(ctxFor(), A1)).rejects.toEqual({ code: "failed" });
    expect(s.cli.writes()).toEqual([]);
  });
});
