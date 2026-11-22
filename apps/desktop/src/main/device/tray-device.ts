// The device connections in the tray (spec §9.6): one row per connection of this machine, and the
// worst state for the icon. The connections come from `status --json` through the connection
// controls (one subscription for all of them, which also re-reads when one appears or goes) plus a
// slow poll of each online connection's running list (status events do not fire when an operation
// starts or ends). A connection with no runner is paused: it is logged in, and nothing serves it.
//
// The actions are device@2's own functions, called with the connection's device id (the same
// native resume dialog, the same keep-awake raise dialog; lowering applies at once). The tray is
// the person's own UI on this machine, not a page, so it lists every connection; device@2 still
// refuses an id that is not a connection into the profile of the action. A tray click needs no page
// activation, but it takes the same per-profile confirmation slot the bridge uses (one dialog at a
// time per profile): a click while a dialog is open is dropped, logged. Quitting only calls
// `dispose`: it never stops, drains or logs out a service (spec §9.4).
import type { KeepAwakeMode } from "@capybara-hq/plugin-sdk";
import type { ConfirmGate, ConfirmScope } from "../ipc.ts";
import type { Profile } from "../profiles.ts";
import type { TrayDevice, TrayDeviceActions } from "../tray.ts";
import type { ConnectionControls, RunningOperation } from "./control.ts";
import { ID_PATTERN, type MachineConnection, originOf } from "./machine.ts";

/** How often the running lists are read while a connection is online. */
export const RUNNING_POLL_MS = 5000;

export interface TrayDevicesInput {
  connections: MachineConnection[];
  /** The running count of each online connection, by device id; absent: none. */
  running: ReadonlyMap<string, number>;
  profiles: Profile[];
  /** The policy's mode of a connection with no runner (a runner reports its own); absent: off. */
  keepAwake?: ReadonlyMap<string, KeepAwakeMode>;
}

/** The connections (as `status --json` shows them) to the tray's rows, in the program's order. */
export function trayDevicesFrom(input: TrayDevicesInput): TrayDevice[] {
  const { running, profiles } = input;
  return input.connections.map((c) => {
    const { live } = c;
    const count = running.get(c.deviceId) ?? 0;
    let icon: TrayDevice["icon"];
    if (!live) icon = "paused";
    else if (live.connection === "draining") icon = "paused";
    else if (live.connection === "online") icon = count > 0 ? "busy" : "online";
    // offline, and starting (not serving yet)
    else icon = "offline";
    const origin = originOf(c.url);
    const profile = profiles.find((p) => origin !== null && originOf(p.origin) === origin);
    return {
      deviceId: c.deviceId,
      host: c.host,
      orgLabel: c.orgName ?? c.orgId,
      icon,
      running: count,
      keepAwake: live ? live.keepAwake.mode : (input.keepAwake?.get(c.deviceId) ?? "off"),
      profileId: profile?.id,
    };
  });
}

type TrayCtx = { profile: Profile; window: unknown } & ConfirmScope;

/** The device@2 functions the tray reuses, for one connection. */
export interface TrayDeviceImpl {
  pause(ctx: TrayCtx, deviceId: string): Promise<unknown>;
  resume(ctx: TrayCtx, deviceId: string): Promise<unknown>;
  disconnect(ctx: TrayCtx, deviceId: string): Promise<unknown>;
  setKeepAwake(ctx: TrayCtx, deviceId: string, mode: KeepAwakeMode): Promise<unknown>;
}

export interface TrayDeviceDeps {
  /**
   * False under managed `connectThisMachine: false`: like device@2 not being offered, the tray
   * shows no device and offers no device action. Default true.
   */
  enabled?: boolean;
  controls: Pick<ConnectionControls<MachineConnection>, "read" | "forDevice" | "subscribeAll">;
  /** The policy's keep-awake mode of a connection with no runner. */
  readKeepAwake(deviceId: string): Promise<KeepAwakeMode>;
  profiles(): Profile[];
  impl: TrayDeviceImpl;
  /** The bridge's gate: the same slot as a page's confirming call. */
  gate: ConfirmGate;
  /** Shows `path` (on the profile's deployment) in the profile's window. */
  openDevicePage(profile: Profile, path: string): void;
  /** The rows changed (never called twice with the same rows). */
  onChange(devices: TrayDevice[]): void;
  schedule?(fn: () => void, ms: number): () => void;
  log?: (message: string, err?: unknown) => void;
}

export function createTrayDevice(deps: TrayDeviceDeps) {
  const log = deps.log ?? (() => {});
  const enabled = deps.enabled !== false;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  let devices: TrayDevice[] = [];
  let lastKey = JSON.stringify(devices);
  let lastConnections: MachineConnection[] = [];
  /** The policy's keep-awake modes, read when the connections are (not on every poll). */
  let policy = new Map<string, KeepAwakeMode>();
  let stopControls: (() => void) | undefined;
  let cancelPoll: (() => void) | undefined;
  let seq = 0;
  let inFlight = 0;
  let disposed = false;

  function schedulePoll(): void {
    cancelPoll?.();
    cancelPoll = undefined;
    if (disposed || !lastConnections.some((c) => c.live?.connection === "online")) return;
    cancelPoll = schedule(() => void evaluate(false), RUNNING_POLL_MS);
  }

  async function runningOf(c: MachineConnection): Promise<[string, number]> {
    if (c.live?.connection !== "online") return [c.deviceId, 0];
    try {
      const ops: RunningOperation[] = await deps.controls.forDevice(c.deviceId).running();
      return [c.deviceId, ops.length];
    } catch (err) {
      log("the tray could not read a connection's running operations", err);
      return [c.deviceId, 0];
    }
  }

  async function policyOf(
    c: MachineConnection,
    known: ReadonlyMap<string, KeepAwakeMode>,
  ): Promise<[string, KeepAwakeMode] | undefined> {
    if (c.live) return undefined;
    const cached = known.get(c.deviceId);
    if (cached !== undefined) return [c.deviceId, cached];
    try {
      return [c.deviceId, await deps.readKeepAwake(c.deviceId)];
    } catch (err) {
      log("the tray could not read a connection's keep-awake mode", err);
      return undefined;
    }
  }

  /** `fresh`: read the connections and the policy again; else only the running lists. */
  async function evaluate(fresh: boolean): Promise<void> {
    const mine = ++seq;
    inFlight++;
    try {
      const connections = fresh ? await deps.controls.read() : lastConnections;
      const known = fresh ? new Map<string, KeepAwakeMode>() : policy;
      const running = new Map(await Promise.all(connections.map(runningOf)));
      const modes = new Map(
        (await Promise.all(connections.map((c) => policyOf(c, known)))).filter(
          (e): e is [string, KeepAwakeMode] => e !== undefined,
        ),
      );
      // A newer read arrived while this one ran: it wins.
      if (mine !== seq || disposed) return;
      lastConnections = connections;
      policy = modes;
      const next = trayDevicesFrom({
        connections,
        running,
        profiles: deps.profiles(),
        keepAwake: modes,
      });
      const key = JSON.stringify(next);
      if (key === lastKey) return;
      lastKey = key;
      devices = next;
      deps.onChange(next);
    } catch (err) {
      log("the tray could not read the device connections", err);
    } finally {
      inFlight--;
      if (mine === seq) schedulePoll();
    }
  }

  /** Runs one action for a connection of a saved profile inside the profile's confirmation slot. */
  async function act(profileId: string, run: (ctx: TrayCtx) => Promise<unknown>): Promise<void> {
    const profile = deps.profiles().find((p) => p.id === profileId);
    if (!profile || !enabled) return;
    // A tray click is a user action in the app's own UI: the activation is given.
    if (deps.gate.isConfirmingCallAllowed(profile.id, true) !== "ok") {
      log("a device dialog is already open for this platform");
      return;
    }
    // No parent window: the dialog is app-modal. The slot is already held for this action.
    const ctx = { profile, window: undefined, confirm: <T>(f: () => Promise<T>) => f() };
    try {
      await run(ctx);
    } catch (err) {
      log("a tray device action failed", err);
    } finally {
      deps.gate.release(profile.id);
      refresh();
    }
  }

  /** Reads the connections now (after an action, or when the saved profiles changed). */
  function refresh(): void {
    if (disposed || !enabled) return;
    void evaluate(true);
  }

  const actions: TrayDeviceActions = {
    pause: (id, deviceId) => act(id, (ctx) => deps.impl.pause(ctx, deviceId)),
    resume: (id, deviceId) => act(id, (ctx) => deps.impl.resume(ctx, deviceId)),
    disconnect: (id, deviceId) => act(id, (ctx) => deps.impl.disconnect(ctx, deviceId)),
    setKeepAwake: (id, deviceId, mode) =>
      act(id, (ctx) => deps.impl.setKeepAwake(ctx, deviceId, mode)),
    openDevicePage(profileId, deviceId) {
      const profile = deps.profiles().find((p) => p.id === profileId);
      if (!profile || !enabled || !ID_PATTERN.test(deviceId)) return;
      deps.openDevicePage(profile, `/devices/${deviceId}`);
    },
  };

  return {
    actions,
    current: (): TrayDevice[] => devices,
    /** Evaluations in flight (tests wait for zero). */
    pending: (): number => inFlight,
    refresh,
    /** Subscribes once and reads once (never while disabled). */
    start(): void {
      if (stopControls || disposed || !enabled) return;
      stopControls = deps.controls.subscribeAll(() => void evaluate(true));
      void evaluate(true);
    },
    /** Quit: ends the subscription and the poll. Never touches a service. */
    dispose(): void {
      disposed = true;
      stopControls?.();
      stopControls = undefined;
      cancelPoll?.();
      cancelPoll = undefined;
    },
  };
}

export type TrayDeviceController = ReturnType<typeof createTrayDevice>;
