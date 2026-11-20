// `device@1` (spec §8, §9): every function runs here in main through the device CLI and the
// control socket, acts only for the calling profile's deployment, and answers plain data of the
// SDK's shapes, never a credential. The confirming calls are `connect` and `resume` (the bridge
// takes the confirmation slot for them) and, decided here from the machine's own state, a
// widening `requestCeiling` and a raising `setKeepAwake` (they take the slot through
// `ctx.confirm` only then); narrowing and lowering apply at once (spec §9.5, §9.7).
import type {
  KeepAwakeMode,
  RunningOperationView,
  ThisMachineStatus,
} from "@capybara-hq/plugin-sdk";
import type { ConfirmScope } from "../ipc.ts";
import type { Profile } from "../profiles.ts";
import type { DeviceCli } from "./cli.ts";
import {
  createConnect,
  type DeviceTarget,
  run,
  stopAndLogout,
  type VerificationWindow,
} from "./connect.ts";
import type { ControlClient } from "./control.ts";
import type { DeviceDialogs } from "./dialogs.ts";
import {
  CEILING_FIELDS,
  ceilingSetArgs,
  failed,
  hereOrNull,
  isKeepAwakeMode,
  isThisDeployment,
  KEEP_AWAKE_MODES,
  type Machine,
  machineStatus,
  parseCeilingRequest,
  readCeiling,
  readKeepAwake,
  readMachine,
  widensField,
} from "./machine.ts";
import type { DeviceService } from "./service.ts";
import type { DeviceTexts } from "./texts.ts";

export interface DeviceCapabilityDeps {
  cli: DeviceCli;
  service: Pick<DeviceService, "ensureService">;
  control: Pick<ControlClient, "running" | "drain" | "subscribe">;
  dialogs: DeviceDialogs;
  /** The device program's own risk texts (texts.ts). */
  texts(): Promise<DeviceTexts>;
  openVerification(target: DeviceTarget, url: string): VerificationWindow;
  log?: (message: string, err?: unknown) => void;
}

type Ctx = DeviceTarget & ConfirmScope;

/** `service status --json`: only the two facts device@1 uses; an unreadable one is "none". */
async function serviceState(cli: DeviceCli): Promise<{ installed: boolean; loaded: boolean }> {
  let state = { installed: false, loaded: false };
  await cli(["service", "status", "--json"], {
    onLine: (line) => {
      if (typeof line !== "object" || line === null) return;
      const s = line as Record<string, unknown>;
      if (typeof s.installed === "boolean") {
        state = { installed: s.installed, loaded: s.loaded === true };
      }
    },
  });
  return state;
}

function toView(op: unknown): RunningOperationView | null {
  if (typeof op !== "object" || op === null) return null;
  const o = op as Record<string, unknown>;
  const nullable = (v: unknown) => v === null || typeof v === "string";
  if (
    typeof o.tag !== "string" ||
    !nullable(o.conversationId) ||
    !nullable(o.accountId) ||
    (o.isolation !== "restricted" && o.isolation !== "full") ||
    typeof o.startedAt !== "string"
  ) {
    return null;
  }
  return {
    tag: o.tag,
    conversationId: o.conversationId as string | null,
    accountId: o.accountId as string | null,
    isolation: o.isolation,
    startedAt: o.startedAt,
  };
}

export function createDeviceCapability(deps: DeviceCapabilityDeps) {
  const { cli, dialogs } = deps;
  const log = deps.log ?? (() => {});

  /** The machine as the profile may see it, with the extra reads only when connected here. */
  async function statusFor(profile: Profile, machine: Machine): Promise<ThisMachineStatus> {
    const here = hereOrNull(machine, profile);
    if (here === null) {
      return machineStatus(profile, machine, { serviceInstalled: false, keepAwakeMode: "off" });
    }
    const [service, keepAwakeMode] = await Promise.all([
      serviceState(cli),
      here.live ? Promise.resolve(here.live.keepAwake.mode) : readKeepAwake(cli),
    ]);
    return machineStatus(profile, machine, { serviceInstalled: service.installed, keepAwakeMode });
  }

  /** The machine, refused unless it is logged in to this profile's deployment. */
  async function connectedHere(profile: Profile) {
    const machine = hereOrNull(await readMachine(cli), profile);
    if (machine === null) throw failed();
    return machine;
  }

  // onStatus: one control subscription for every listener of every profile; each change reads the
  // machine once and gives each listener its own deployment's view, only when it changed.
  const listeners = new Map<
    number,
    { profile: Profile; emit: (s: unknown) => void; last?: string }
  >();
  let nextListener = 1;
  let stopControl: (() => void) | undefined;
  let refreshing = false;
  let again = false;

  async function refresh(): Promise<void> {
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    try {
      do {
        again = false;
        let machine: Machine;
        try {
          machine = await readMachine(cli);
        } catch (err) {
          log("device status could not be read", err);
          continue;
        }
        for (const entry of [...listeners.values()]) {
          let status: ThisMachineStatus;
          try {
            status = await statusFor(entry.profile, machine);
          } catch (err) {
            log("device status could not be read", err);
            continue;
          }
          const text = JSON.stringify(status);
          if (text === entry.last) continue;
          entry.last = text;
          entry.emit(status);
        }
      } while (again && listeners.size > 0);
    } finally {
      refreshing = false;
    }
  }

  function subscribeControl(): void {
    stopControl = deps.control.subscribe(() => {
      void refresh();
    });
  }

  /**
   * After an action changed the machine: read it now, and start the control subscription afresh
   * so a runner that is just starting is found at once rather than after a long retry delay.
   */
  function changed(): void {
    if (listeners.size === 0) return;
    stopControl?.();
    subscribeControl();
    void refresh();
  }

  const connect = createConnect({
    cli,
    service: deps.service,
    dialogs,
    openVerification: deps.openVerification,
    onChanged: changed,
    log,
  });

  const impl = {
    async status(ctx: Ctx): Promise<ThisMachineStatus> {
      return statusFor(ctx.profile, await readMachine(cli));
    },

    async running(ctx: Ctx): Promise<RunningOperationView[]> {
      const machine = await readMachine(cli);
      // Another deployment's operations are never shown.
      if (!isThisDeployment(machine, ctx.profile)) return [];
      const ops = await deps.control.running();
      return ops.map(toView).filter((v): v is RunningOperationView => v !== null);
    },

    connect: (ctx: Ctx, input: unknown) => connect(ctx, input),

    async pause(ctx: Ctx): Promise<void> {
      await connectedHere(ctx.profile);
      try {
        await deps.control.drain();
      } catch (err) {
        log("drain failed", err);
        throw failed();
      } finally {
        changed();
      }
    },

    async resume(ctx: Ctx): Promise<"resumed" | "cancelled"> {
      await connectedHere(ctx.profile);
      if (!(await dialogs.confirmResume(ctx.window, ctx.profile))) return "cancelled";
      try {
        await deps.service.ensureService();
        await run(cli, ["service", "start"]);
      } catch (err) {
        log("the device login service did not start", err);
        throw failed();
      } finally {
        changed();
      }
      return "resumed";
    },

    async disconnect(ctx: Ctx): Promise<void> {
      const machine = await connectedHere(ctx.profile);
      try {
        const service = await serviceState(cli);
        // A loaded service is unloaded (a signalled one would come straight back); a runner
        // started in a terminal gets `stop`.
        if (service.loaded) await run(cli, ["service", "stop"]);
        else if (machine.control !== "absent") await run(cli, ["stop"]);
      } finally {
        changed();
      }
    },

    async requestCeiling(ctx: Ctx, input: unknown): Promise<"applied" | "cancelled"> {
      // Only the fields the page names: the program keeps every other field as it is then, so a
      // stale value on the page can never narrow (or widen) one it did not ask about.
      const req = parseCeilingRequest(input);
      if (req === undefined) throw failed();
      const machine = await connectedHere(ctx.profile);
      const cur = await readCeiling(cli);
      const args = ceilingSetArgs(req);
      const widened = {
        outsideSandbox: widensField(cur, req, "outsideSandbox"),
        network: widensField(cur, req, "network"),
        projectReach: widensField(cur, req, "projectReach"),
      };
      if (!widened.outsideSandbox && !widened.network && !widened.projectReach) {
        if (CEILING_FIELDS.every((f) => req[f] === undefined || req[f] === cur[f])) {
          return "applied";
        }
        // Without --yes: the program decides again under its policy lock, so a widening that
        // landed meanwhile is refused instead of applied unconfirmed.
        await run(cli, args);
        return "applied";
      }
      return ctx.confirm(async () => {
        let texts: DeviceTexts;
        try {
          texts = await deps.texts();
        } catch (err) {
          log("the device program's risk texts are unavailable; no widening", err);
          throw failed();
        }
        // Outside the sandbox a call runs as the owner on an os machine: the program shows its
        // risk text then (login), so the dialog does too.
        const shown = [
          texts.ceilingWidening,
          ...(widened.outsideSandbox && machine.mode !== "docker"
            ? [texts.outsideSandboxRisk]
            : []),
        ];
        if (!(await dialogs.confirmWidenCeiling(ctx.window, widened, shown))) return "cancelled";
        // The ceiling may have narrowed while the dialog was open: --yes must not widen a field
        // the person did not see named.
        const now = await readCeiling(cli);
        if (CEILING_FIELDS.some((f) => widensField(now, req, f) && !widened[f])) throw failed();
        await run(cli, [...args, "--yes"]);
        return "applied";
      });
    },

    async setKeepAwake(ctx: Ctx, mode: unknown): Promise<"applied" | "cancelled"> {
      if (!isKeepAwakeMode(mode)) throw failed();
      await connectedHere(ctx.profile);
      const cur = await readKeepAwake(cli);
      const rank = (m: KeepAwakeMode) => KEEP_AWAKE_MODES.indexOf(m);
      if (rank(mode) <= rank(cur)) {
        if (mode === cur) return "applied";
        // Lowering: no --yes, so a raise that landed meanwhile is refused by the program.
        await run(cli, ["keep-awake", mode]);
        changed();
        return "applied";
      }
      const raised = mode as Exclude<KeepAwakeMode, "off">;
      return ctx.confirm(async () => {
        if (!(await dialogs.confirmRaiseKeepAwake(ctx.window, raised))) return "cancelled";
        // Lowered while the dialog was open: the raise would be larger than the one confirmed.
        if (rank(await readKeepAwake(cli)) < rank(cur)) throw failed();
        await run(cli, ["keep-awake", raised, "--yes"]);
        changed();
        return "applied";
      });
    },
  };

  const events = {
    onStatus(target: DeviceTarget, emit: (status: unknown) => void): () => void {
      const id = nextListener++;
      listeners.set(id, { profile: target.profile, emit });
      // The first listener opens the control subscription, whose first answer reads the
      // machine; a later one reads it now (the others get nothing new: unchanged is not sent).
      if (listeners.size === 1) subscribeControl();
      else void refresh();
      return () => {
        if (!listeners.delete(id)) return;
        if (listeners.size === 0) {
          stopControl?.();
          stopControl = undefined;
        }
      };
    },
  };

  return {
    impl,
    events,
    confirming: ["connect", "resume"],

    /**
     * Before a profile is removed (spec §6.3): when this machine is connected to that deployment,
     * asks whether to disconnect and log the device out too; 「否」 keeps it.
     */
    async beforeRemoveProfile(profile: Profile, parent: unknown): Promise<void> {
      const machine = await readMachine(cli);
      if (!isThisDeployment(machine, profile)) return;
      if (!(await dialogs.confirmRemoveDevice(parent, profile))) return;
      try {
        await stopAndLogout(cli);
      } finally {
        changed();
      }
    },
  };
}

export type DeviceCapability = ReturnType<typeof createDeviceCapability>;
