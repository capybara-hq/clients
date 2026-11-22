import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  BUNDLED_DEVICE_PROTOCOL,
  createDeviceAvailability,
  deviceOffered,
} from "../../src/main/device/availability.ts";
import { createDeviceCapability } from "../../src/main/device/capability.ts";
import type { SpawnLike } from "../../src/main/device/cli.ts";
import type { LiveStatus, RunningOperation } from "../../src/main/device/control.ts";
import {
  type CeilingField,
  ceilingSetArgs,
  connectionsHere,
  connectionView,
  type DeviceCeilingRequest,
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
  ctxFor,
  fakeCli,
  fakeDialogs,
  fakeService,
  fakeVerification,
  live,
  loggedIn,
  profileA,
  SECRET,
} from "./fake-device.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The installed device package: what scripts/bundle-node.ts copies into Resources/device. */
const DEVICE_PKG = join(here, "../../node_modules/@capybara-hq/device");

const TEXTS = {
  ceilingWidening: "WIDENING (from the program)",
  outsideSandboxRisk: "RISK (program)",
};

const meta = (over: Record<string, unknown> = {}) => ({
  name: "Acme",
  icon: null,
  protocols: { device: { min: 6, max: 6 } },
  features: { localDevices: true, appSignIn: true },
  ...over,
});

function setup(
  state: Parameters<typeof fakeCli>[0] = {},
  o: {
    answer?: Parameters<typeof fakeDialogs>[0];
    handlers?: Parameters<typeof fakeCli>[1];
    running?: unknown[];
  } = {},
) {
  const cli = fakeCli(state, o.handlers);
  const dialogs = fakeDialogs(o.answer ?? true);
  const service = fakeService();
  const subscribers: ((s: LiveStatus | undefined) => void)[] = [];
  const unsubscribe = vi.fn();
  const control = {
    running: vi.fn(async () => (o.running ?? []) as RunningOperation[]),
    drain: vi.fn(async () => undefined),
    subscribe: vi.fn((cb: (s: LiveStatus | undefined) => void) => {
      subscribers.push(cb);
      return unsubscribe;
    }),
  };
  const device = createDeviceCapability({
    cli: cli.cli,
    service,
    control,
    dialogs: dialogs.dialogs,
    texts: async () => TEXTS,
    openVerification: fakeVerification().open,
  });
  return { device, cli, dialogs, service, control, subscribers, unsubscribe };
}

describe("when device@1 is offered", () => {
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
  test("not logged in: not_connected", async () => {
    const s = setup();
    expect(await s.device.impl.status(ctxFor())).toEqual({ state: "not_connected" });
  });

  test("logged in to another deployment: only its origin", async () => {
    const s = setup({ status: loggedIn({ url: "https://other.example.com/x" }) });
    expect(await s.device.impl.status(ctxFor())).toEqual({
      state: "connected_elsewhere",
      origin: "https://other.example.com",
    });
  });

  test("connected here: the runner's live state", async () => {
    const s = setup({
      status: loggedIn({
        live: live({
          connection: "offline",
          offlineReason: "network",
          keepAwake: { mode: "connected", held: true },
          lastWakeAt: "2026-11-20T07:00:00.000Z",
        }),
      }),
      service: { installed: true, loaded: true, running: true },
    });
    expect(await s.device.impl.status(ctxFor())).toEqual({
      state: "connected",
      deviceId: "dev_1",
      orgId: "org_1",
      mode: "os",
      connection: "offline",
      offlineReason: "network",
      serviceInstalled: true,
      keepAwake: { mode: "connected", held: true },
      lastWakeAt: "2026-11-20T07:00:00.000Z",
    });
  });

  test("origins compare normalized (case, default port, trailing slash)", async () => {
    const s = setup({ status: loggedIn({ url: "HTTPS://A.EXAMPLE.COM:443/team/" }) });
    expect((await s.device.impl.status(ctxFor())).state).toBe("connected");
  });

  test("no runner: stopped, the keep-awake mode from the policy, nothing held", async () => {
    const s = setup({
      status: loggedIn({ control: "absent", live: null }),
      keepAwake: "off",
    });
    expect(await s.device.impl.status(ctxFor())).toEqual({
      state: "connected",
      deviceId: "dev_1",
      orgId: "org_1",
      mode: "os",
      connection: "stopped",
      serviceInstalled: false,
      keepAwake: { mode: "off", held: false },
    });
  });

  test("an unreadable status fails", async () => {
    const s = setup({}, { handlers: { "status --json": () => ({ code: 1, lines: [] }) } });
    await expect(s.device.impl.status(ctxFor())).rejects.toMatchObject({ code: "failed" });
  });
});

describe("running", () => {
  test("lists this deployment's operations, field by field", async () => {
    const op = {
      tag: "t1",
      conversationId: "c1",
      accountId: null,
      isolation: "restricted",
      startedAt: "2026-11-20T08:01:00.000Z",
      command: "rm -rf /",
    };
    const s = setup({ status: loggedIn() }, { running: [op] });
    expect(await s.device.impl.running(ctxFor())).toEqual([
      {
        tag: "t1",
        conversationId: "c1",
        accountId: null,
        isolation: "restricted",
        startedAt: "2026-11-20T08:01:00.000Z",
      },
    ]);
  });

  test("another deployment's operations are never shown", async () => {
    const s = setup({ status: loggedIn({ url: "https://other.example.com" }) }, { running: [{}] });
    expect(await s.device.impl.running(ctxFor())).toEqual([]);
    expect(s.control.running).not.toHaveBeenCalled();
  });
});

describe("pause, disconnect, resume", () => {
  test("pause drains the runner, with no dialog", async () => {
    const s = setup({ status: loggedIn() });
    await s.device.impl.pause(ctxFor());
    expect(s.control.drain).toHaveBeenCalledOnce();
    expect(s.dialogs.asked).toEqual([]);
  });

  test("disconnect stops the login service", async () => {
    const s = setup({
      status: loggedIn(),
      service: { installed: true, loaded: true, running: true },
    });
    await s.device.impl.disconnect(ctxFor());
    expect(s.cli.writes()).toEqual(["service stop"]);
    expect(s.dialogs.asked).toEqual([]);
  });

  test("disconnect stops a terminal runner with stop", async () => {
    const s = setup({ status: loggedIn(), service: { installed: false } });
    await s.device.impl.disconnect(ctxFor());
    expect(s.cli.writes()).toEqual(["stop"]);
  });

  test("resume asks natively, then service start", async () => {
    const s = setup({ status: loggedIn({ control: "absent", live: null }) });
    const ctx = ctxFor();
    expect(await s.device.impl.resume(ctx)).toBe("resumed");
    expect(s.dialogs.asked[0]).toEqual({ name: "confirmResume", args: [ctx.window, profileA] });
    expect(s.service.ensureService).toHaveBeenCalledOnce();
    expect(s.cli.writes()).toEqual(["service start"]);
  });

  test("resume refused: cancelled, nothing started", async () => {
    const s = setup({ status: loggedIn() }, { answer: false });
    expect(await s.device.impl.resume(ctxFor())).toBe("cancelled");
    expect(s.cli.writes()).toEqual([]);
    expect(s.service.ensureService).not.toHaveBeenCalled();
  });

  test("none of them touches a device connected to another deployment", async () => {
    const s = setup({ status: loggedIn({ url: "https://other.example.com" }) });
    const ctx = ctxFor();
    for (const call of [
      () => s.device.impl.pause(ctx),
      () => s.device.impl.disconnect(ctx),
      () => s.device.impl.resume(ctx),
      () => s.device.impl.requestCeiling(ctx, { network: "allowlist" }),
      () => s.device.impl.setKeepAwake(ctx, "off"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "failed" });
    }
    expect(s.cli.writes()).toEqual([]);
    expect(s.control.drain).not.toHaveBeenCalled();
    expect(s.dialogs.asked).toEqual([]);
  });

  test("resume and connect are the statically confirming functions", () => {
    const s = setup();
    expect(s.device.confirming).toEqual(["connect", "resume"]);
  });
});

describe("requestCeiling", () => {
  /** Everything allowed on the machine. */
  const wide = { outsideSandbox: true, network: "open", projectReach: "os-user" } as const;
  /** The machine's ceiling as `ceiling show -c dev_1 --json` prints it. */
  const shown = (c: { outsideSandbox: boolean; network: string; projectReach: string }) => ({
    lines: [{ ...c, allowedDomains: [], revision: null }],
  });

  test("a narrowing applies at once, with no dialog, no confirmation slot and no --yes", async () => {
    const s = setup({ status: loggedIn(), ceiling: wide });
    const ctx = ctxFor();
    expect(await s.device.impl.requestCeiling(ctx, { network: "allowlist" })).toBe("applied");
    // Without --yes: the program decides again under its lock, so a race cannot widen.
    expect(s.cli.writes()).toEqual(["ceiling set -c dev_1 --network allowlist"]);
    expect(s.dialogs.asked).toEqual([]);
    expect(ctx.confirm).not.toHaveBeenCalled();
  });

  test("only the requested fields reach the program: the others are never sent", async () => {
    const s = setup({ status: loggedIn(), ceiling: wide });
    await s.device.impl.requestCeiling(ctxFor(), { outsideSandbox: false });
    await s.device.impl.requestCeiling(ctxFor(), { projectReach: "workspace" });
    expect(s.cli.writes()).toEqual([
      "ceiling set -c dev_1 --outside-sandbox off",
      "ceiling set -c dev_1 --project-reach workspace",
    ]);
  });

  test("a narrowing the program refuses (it became a widening under its lock) fails", async () => {
    const s = setup(
      { status: loggedIn(), ceiling: wide },
      { handlers: { "ceiling set -c dev_1 --network allowlist": () => ({ code: 2 }) } },
    );
    await expect(
      s.device.impl.requestCeiling(ctxFor(), { network: "allowlist" }),
    ).rejects.toMatchObject({ code: "failed" });
    expect(s.dialogs.asked).toEqual([]);
  });

  test("a widening names each widened field, shows the program's texts, applies only on yes", async () => {
    const s = setup({ status: loggedIn() });
    const ctx = ctxFor();
    expect(await s.device.impl.requestCeiling(ctx, wide)).toBe("applied");
    expect(ctx.confirm).toHaveBeenCalledOnce();
    expect(s.dialogs.asked[0]).toEqual({
      name: "confirmWidenCeiling",
      args: [
        ctx.window,
        { outsideSandbox: true, network: true, projectReach: true },
        [TEXTS.ceilingWidening, TEXTS.outsideSandboxRisk],
        ctx.profile,
      ],
    });
    expect(s.cli.writes()).toEqual([
      "ceiling set -c dev_1 --outside-sandbox on --network open --project-reach os-user --yes",
    ]);
  });

  test("widening the network alone names only it and shows the widening text alone", async () => {
    const s = setup({ status: loggedIn() });
    await s.device.impl.requestCeiling(ctxFor(), { network: "open" });
    expect(s.dialogs.asked[0]?.args.slice(1, 3)).toEqual([
      { outsideSandbox: false, network: true, projectReach: false },
      [TEXTS.ceilingWidening],
    ]);
    expect(s.cli.writes()).toEqual(["ceiling set -c dev_1 --network open --yes"]);
  });

  test("a widening with a narrowing names only the widened field", async () => {
    const s = setup({
      status: loggedIn(),
      ceiling: { outsideSandbox: true, network: "allowlist", projectReach: "workspace" },
    });
    await s.device.impl.requestCeiling(ctxFor(), {
      outsideSandbox: false,
      projectReach: "os-user",
    });
    expect(s.dialogs.asked[0]?.args.slice(1, 3)).toEqual([
      { outsideSandbox: false, network: false, projectReach: true },
      [TEXTS.ceilingWidening],
    ]);
    expect(s.cli.writes()).toEqual([
      "ceiling set -c dev_1 --outside-sandbox off --project-reach os-user --yes",
    ]);
  });

  test("in docker mode widening outside the sandbox still names it, without the os risk text", async () => {
    const s = setup({ status: loggedIn({ mode: "docker" }) });
    await s.device.impl.requestCeiling(ctxFor(), { outsideSandbox: true });
    expect(s.dialogs.asked[0]?.args.slice(1, 3)).toEqual([
      { outsideSandbox: true, network: false, projectReach: false },
      [TEXTS.ceilingWidening],
    ]);
  });

  test("a widening that grew while the dialog was open is refused", async () => {
    let reads = 0;
    const s = setup(
      { status: loggedIn() },
      {
        handlers: {
          "ceiling show -c dev_1 --json": () => {
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
    await expect(s.device.impl.requestCeiling(ctxFor(), wide)).rejects.toMatchObject({
      code: "failed",
    });
    expect(reads).toBe(2);
    expect(s.cli.writes()).toEqual([]);
  });

  test("a widening that shrank meanwhile still applies what was confirmed", async () => {
    let reads = 0;
    const s = setup(
      { status: loggedIn() },
      {
        handlers: {
          "ceiling show -c dev_1 --json": () => {
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
    expect(await s.device.impl.requestCeiling(ctxFor(), wide)).toBe("applied");
    expect(s.cli.writes()).toEqual([
      "ceiling set -c dev_1 --outside-sandbox on --network open --project-reach os-user --yes",
    ]);
  });

  test("a widening refused: cancelled, nothing written", async () => {
    const s = setup({ status: loggedIn() }, { answer: false });
    expect(await s.device.impl.requestCeiling(ctxFor(), wide)).toBe("cancelled");
    expect(s.cli.writes()).toEqual([]);
  });

  test("the widening is decided from the device, not the page", async () => {
    // Already wide on the machine: the same request is no widening, needs no dialog, writes nothing.
    const s = setup({ status: loggedIn(), ceiling: wide });
    expect(await s.device.impl.requestCeiling(ctxFor(), wide)).toBe("applied");
    expect(s.dialogs.asked).toEqual([]);
    expect(s.cli.writes()).toEqual([]);
  });

  test("a busy confirmation slot refuses the widening before any dialog", async () => {
    const s = setup({ status: loggedIn() });
    const ctx = ctxFor();
    ctx.confirm.mockImplementationOnce(() => Promise.reject({ code: "busy" }));
    await expect(s.device.impl.requestCeiling(ctx, wide)).rejects.toMatchObject({ code: "busy" });
    expect(s.dialogs.asked).toEqual([]);
    expect(s.cli.writes()).toEqual([]);
  });

  test("texts the program cannot give refuse the widening", async () => {
    const cli = fakeCli({ status: loggedIn() });
    const dialogs = fakeDialogs(true);
    const device = createDeviceCapability({
      cli: cli.cli,
      service: fakeService(),
      control: { running: vi.fn(), drain: vi.fn(), subscribe: vi.fn(() => () => {}) },
      dialogs: dialogs.dialogs,
      texts: async () => {
        throw new Error("no texts");
      },
      openVerification: fakeVerification().open,
    });
    await expect(device.impl.requestCeiling(ctxFor(), wide)).rejects.toMatchObject({
      code: "failed",
    });
    expect(dialogs.asked).toEqual([]);
    expect(cli.writes()).toEqual([]);
  });

  test("an unreadable ceiling (an older program's shape) refuses before anything", async () => {
    const s = setup(
      { status: loggedIn() },
      {
        handlers: {
          "ceiling show -c dev_1 --json": () => ({
            lines: [{ fullAccess: false, projectReach: "workspace", revision: null }],
          }),
        },
      },
    );
    await expect(s.device.impl.requestCeiling(ctxFor(), { network: "open" })).rejects.toMatchObject(
      { code: "failed" },
    );
    expect(s.dialogs.asked).toEqual([]);
    expect(s.cli.writes()).toEqual([]);
  });

  test("malformed input fails: empty, unknown fields (the old shape), bad values", async () => {
    const s = setup({ status: loggedIn() });
    for (const input of [
      undefined,
      null,
      {},
      [],
      { fullAccess: true, projectReach: "os-user" },
      { network: "open", fullAccess: true },
      { outsideSandbox: "on" },
      { network: "none" },
      { projectReach: "anywhere" },
      { network: undefined },
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
    const s = setup({ status: loggedIn(), keepAwake: "connected" });
    const ctx = ctxFor();
    expect(await s.device.impl.setKeepAwake(ctx, "while-busy")).toBe("applied");
    expect(s.cli.writes()).toEqual(["keep-awake while-busy"]);
    expect(s.dialogs.asked).toEqual([]);
    expect(ctx.confirm).not.toHaveBeenCalled();
  });

  test("raising asks, then keep-awake <mode> --yes", async () => {
    const s = setup({ status: loggedIn(), keepAwake: "off" });
    const ctx = ctxFor();
    expect(await s.device.impl.setKeepAwake(ctx, "connected")).toBe("applied");
    expect(ctx.confirm).toHaveBeenCalledOnce();
    expect(s.dialogs.asked[0]).toEqual({
      name: "confirmRaiseKeepAwake",
      args: [ctx.window, "connected", ctx.profile],
    });
    expect(s.cli.writes()).toEqual(["keep-awake connected --yes"]);
  });

  test("a raise that grew while the dialog was open is refused", async () => {
    let reads = 0;
    const s = setup(
      { status: loggedIn() },
      {
        handlers: {
          "keep-awake show -c dev_1 --json": () => {
            reads++;
            return { lines: [{ keepAwake: reads === 1 ? "while-busy" : "off" }] };
          },
        },
      },
    );
    await expect(s.device.impl.setKeepAwake(ctxFor(), "connected")).rejects.toMatchObject({
      code: "failed",
    });
    expect(s.cli.writes()).toEqual([]);
  });

  test("raising refused: cancelled", async () => {
    const s = setup({ status: loggedIn(), keepAwake: "off" }, { answer: false });
    expect(await s.device.impl.setKeepAwake(ctxFor(), "while-busy")).toBe("cancelled");
    expect(s.cli.writes()).toEqual([]);
  });

  test("an unknown mode fails", async () => {
    const s = setup({ status: loggedIn() });
    await expect(s.device.impl.setKeepAwake(ctxFor(), "always")).rejects.toMatchObject({
      code: "failed",
    });
  });
});

describe("onStatus", () => {
  test("one control subscription for every listener; each gets its own deployment's view", async () => {
    const s = setup({ status: loggedIn() });
    const other: Profile = {
      ...profileA,
      id: "pb",
      base: "https://b.example.com",
      origin: "https://b.example.com",
    };
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const offA = s.device.events.onStatus(ctxFor(), (v) => seenA.push(v));
    const offB = s.device.events.onStatus(ctxFor(other), (v) => seenB.push(v));
    expect(s.control.subscribe).toHaveBeenCalledOnce();
    s.subscribers[0]?.(live());
    await vi.waitFor(() => expect(seenB).toHaveLength(1));
    await vi.waitFor(() => expect(seenA).toHaveLength(1));
    expect(seenA[0]).toMatchObject({ state: "connected", deviceId: "dev_1" });
    expect(seenB[0]).toEqual({ state: "connected_elsewhere", origin: "https://a.example.com" });
    offA();
    expect(s.unsubscribe).not.toHaveBeenCalled();
    offB();
    expect(s.unsubscribe).toHaveBeenCalledOnce();
  });

  test("a listener added later gets the current status at once", async () => {
    const s = setup({ status: loggedIn() });
    s.device.events.onStatus(ctxFor(), () => {});
    const later: unknown[] = [];
    s.device.events.onStatus(ctxFor(), (v) => later.push(v));
    await vi.waitFor(() => expect(later).toHaveLength(1));
    expect(s.control.subscribe).toHaveBeenCalledOnce();
  });

  test("an unchanged status is not sent again", async () => {
    const s = setup({ status: loggedIn() });
    const seen: unknown[] = [];
    s.device.events.onStatus(ctxFor(), (v) => seen.push(v));
    s.subscribers[0]?.(live());
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    s.subscribers[0]?.(live());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(seen).toHaveLength(1);
  });
});

describe("removing a profile", () => {
  test("connected to it: asks, and on yes stops the service and logs the device out", async () => {
    const s = setup({ status: loggedIn(), service: { installed: true, loaded: true } });
    const parent = { id: "w" };
    await s.device.beforeRemoveProfile(profileA, parent);
    expect(s.dialogs.asked).toEqual([{ name: "confirmRemoveDevice", args: [parent, profileA] }]);
    expect(s.cli.writes()).toEqual(["service stop", "logout"]);
  });

  test("「否」 keeps the device", async () => {
    const s = setup(
      { status: loggedIn(), service: { installed: true, loaded: true } },
      { answer: false },
    );
    await s.device.beforeRemoveProfile(profileA, null);
    expect(s.cli.writes()).toEqual([]);
  });

  test("not connected to it: no question", async () => {
    const s = setup({ status: loggedIn({ url: "https://other.example.com" }) });
    await s.device.beforeRemoveProfile(profileA, null);
    expect(s.dialogs.asked).toEqual([]);
    expect(s.cli.writes()).toEqual([]);
  });
});

describe("no function returns the credential", () => {
  test("every result, connected and elsewhere", async () => {
    for (const status of [loggedIn(), loggedIn({ url: "https://other.example.com" })]) {
      const s = setup(
        { status, service: { installed: true, loaded: true, running: true }, keepAwake: "off" },
        {
          running: [
            {
              tag: "t",
              conversationId: null,
              accountId: null,
              isolation: "full",
              startedAt: "x",
              credential: "cap_dev_SECRET_credential_value",
            },
          ],
        },
      );
      const ctx = ctxFor();
      const results: unknown[] = [];
      const settle = async (p: () => Promise<unknown>) => {
        try {
          results.push(await p());
        } catch (e) {
          results.push(e);
        }
      };
      await settle(() => s.device.impl.status(ctx));
      await settle(() => s.device.impl.running(ctx));
      await settle(() => s.device.impl.connect(ctx, { orgId: "org_1" }));
      await settle(() => s.device.impl.pause(ctx));
      await settle(() => s.device.impl.resume(ctx));
      await settle(() => s.device.impl.disconnect(ctx));
      await settle(() =>
        s.device.impl.requestCeiling(ctx, { outsideSandbox: true, projectReach: "os-user" }),
      );
      await settle(() => s.device.impl.setKeepAwake(ctx, "connected"));
      const seen: unknown[] = [];
      s.device.events.onStatus(ctx, (v) => seen.push(v));
      s.subscribers[0]?.(live());
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      results.push(...seen);
      expect(results.length).toBeGreaterThan(8);
      for (const r of results) expect(carriesSecret(r)).toBe(false);
    }
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
    )) as { CEILING_WIDENING_TEXT: string };
    const login = (await import(
      pathToFileURL(join(DEVICE_PKG, "dist/commands/login.js")).href
    )) as {
      outsideSandboxRiskText: (deviceId: string) => string;
    };
    const got = await texts("dev_1");
    expect(got).toEqual({
      ceilingWidening: ceiling.CEILING_WIDENING_TEXT,
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
  test("the shell's ceiling fields are exactly the device@1 DeviceCeilingRequest", () => {
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
