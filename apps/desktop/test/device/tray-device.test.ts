import { describe, expect, test, vi } from "vitest";
import { createDeviceCapability } from "../../src/main/device/capability.ts";
import type { ControlClient, LiveStatus } from "../../src/main/device/control.ts";
import { readKeepAwake, readMachine } from "../../src/main/device/machine.ts";
import { createTrayDevice, trayDeviceFrom } from "../../src/main/device/tray-device.ts";
import { createConfirmGate } from "../../src/main/ipc.ts";
import type { TrayDevice } from "../../src/main/tray.ts";
import { fakeCli, fakeDialogs, fakeService, live, loggedIn, profileA } from "./fake-device.ts";

describe("trayDeviceFrom (LiveStatus to the tray's state)", () => {
  const profiles = [profileA];
  const from = (l: LiveStatus | undefined, o: { loggedIn?: boolean; running?: number } = {}) =>
    trayDeviceFrom({
      live: l,
      machine: o.loggedIn
        ? { loggedIn: true, url: profileA.base, deviceId: "dev_1" }
        : { loggedIn: false },
      running: o.running ?? 0,
      profiles,
      keepAwake: "while-busy",
    });

  test("no runner and not logged in: not connected", () => {
    expect(from(undefined).icon).toBe("not_connected");
  });
  test("no runner but logged in: paused (stopped)", () => {
    expect(from(undefined, { loggedIn: true })).toMatchObject({
      icon: "paused",
      profileId: "pa",
      deviceId: "dev_1",
    });
  });
  test("online, offline, starting, draining", () => {
    expect(from(live()).icon).toBe("online");
    expect(from(live({ connection: "offline" })).icon).toBe("offline");
    expect(from(live({ connection: "starting" })).icon).toBe("offline");
    expect(from(live({ connection: "draining" })).icon).toBe("paused");
  });
  test("online with running operations is busy; offline or paused stay what they are", () => {
    expect(from(live(), { running: 2 })).toMatchObject({ icon: "busy", running: 2 });
    expect(from(live({ connection: "offline" }), { running: 2 }).icon).toBe("offline");
    expect(from(live({ connection: "draining" }), { running: 2 })).toMatchObject({
      icon: "paused",
      running: 2,
    });
  });
  test("keep-awake comes from the live status; the profile by origin", () => {
    const d = from(live({ keepAwake: { mode: "connected", held: true } }));
    expect(d.keepAwake).toBe("connected");
    expect(d.profileId).toBe("pa");
    expect(from(live({ url: "https://other.example.org" })).profileId).toBeUndefined();
  });
});

function harness(
  o: {
    answer?: boolean;
    running?: number;
    machine?: Record<string, unknown>;
    enabled?: boolean;
  } = {},
) {
  const f = fakeCli({ status: o.machine ?? loggedIn() });
  const d = fakeDialogs(o.answer ?? true);
  const subs: ((s: LiveStatus | undefined) => void)[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  let runningCount = o.running ?? 0;
  const control = {
    subscribe: vi.fn((cb: (s: LiveStatus | undefined) => void) => {
      subs.push(cb);
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    }),
    running: vi.fn(async () =>
      Array.from({ length: runningCount }, (_, i) => ({
        tag: `t${i}`,
        conversationId: null,
        accountId: null,
        isolation: "restricted" as const,
        startedAt: "2026-11-20T08:00:00.000Z",
      })),
    ),
    drain: vi.fn(async () => {}),
    status: vi.fn(async (): Promise<LiveStatus | undefined> => undefined),
  } satisfies ControlClient;
  const cap = createDeviceCapability({
    cli: f.cli,
    service: fakeService(),
    control,
    dialogs: d.dialogs,
    texts: async () => ({ ceilingWidening: "w", outsideSandboxRisk: "r" }),
    openVerification: () => ({ close() {}, onClosed() {} }),
  });
  const gate = createConfirmGate();
  const polls: { fn: () => void; ms: number; cancel: ReturnType<typeof vi.fn> }[] = [];
  const states: TrayDevice[] = [];
  const opened: [string, string][] = [];
  const tray = createTrayDevice({
    ...(o.enabled === undefined ? {} : { enabled: o.enabled }),
    control,
    readMachine: () => readMachine(f.cli),
    readKeepAwake: () => readKeepAwake(f.cli, "dev_1"),
    profiles: () => [profileA],
    impl: cap.impl,
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
    control,
    subs,
    stops,
    tray,
    gate,
    polls,
    states,
    opened,
    settle,
    setRunning: (n: number) => {
      runningCount = n;
    },
  };
}

describe("the tray's device source", () => {
  test("managed connectThisMachine: false shows no device and reads nothing", async () => {
    const h = harness({ enabled: false });
    h.tray.start();
    h.tray.refresh();
    expect(h.control.subscribe).not.toHaveBeenCalled();
    expect(h.control.status).not.toHaveBeenCalled();
    expect(h.tray.current().icon).toBe("not_connected");
    await h.tray.actions.disconnect("pa");
    await h.tray.actions.pause("pa");
    // No device command ran and no state was reported.
    expect(h.f.calls).toEqual([]);
    expect(h.states).toEqual([]);
  });

  test("subscribes once and reports each LiveStatus", async () => {
    const h = harness();
    h.tray.start();
    h.tray.start();
    expect(h.control.subscribe).toHaveBeenCalledTimes(1);
    h.subs[0]?.(live());
    await h.settle();
    expect(h.tray.current().icon).toBe("online");
    h.setRunning(1);
    h.subs[0]?.(live());
    await h.settle();
    expect(h.tray.current()).toMatchObject({ icon: "busy", running: 1 });
  });

  test("the runner going away reads the machine: logged in is paused, else not connected", async () => {
    const h = harness();
    h.tray.start();
    h.subs[0]?.(undefined);
    await h.settle();
    expect(h.tray.current().icon).toBe("paused");
    const g = harness({ machine: { loggedIn: false } });
    g.tray.start();
    g.subs[0]?.(undefined);
    await g.settle();
    expect(g.tray.current().icon).toBe("not_connected");
  });

  test("a stale read does not overwrite a newer status", async () => {
    const h = harness();
    h.tray.start();
    h.subs[0]?.(undefined);
    h.subs[0]?.(live({ connection: "offline" }));
    await h.settle();
    expect(h.tray.current().icon).toBe("offline");
  });

  test("the running count is refreshed on a schedule while a runner lives", async () => {
    const h = harness();
    h.tray.start();
    h.subs[0]?.(live());
    await h.settle();
    expect(h.polls).toHaveLength(1);
    h.setRunning(4);
    h.polls[0]?.fn();
    await h.settle();
    expect(h.tray.current()).toMatchObject({ icon: "busy", running: 4 });
    // the next poll is scheduled again; when the runner goes the poll is cancelled
    expect(h.polls.length).toBeGreaterThan(1);
    h.subs[0]?.(undefined);
    await h.settle();
    expect(h.polls.at(-1)?.cancel).toHaveBeenCalled();
  });

  test("unchanged state is not reported twice", async () => {
    const h = harness();
    h.tray.start();
    h.subs[0]?.(live());
    await h.settle();
    const n = h.states.length;
    h.subs[0]?.(live());
    await h.settle();
    expect(h.states).toHaveLength(n);
  });
});

describe("the tray's actions reuse device@1", () => {
  test("pause drains; no dialog", async () => {
    const h = harness();
    h.tray.start();
    await h.tray.actions.pause("pa");
    expect(h.control.drain).toHaveBeenCalledTimes(1);
    expect(h.d.asked).toEqual([]);
  });

  test("resume asks the same native dialog and starts the service on yes", async () => {
    const h = harness();
    await h.tray.actions.resume("pa");
    expect(h.d.names()).toEqual(["confirmResume"]);
    expect(h.d.asked[0]?.args[1]).toBe(profileA);
    expect(h.f.commands()).toContain("service start");
  });

  test("resume answered no starts nothing", async () => {
    const h = harness({ answer: false });
    await h.tray.actions.resume("pa");
    expect(h.f.commands()).not.toContain("service start");
  });

  test("keep-awake raise asks the dialog, lowering applies without one", async () => {
    const h = harness();
    await h.tray.actions.setKeepAwake("pa", "connected");
    expect(h.d.names()).toEqual(["confirmRaiseKeepAwake"]);
    expect(h.f.commands()).toContain("keep-awake connected --yes");
    const g = harness();
    await g.tray.actions.setKeepAwake("pa", "off");
    expect(g.d.asked).toEqual([]);
    expect(g.f.commands()).toContain("keep-awake off");
  });

  test("disconnect ends the runner, with no dialog", async () => {
    const h = harness();
    await h.tray.actions.disconnect("pa");
    expect(h.f.commands()).toContain("stop");
    expect(h.d.asked).toEqual([]);
  });

  test("a second dialog is not opened while one is open (the profile's slot)", async () => {
    let release: (v: boolean) => void = () => {};
    const h = harness();
    const open = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    h.d.dialogs.confirmResume = open;
    const first = h.tray.actions.resume("pa");
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    // a second tray click, of any dialog-raising action, is dropped: no second dialog
    await h.tray.actions.resume("pa");
    await h.tray.actions.setKeepAwake("pa", "connected");
    expect(open).toHaveBeenCalledTimes(1);
    expect(h.d.names()).not.toContain("confirmRaiseKeepAwake");
    release(false);
    await first;
    // the slot is free again
    expect(h.gate.isConfirmingCallAllowed("pa", true)).toBe("ok");
  });

  test("an unknown profile id does nothing", async () => {
    const h = harness();
    await h.tray.actions.pause("nope");
    await h.tray.actions.resume("nope");
    expect(h.control.drain).not.toHaveBeenCalled();
    expect(h.d.asked).toEqual([]);
  });

  test("a failing action is swallowed (logged) and the state is refreshed", async () => {
    const h = harness();
    h.control.drain.mockRejectedValueOnce(new Error("boom"));
    await expect(h.tray.actions.pause("pa")).resolves.toBeUndefined();
  });

  test("the device page: /devices/<id> in the profile window, id validated", () => {
    const h = harness();
    h.tray.actions.openDevicePage("pa", "dev_1");
    h.tray.actions.openDevicePage("pa", "../x");
    h.tray.actions.openDevicePage("nope", "dev_1");
    expect(h.opened).toEqual([["pa", "/devices/dev_1"]]);
  });
});

describe("quit (spec 9.4)", () => {
  test("dispose only ends the subscription and the poll: no stop, drain, logout or dialog", async () => {
    const h = harness();
    h.tray.start();
    h.subs[0]?.(live());
    await h.settle();
    const before = h.f.commands().length;
    h.tray.dispose();
    expect(h.stops[0]).toHaveBeenCalledTimes(1);
    expect(h.polls.at(-1)?.cancel).toHaveBeenCalled();
    expect(h.control.drain).not.toHaveBeenCalled();
    expect(h.f.commands().slice(before)).toEqual([]);
    expect(h.f.writes()).toEqual([]);
    expect(h.d.asked).toEqual([]);
    // late events after dispose are ignored
    h.subs[0]?.(live({ connection: "offline" }));
    expect(h.tray.current().icon).toBe("online");
  });
});
