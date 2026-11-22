import { describe, expect, test, vi } from "vitest";
import { createDeviceCapability } from "../../src/main/device/capability.ts";
import { readConnections, readKeepAwake } from "../../src/main/device/machine.ts";
import { createTrayDevice, trayDevicesFrom } from "../../src/main/device/tray-device.ts";
import { createConfirmGate } from "../../src/main/ipc.ts";
import type { TrayDevice } from "../../src/main/tray.ts";
import {
  connectionJson,
  fakeCli,
  fakeControls,
  fakeDialogs,
  fakeService,
  live,
  MACHINE_DIR,
  profileA,
  profileB,
  threeConnections,
} from "./fake-device.ts";

const op = (i: number) => ({
  tag: `t${i}`,
  conversationId: null,
  accountId: null,
  isolation: "restricted" as const,
  startedAt: "2026-11-20T08:00:00.000Z",
});

type Over = Parameters<typeof threeConnections>[0];
const stopped = { live: null, control: "absent" };

describe("trayDevicesFrom (status --json to the tray's rows)", () => {
  const parse = (status: Record<string, unknown>) =>
    readConnections(fakeCli({ status }).cli, MACHINE_DIR);
  const from = async (
    over: Over = {},
    running: [string, number][] = [],
    profiles = [profileA, profileB],
  ) =>
    trayDevicesFrom({
      connections: await parse(threeConnections(over)),
      running: new Map(running),
      profiles,
      keepAwake: new Map([["dev_a1", "connected"]]),
    });

  test("one row per connection: host, org label (name, else id), profile by origin", async () => {
    const rows = await from();
    expect(rows.map((r) => [r.deviceId, r.host, r.orgLabel, r.profileId])).toEqual([
      ["dev_a1", "a.example.com", "Acme", "pa"],
      ["dev_a2", "a.example.com", "Acme", "pa"],
      ["dev_b1", "b.example.com", "Acme", "pb"],
    ]);
    const [named] = await parse({
      connections: [connectionJson("dev_x", { orgName: null })],
      unreadable: [],
    });
    const [row] = trayDevicesFrom({
      connections: named ? [named] : [],
      running: new Map(),
      profiles: [],
    });
    expect(row?.orgLabel).toBe("org_1");
  });

  test("a deployment that is not a saved profile has no profile id", async () => {
    const rows = await from({}, [], [profileA]);
    expect(rows.map((r) => r.profileId)).toEqual(["pa", "pa", undefined]);
  });

  test("online, offline, starting, draining, no runner", async () => {
    const rows = await from({
      dev_a1: { live: live({ deviceId: "dev_a1", connection: "offline" }) },
      dev_a2: { live: live({ deviceId: "dev_a2", connection: "draining" }) },
      dev_b1: stopped,
    });
    expect(rows.map((r) => r.icon)).toEqual(["offline", "paused", "paused"]);
    const starting = await from({ dev_a1: { live: live({ connection: "starting" }) } });
    expect(starting[0]?.icon).toBe("offline");
    expect((await from()).map((r) => r.icon)).toEqual(["online", "online", "online"]);
  });

  test("online with running operations is busy; offline or paused stay what they are", async () => {
    const rows = await from({}, [["dev_a2", 2]]);
    expect(rows.map((r) => [r.icon, r.running])).toEqual([
      ["online", 0],
      ["busy", 2],
      ["online", 0],
    ]);
    const off = await from({ dev_a1: { live: live({ connection: "offline" }) } }, [["dev_a1", 2]]);
    expect(off[0]?.icon).toBe("offline");
  });

  test("keep-awake: the runner's, or the policy's when no runner answers (default off)", async () => {
    const rows = await from({
      dev_a1: stopped,
      dev_a2: { live: live({ keepAwake: { mode: "connected", held: true } }) },
      dev_b1: stopped,
    });
    expect(rows.map((r) => r.keepAwake)).toEqual(["connected", "connected", "off"]);
  });
});

function harness(
  o: { answer?: boolean; status?: Record<string, unknown>; enabled?: boolean } = {},
) {
  let status = o.status ?? threeConnections();
  const f = fakeCli({}, { "status --json": () => ({ lines: [status] }) });
  const d = fakeDialogs(o.answer ?? true);
  const c = fakeControls(f.cli);
  const cap = createDeviceCapability({
    cli: f.cli,
    controls: c.controls,
    service: fakeService(),
    dialogs: d.dialogs,
    texts: async () => ({ ceilingWidening: "w", otherConnections: "o", outsideSandboxRisk: "r" }),
    openVerification: () => ({ close() {}, onClosed() {} }),
  });
  const gate = createConfirmGate();
  const polls: { fn: () => void; ms: number; cancel: ReturnType<typeof vi.fn> }[] = [];
  const states: TrayDevice[][] = [];
  const opened: [string, string][] = [];
  const impl = {
    pause: vi.fn((ctx, deviceId: string) => cap.impl.pause(ctx, { deviceId })),
    resume: vi.fn((ctx, deviceId: string) => cap.impl.resume(ctx, { deviceId })),
    disconnect: vi.fn((ctx, deviceId: string) => cap.impl.disconnect(ctx, { deviceId })),
    setKeepAwake: vi.fn((ctx, deviceId: string, mode) =>
      cap.impl.setKeepAwake(ctx, { deviceId, mode }),
    ),
  };
  const tray = createTrayDevice({
    ...(o.enabled === undefined ? {} : { enabled: o.enabled }),
    controls: c.controls,
    readKeepAwake: (id) => readKeepAwake(f.cli, id),
    profiles: () => [profileA, profileB],
    impl,
    gate,
    openDevicePage: (p, path) => opened.push([p.id, path]),
    onChange: (s) => states.push(s),
    schedule: (fn, ms) => {
      const cancel = vi.fn();
      polls.push({ fn, ms, cancel });
      return cancel;
    },
  });
  const settle = () => vi.waitFor(() => expect(tray.pending()).toBe(0));
  return {
    f,
    d,
    c,
    tray,
    gate,
    polls,
    states,
    opened,
    impl,
    settle,
    setStatus: (s: Record<string, unknown>) => {
      status = s;
    },
  };
}

const icons = (t: { current(): TrayDevice[] }) => t.current().map((r) => r.icon);
const oneStopped = {
  connections: [connectionJson("dev_a1", stopped)],
  unreadable: [],
};

describe("the tray's device source", () => {
  test("managed connectThisMachine: false shows no device and reads nothing", async () => {
    const h = harness({ enabled: false });
    h.tray.start();
    h.tray.refresh();
    expect(h.c.controls.subscribeAll).not.toHaveBeenCalled();
    expect(h.c.controls.read).not.toHaveBeenCalled();
    expect(h.tray.current()).toEqual([]);
    await h.tray.actions.disconnect("pa", "dev_a1");
    await h.tray.actions.pause("pa", "dev_a1");
    // No device command ran and nothing was reported.
    expect(h.f.calls).toEqual([]);
    expect(h.states).toEqual([]);
  });

  test("start subscribes once and reads every connection: a row for each", async () => {
    const h = harness();
    h.tray.start();
    h.tray.start();
    expect(h.c.controls.subscribeAll).toHaveBeenCalledTimes(1);
    await h.settle();
    expect(h.tray.current().map((r) => r.deviceId)).toEqual(["dev_a1", "dev_a2", "dev_b1"]);
    expect(icons(h.tray)).toEqual(["online", "online", "online"]);
  });

  test("a change reads again: a runner that went away is paused, a new connection gets a row", async () => {
    const h = harness();
    h.tray.start();
    await h.settle();
    h.setStatus(threeConnections({ dev_a2: stopped }));
    h.c.changed();
    await h.settle();
    expect(icons(h.tray)).toEqual(["online", "paused", "online"]);
    h.setStatus({ connections: [], unreadable: [] });
    h.c.changed();
    await h.settle();
    expect(h.tray.current()).toEqual([]);
  });

  test("a stale read does not overwrite a newer one", async () => {
    const h = harness();
    const original = h.c.controls.read.getMockImplementation();
    let release: (v: never[]) => void = () => {};
    h.c.controls.read.mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
    h.tray.refresh();
    h.c.controls.read.mockImplementation(original as never);
    h.tray.refresh();
    await vi.waitFor(() => expect(h.tray.current()).toHaveLength(3));
    release([]);
    await h.settle();
    expect(h.tray.current()).toHaveLength(3);
  });

  test("the running counts are refreshed on a schedule while a connection is online", async () => {
    const h = harness();
    h.tray.start();
    await h.settle();
    expect(h.polls).toHaveLength(1);
    expect(h.polls[0]?.ms).toBe(5000);
    h.c.client("dev_a2").running.mockResolvedValue([op(1), op(2), op(3), op(4)]);
    const reads = h.c.controls.read.mock.calls.length;
    h.polls[0]?.fn();
    await h.settle();
    expect(h.tray.current().map((r) => [r.deviceId, r.icon, r.running])).toEqual([
      ["dev_a1", "online", 0],
      ["dev_a2", "busy", 4],
      ["dev_b1", "online", 0],
    ]);
    // a poll reads the running lists only: no new `status --json`
    expect(h.c.controls.read.mock.calls.length).toBe(reads);
    expect(h.polls.length).toBeGreaterThan(1);
  });

  test("no poll when no connection is online", async () => {
    const h = harness({ status: oneStopped });
    h.tray.start();
    await h.settle();
    expect(icons(h.tray)).toEqual(["paused"]);
    expect(h.polls).toEqual([]);
  });

  test("a connection with no runner shows the policy's keep-awake mode", async () => {
    const h = harness({ status: oneStopped });
    h.tray.start();
    await h.settle();
    expect(h.tray.current()[0]?.keepAwake).toBe("while-busy");
  });

  test("unchanged rows are not reported twice", async () => {
    const h = harness();
    h.tray.start();
    await h.settle();
    const n = h.states.length;
    h.c.changed();
    await h.settle();
    expect(h.states).toHaveLength(n);
  });
});

describe("the tray's actions reuse device@2, per connection", () => {
  test("pause drains that connection only; no dialog", async () => {
    const h = harness();
    await h.tray.actions.pause("pa", "dev_a2");
    expect(h.impl.pause).toHaveBeenCalledWith(expect.anything(), "dev_a2");
    expect(h.c.client("dev_a2").drain).toHaveBeenCalledTimes(1);
    expect(h.c.clients.has("dev_a1")).toBe(false);
    expect(h.d.asked).toEqual([]);
  });

  test("resume asks the same native dialog and starts that connection's service on yes", async () => {
    const h = harness();
    await h.tray.actions.resume("pa", "dev_a2");
    expect(h.d.names()).toEqual(["confirmResume"]);
    expect(h.d.asked[0]?.args[1]).toBe(profileA);
    expect(h.f.commands()).toContain("service start -c dev_a2");
    expect(h.f.commands()).not.toContain("service start -c dev_a1");
  });

  test("resume answered no starts nothing", async () => {
    const h = harness({ answer: false });
    await h.tray.actions.resume("pa", "dev_a1");
    expect(h.f.commands()).not.toContain("service start -c dev_a1");
  });

  test("keep-awake raise asks the dialog, lowering applies without one", async () => {
    const h = harness();
    await h.tray.actions.setKeepAwake("pa", "dev_a1", "connected");
    expect(h.d.names()).toEqual(["confirmRaiseKeepAwake"]);
    expect(h.f.commands()).toContain("keep-awake connected -c dev_a1 --yes");
    const g = harness();
    await g.tray.actions.setKeepAwake("pa", "dev_a2", "off");
    expect(g.d.asked).toEqual([]);
    expect(g.f.commands()).toContain("keep-awake off -c dev_a2");
  });

  test("disconnect ends that connection's runner, with no dialog", async () => {
    const h = harness();
    await h.tray.actions.disconnect("pa", "dev_a2");
    expect(h.f.commands()).toContain("stop -c dev_a2");
    expect(h.f.commands()).not.toContain("stop -c dev_a1");
    expect(h.d.asked).toEqual([]);
  });

  test("a row's action for a device outside the profile's deployment runs nothing", async () => {
    const h = harness();
    // dev_b1 is a connection into B: device@2 refuses it for A's profile
    await h.tray.actions.disconnect("pa", "dev_b1");
    await h.tray.actions.resume("pa", "dev_b1");
    expect(h.f.writes()).toEqual([]);
    expect(h.d.asked).toEqual([]);
  });

  test("a second dialog is not opened while one is open (the profile's slot)", async () => {
    let release: (v: boolean) => void = () => {};
    const h = harness();
    const open = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    h.d.dialogs.confirmResume = open;
    const first = h.tray.actions.resume("pa", "dev_a1");
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    // a second tray click, of any dialog-raising action, is dropped: no second dialog
    await h.tray.actions.resume("pa", "dev_a2");
    await h.tray.actions.setKeepAwake("pa", "dev_a1", "connected");
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.d.names()).not.toContain("confirmRaiseKeepAwake");
    release(false);
    await first;
    // the slot is free again
    expect(h.gate.isConfirmingCallAllowed("pa", true)).toBe("ok");
  });

  test("an unknown profile id does nothing", async () => {
    const h = harness();
    await h.tray.actions.pause("nope", "dev_a1");
    await h.tray.actions.resume("nope", "dev_a1");
    expect(h.impl.pause).not.toHaveBeenCalled();
    expect(h.d.asked).toEqual([]);
  });

  test("a failing action is swallowed (logged) and the rows are read again", async () => {
    const h = harness();
    h.c.client("dev_a1").drain.mockRejectedValueOnce(new Error("boom"));
    const reads = h.c.controls.read.mock.calls.length;
    await expect(h.tray.actions.pause("pa", "dev_a1")).resolves.toBeUndefined();
    expect(h.c.controls.read.mock.calls.length).toBeGreaterThan(reads);
  });

  test("the device page: /devices/<id> in the profile window, id validated", () => {
    const h = harness();
    h.tray.actions.openDevicePage("pa", "dev_a2");
    h.tray.actions.openDevicePage("pa", "../x");
    h.tray.actions.openDevicePage("nope", "dev_a1");
    expect(h.opened).toEqual([["pa", "/devices/dev_a2"]]);
  });
});

describe("quit (spec 9.4)", () => {
  test("dispose only ends the subscription and the poll: no stop, drain, logout or dialog", async () => {
    const h = harness();
    h.tray.start();
    await h.settle();
    const before = h.f.commands().length;
    h.tray.dispose();
    expect(h.c.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.polls.at(-1)?.cancel).toHaveBeenCalled();
    for (const client of h.c.clients.values()) expect(client.drain).not.toHaveBeenCalled();
    expect(h.f.commands().slice(before)).toEqual([]);
    expect(h.f.writes()).toEqual([]);
    expect(h.d.asked).toEqual([]);
    // late changes after dispose are ignored
    const n = h.states.length;
    h.c.changed();
    await h.settle();
    expect(h.states).toHaveLength(n);
  });
});
