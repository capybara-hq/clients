// The device in the tray (spec §9.6): this machine's state for the icon and the menu, and the
// menu's actions. The state comes from one control subscription (the runner's LiveStatus) plus a
// slow poll of the running list (status events do not fire when an operation starts or ends);
// with no runner, the machine's own login says paused (logged in) or not connected.
//
// The actions are device@1's own functions (the same native resume dialog, the same keep-awake
// raise dialog; lowering applies at once). A tray click is a user action in the app's own UI, so
// it needs no page activation, but it takes the same per-profile confirmation slot the bridge
// uses (one dialog at a time per profile): a click while a dialog is open is dropped, logged.
// Quitting only calls `dispose`: it never stops, drains or logs out the service (spec §9.4).
import type { KeepAwakeMode } from "@capybara-hq/plugin-sdk";
import type { ConfirmGate, ConfirmScope } from "../ipc.ts";
import type { Profile } from "../profiles.ts";
import type { TrayDevice, TrayDeviceActions, TrayIconState } from "../tray.ts";
import { ID_PATTERN } from "./connect.ts";
import type { ControlClient, LiveStatus } from "./control.ts";
import { type Machine, originOf } from "./machine.ts";

/** How often the running list is read while a runner lives. */
export const RUNNING_POLL_MS = 5000;

export interface TrayDeviceInput {
  live: LiveStatus | undefined;
  /** Read only when there is no runner. */
  machine:
    | Pick<Extract<Machine, { loggedIn: true }>, "loggedIn" | "url" | "deviceId">
    | { loggedIn: false };
  running: number;
  profiles: Profile[];
  /** The policy's mode (used when no runner reports it). */
  keepAwake: KeepAwakeMode;
}

/** LiveStatus (or the machine's login) to the tray's state. */
export function trayDeviceFrom(input: TrayDeviceInput): TrayDevice {
  const { live, machine, profiles } = input;
  const url = live?.url ?? (machine.loggedIn ? machine.url : undefined);
  const deviceId = live?.deviceId ?? (machine.loggedIn ? machine.deviceId : undefined);
  if (!live && !machine.loggedIn) {
    return { icon: "not_connected", running: 0, keepAwake: input.keepAwake };
  }
  const origin = url === undefined ? null : originOf(url);
  const profile = profiles.find((p) => origin !== null && originOf(p.origin) === origin);
  let icon: TrayIconState;
  if (!live) icon = "paused";
  else if (live.connection === "draining") icon = "paused";
  else if (live.connection === "online") icon = input.running > 0 ? "busy" : "online";
  // offline, and starting (not serving yet)
  else icon = "offline";
  return {
    icon,
    running: input.running,
    keepAwake: live ? live.keepAwake.mode : input.keepAwake,
    profileId: profile?.id,
    deviceId,
  };
}

/** The device@1 functions the tray reuses. */
export interface TrayDeviceImpl {
  pause(ctx: { profile: Profile; window: unknown } & ConfirmScope): Promise<unknown>;
  resume(ctx: { profile: Profile; window: unknown } & ConfirmScope): Promise<unknown>;
  disconnect(ctx: { profile: Profile; window: unknown } & ConfirmScope): Promise<unknown>;
  setKeepAwake(
    ctx: { profile: Profile; window: unknown } & ConfirmScope,
    mode: KeepAwakeMode,
  ): Promise<unknown>;
}

export interface TrayDeviceDeps {
  /**
   * False under managed `connectThisMachine: false`: like device@1 not being offered, the tray
   * shows no device and offers no device action. Default true.
   */
  enabled?: boolean;
  control: Pick<ControlClient, "subscribe" | "running" | "status">;
  readMachine(): Promise<Machine>;
  readKeepAwake(): Promise<KeepAwakeMode>;
  profiles(): Profile[];
  impl: TrayDeviceImpl;
  /** The bridge's gate: the same slot as a page's confirming call. */
  gate: ConfirmGate;
  /** Shows `path` (on the profile's deployment) in the profile's window. */
  openDevicePage(profile: Profile, path: string): void;
  /** The state changed (never called twice with the same state). */
  onChange(state: TrayDevice): void;
  schedule?(fn: () => void, ms: number): () => void;
  log?: (message: string, err?: unknown) => void;
}

const NONE: TrayDevice = { icon: "not_connected", running: 0, keepAwake: "off" };

export function createTrayDevice(deps: TrayDeviceDeps) {
  const log = deps.log ?? (() => {});
  const enabled = deps.enabled !== false;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  let state: TrayDevice = NONE;
  let lastKey = JSON.stringify(state);
  let lastLive: LiveStatus | undefined;
  let stopControl: (() => void) | undefined;
  let cancelPoll: (() => void) | undefined;
  let seq = 0;
  let inFlight = 0;
  let disposed = false;

  function schedulePoll(): void {
    cancelPoll?.();
    cancelPoll = undefined;
    if (disposed || lastLive === undefined) return;
    cancelPoll = schedule(() => void evaluate(lastLive), RUNNING_POLL_MS);
  }

  async function evaluate(live: LiveStatus | undefined): Promise<void> {
    const mine = ++seq;
    lastLive = live;
    inFlight++;
    try {
      let next: TrayDevice;
      if (live) {
        const running = (await deps.control.running()).length;
        next = trayDeviceFrom({
          live,
          machine: { loggedIn: false },
          running,
          profiles: deps.profiles(),
          keepAwake: live.keepAwake.mode,
        });
      } else {
        const machine = await deps.readMachine();
        const keepAwake = machine.loggedIn ? await deps.readKeepAwake() : "off";
        next = trayDeviceFrom({
          live,
          machine,
          running: 0,
          profiles: deps.profiles(),
          keepAwake,
        });
      }
      // A newer status arrived while this one was read: it wins.
      if (mine !== seq || disposed) return;
      const key = JSON.stringify(next);
      if (key === lastKey) return;
      lastKey = key;
      state = next;
      deps.onChange(next);
    } catch (err) {
      log("the tray could not read the device", err);
    } finally {
      inFlight--;
      if (mine === seq) schedulePoll();
    }
  }

  /** Runs one action for a saved profile inside its confirmation slot. */
  async function act(
    profileId: string,
    run: (ctx: { profile: Profile; window: unknown } & ConfirmScope) => Promise<unknown>,
  ): Promise<void> {
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

  /** Reads the runner's status now (after an action, or when the saved profiles changed). */
  function refresh(): void {
    if (disposed || !enabled) return;
    deps.control.status().then(
      (live) => evaluate(live),
      (err) => log("the tray could not read the device", err),
    );
  }

  const actions: TrayDeviceActions = {
    pause: (id) => act(id, (ctx) => deps.impl.pause(ctx)),
    resume: (id) => act(id, (ctx) => deps.impl.resume(ctx)),
    disconnect: (id) => act(id, (ctx) => deps.impl.disconnect(ctx)),
    setKeepAwake: (id, mode) => act(id, (ctx) => deps.impl.setKeepAwake(ctx, mode)),
    openDevicePage(profileId, deviceId) {
      const profile = deps.profiles().find((p) => p.id === profileId);
      if (!profile || !enabled || !ID_PATTERN.test(deviceId)) return;
      deps.openDevicePage(profile, `/devices/${deviceId}`);
    },
  };

  return {
    actions,
    current: (): TrayDevice => state,
    /** Evaluations in flight (tests wait for zero). */
    pending: (): number => inFlight,
    refresh,
    /** Subscribes once (never while disabled). */
    start(): void {
      if (stopControl || disposed || !enabled) return;
      stopControl = deps.control.subscribe((live) => void evaluate(live));
    },
    /** Quit: ends the subscription and the poll. Never touches the service. */
    dispose(): void {
      disposed = true;
      stopControl?.();
      stopControl = undefined;
      cancelPoll?.();
      cancelPoll = undefined;
    },
  };
}

export type TrayDeviceController = ReturnType<typeof createTrayDevice>;
