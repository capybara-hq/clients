// `device@2` (spec §8, §9): every function runs here in main through the device CLI and the
// connections' control sockets, and answers plain data of the SDK's shapes, never a credential.
// A window sees and acts on only the connections into its own profile's deployment (origins
// compared): `status` lists only those, and every call naming a device id refuses, before
// anything runs, unless the id is one of them. Every CLI call names its connection with
// `-c <deviceId>`. The confirming calls are `connect` and `resume` (the bridge takes the
// confirmation slot for them) and, decided here from the connection's own state, a widening
// `requestCeiling` and a raising `setKeepAwake` (they take the slot through `ctx.confirm` only
// then); narrowing and lowering apply at once (spec §9.5, §9.7).
import type {
  DeviceCapabilityV2,
  DeviceRunningOp,
  KeepAwakeMode,
  ThisMachineConnection,
} from "@capybara-hq/plugin-sdk";
import { isRecord } from "@capybara-hq/shell";
import type { ConfirmScope } from "../ipc.ts";
import type { Profile } from "../profiles.ts";
import type { DeviceCli } from "./cli.ts";
import {
  type ConnectResult,
  createConnect,
  type DeviceTarget,
  run,
  type VerificationWindow,
} from "./connect.ts";
import type { ConnectionControls } from "./control.ts";
import type { CeilingWidening, DeviceDialogs } from "./dialogs.ts";
import {
  CEILING_FIELDS,
  type CeilingField,
  ceilingSetArgs,
  connectionsHere,
  connectionView,
  failed,
  ID_PATTERN,
  isKeepAwakeMode,
  KEEP_AWAKE_MODES,
  type MachineConnection,
  parseCeilingRequest,
  readCeiling,
  readConnectionCount,
  readKeepAwake,
  widensField,
} from "./machine.ts";
import type { DeviceService } from "./service.ts";
import type { DeviceTexts } from "./texts.ts";

export interface DeviceCapabilityDeps {
  cli: DeviceCli;
  /** Every connection of this machine and each one's control socket (control.ts). */
  controls: ConnectionControls<MachineConnection>;
  service: Pick<DeviceService, "ensureService" | "status">;
  dialogs: DeviceDialogs;
  /** The device program's own risk texts for a connection (texts.ts). */
  texts(deviceId: string): Promise<DeviceTexts>;
  openVerification(target: DeviceTarget, url: string): VerificationWindow;
  log?: (message: string, err?: unknown) => void;
}

type Ctx = DeviceTarget & ConfirmScope;

/**
 * `DeviceCapabilityV2` as main implements it: the bridge's context first, then the page's
 * arguments, unchecked input here, and the SDK's results.
 */
type WithContext<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (ctx: Ctx, ...args: { [I in keyof A]: unknown }) => R
    : never;
};
export type DeviceImpl = WithContext<Omit<DeviceCapabilityV2, "onStatus">>;

function toView(op: unknown): DeviceRunningOp | null {
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

/** The `deviceId` of a page's argument object, when it is a safe id; else undefined. */
function deviceIdOf(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const { deviceId } = input;
  return typeof deviceId === "string" && ID_PATTERN.test(deviceId) ? deviceId : undefined;
}

export function createDeviceCapability(deps: DeviceCapabilityDeps) {
  const { cli, controls, dialogs } = deps;
  const log = deps.log ?? (() => {});

  /** The views of `here` (the connections into one deployment), in the program's order. */
  function viewsOf(here: MachineConnection[]): Promise<ThisMachineConnection[]> {
    return Promise.all(
      here.map(async (c) =>
        // The policy's keep-awake mode is read only when no runner reports it.
        connectionView(c, c.live ? c.live.keepAwake.mode : await readKeepAwake(cli, c.deviceId)),
      ),
    );
  }

  /**
   * The connection `input.deviceId` names, read now, only when it is one into this profile's
   * deployment; refuses (`failed`) otherwise, before anything runs for it. The read also points
   * `controls.forDevice` at the socket it shows.
   */
  async function connectionHere(profile: Profile, input: unknown): Promise<MachineConnection> {
    const deviceId = deviceIdOf(input);
    if (deviceId === undefined) throw failed();
    const all = await controls.read();
    const c = connectionsHere(all, profile).find((x) => x.deviceId === deviceId);
    if (c === undefined) throw failed();
    return c;
  }

  // onStatus: one subscription to every connection for every listener of every profile; each
  // change reads the connections once and tells a listener only when its own deployment's views
  // changed. A listener's first evaluation only records what it has (the page reads `status`).
  const listeners = new Map<number, { profile: Profile; emit: () => void; last?: string }>();
  let nextListener = 1;
  let stopControls: (() => void) | undefined;
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
        let all: MachineConnection[];
        try {
          all = await controls.read();
        } catch (err) {
          log("device status could not be read", err);
          continue;
        }
        for (const entry of [...listeners.values()]) {
          let text: string;
          try {
            text = JSON.stringify(await viewsOf(connectionsHere(all, entry.profile)));
          } catch (err) {
            log("device status could not be read", err);
            continue;
          }
          if (text === entry.last) continue;
          const first = entry.last === undefined;
          entry.last = text;
          if (!first) entry.emit();
        }
      } while (again && listeners.size > 0);
    } finally {
      refreshing = false;
    }
  }

  /** After an action changed a connection: listeners read the connections now. */
  function changed(): void {
    if (listeners.size > 0) void refresh();
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
    async status(ctx: Ctx): Promise<{ connections: ThisMachineConnection[] }> {
      return { connections: await viewsOf(connectionsHere(await controls.read(), ctx.profile)) };
    },

    async running(ctx: Ctx, input: unknown): Promise<DeviceRunningOp[]> {
      const c = await connectionHere(ctx.profile, input);
      const ops = await controls.forDevice(c.deviceId).running();
      return ops.map(toView).filter((v): v is DeviceRunningOp => v !== null);
    },

    connect: (ctx: Ctx, input: unknown): Promise<ConnectResult> => connect(ctx, input),

    async pause(ctx: Ctx, input: unknown): Promise<void> {
      const c = await connectionHere(ctx.profile, input);
      try {
        await controls.forDevice(c.deviceId).drain();
      } catch (err) {
        log("drain failed", err);
        throw failed();
      } finally {
        changed();
      }
    },

    async resume(ctx: Ctx, input: unknown): Promise<"resumed" | "cancelled"> {
      const c = await connectionHere(ctx.profile, input);
      if (!(await dialogs.confirmResume(ctx.window, ctx.profile))) return "cancelled";
      // The dialog can stay open a long time: the connection must still be one of this window's.
      await connectionHere(ctx.profile, input);
      try {
        await deps.service.ensureService(c.deviceId);
        await run(cli, ["service", "start", "-c", c.deviceId]);
      } catch (err) {
        log("the device login service did not start", err);
        throw failed();
      } finally {
        changed();
      }
      return "resumed";
    },

    async disconnect(ctx: Ctx, input: unknown): Promise<void> {
      const c = await connectionHere(ctx.profile, input);
      try {
        let loaded = false;
        try {
          loaded = (await deps.service.status(c.deviceId)).loaded;
        } catch (err) {
          // Unreadable counts as no service: a runner started in a terminal still gets `stop`.
          log("the device login service status could not be read", err);
        }
        // A loaded service is unloaded (a signalled one would come straight back); a runner
        // started in a terminal gets `stop`.
        if (loaded) await run(cli, ["service", "stop", "-c", c.deviceId]);
        else if (c.control !== "absent") await run(cli, ["stop", "-c", c.deviceId]);
      } finally {
        changed();
      }
    },

    async requestCeiling(ctx: Ctx, input: unknown): Promise<"applied" | "cancelled"> {
      // Only the fields the page names: the program keeps every other field as it is then, so a
      // stale value on the page can never narrow (or widen) one it did not ask about.
      if (!isRecord(input)) throw failed();
      const { deviceId: _named, ...fields } = input;
      const req = parseCeilingRequest(fields);
      if (req === undefined) throw failed();
      const c = await connectionHere(ctx.profile, input);
      const cur = await readCeiling(cli, c.deviceId);
      const args = ceilingSetArgs(c.deviceId, req);
      const wider = (f: CeilingField) => widensField(cur, req, f);
      const widened: CeilingWidening = {
        outsideSandbox: wider("outsideSandbox"),
        network: wider("network"),
        projectReach:
          wider("projectReach") &&
          req.projectReach !== undefined &&
          req.projectReach !== "workspace"
            ? req.projectReach
            : false,
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
          texts = await deps.texts(c.deviceId);
        } catch (err) {
          log("the device program's risk texts are unavailable; no widening", err);
          throw failed();
        }
        // What the program itself prints for this widening (`ceiling set`): the other connections'
        // sentence when outside the sandbox turns on beside them. Outside the sandbox a call runs
        // as the owner on an os machine: the program shows its risk text then (login), so here too.
        let others = false;
        if (widened.outsideSandbox) {
          try {
            others = (await readConnectionCount(cli)) > 1;
          } catch {
            others = true; // unknown: shown, as the program does when it cannot list them
          }
        }
        const shown = [
          texts.ceilingWidening,
          ...(others ? [texts.otherConnections] : []),
          ...(widened.outsideSandbox && c.mode !== "docker" ? [texts.outsideSandboxRisk] : []),
        ];
        if (!(await dialogs.confirmWidenCeiling(ctx.window, widened, shown, ctx.profile)))
          return "cancelled";
        await connectionHere(ctx.profile, input);
        // The ceiling may have narrowed while the dialog was open: --yes must not widen a field
        // the person did not see named. Known limit: with --yes the program does not decide again,
        // so a narrowing landing between this read and the write is not caught; closing that needs
        // a precondition the program checks under its lock (an expected revision).
        const now = await readCeiling(cli, c.deviceId);
        if (CEILING_FIELDS.some((f) => widensField(now, req, f) && !wider(f))) throw failed();
        await run(cli, [...args, "--yes"]);
        return "applied";
      });
    },

    async setKeepAwake(ctx: Ctx, input: unknown): Promise<"applied" | "cancelled"> {
      const mode = isRecord(input) ? input.mode : undefined;
      if (!isKeepAwakeMode(mode)) throw failed();
      const c = await connectionHere(ctx.profile, input);
      const cur = await readKeepAwake(cli, c.deviceId);
      const rank = (m: KeepAwakeMode) => KEEP_AWAKE_MODES.indexOf(m);
      if (rank(mode) <= rank(cur)) {
        if (mode === cur) return "applied";
        // Lowering: no --yes, so a raise that landed meanwhile is refused by the program.
        await run(cli, ["keep-awake", mode, "-c", c.deviceId]);
        changed();
        return "applied";
      }
      const raised = mode as Exclude<KeepAwakeMode, "off">;
      return ctx.confirm(async () => {
        if (!(await dialogs.confirmRaiseKeepAwake(ctx.window, raised, ctx.profile)))
          return "cancelled";
        await connectionHere(ctx.profile, input);
        // Lowered while the dialog was open: the raise would be larger than the one confirmed.
        if (rank(await readKeepAwake(cli, c.deviceId)) < rank(cur)) throw failed();
        await run(cli, ["keep-awake", raised, "-c", c.deviceId, "--yes"]);
        changed();
        return "applied";
      });
    },
  } satisfies DeviceImpl;

  const events = {
    /** Fires, with no payload, when this profile's own connections changed: read `status`. */
    onStatus(target: DeviceTarget, emit: (payload?: unknown) => void): () => void {
      const id = nextListener++;
      listeners.set(id, { profile: target.profile, emit: () => emit() });
      if (listeners.size === 1) {
        stopControls = controls.subscribeAll(() => {
          void refresh();
        });
      }
      // Records what this listener has now; a change after that is sent.
      void refresh();
      return () => {
        if (!listeners.delete(id)) return;
        if (listeners.size === 0) {
          stopControls?.();
          stopControls = undefined;
        }
      };
    },
  };

  return {
    impl,
    events,
    confirming: ["connect", "resume"],

    /**
     * Before a profile is removed (spec §6.3): when this machine has connections into that
     * deployment, asks once whether to disconnect them and log them out too; 「否」 keeps them.
     * `logout -c` removes each one's login service (which stops it); one that fails is logged
     * and the others still go. Connections into other deployments are never touched.
     */
    async beforeRemoveProfile(profile: Profile, parent: unknown): Promise<void> {
      const here = connectionsHere(await controls.read(), profile);
      if (here.length === 0) return;
      if (!(await dialogs.confirmRemoveDevice(parent, profile, here.length))) return;
      try {
        // The dialog can stay open a long time: log out only what is still a connection here.
        const ids = new Set(connectionsHere(await controls.read(), profile).map((c) => c.deviceId));
        for (const c of here) {
          if (!ids.has(c.deviceId)) continue;
          try {
            await run(cli, ["logout", "-c", c.deviceId]);
          } catch (err) {
            log("a device connection could not be logged out", err);
          }
        }
      } finally {
        changed();
      }
    },
  };
}

export type DeviceCapability = ReturnType<typeof createDeviceCapability>;
