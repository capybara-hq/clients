// What this machine is, read from the device program (spec §8: `status --json` and the control
// socket). Every reader keeps only the fields it names, so whatever else a command prints (the
// working directory, the connect URL, and never, but even if, a credential) does not travel on.
import type { KeepAwakeMode, ThisMachineStatus } from "@capybara-hq/plugin-sdk";
import { normalizeAddress } from "@capybara-hq/shell";
import type { Profile } from "../profiles.ts";
import type { DeviceCli } from "./cli.ts";
import { isLiveStatus, type LiveStatus } from "./control.ts";

/** A refusal the bridge passes to the page as `{ code }` (only ShellCallError codes survive). */
export const failed = (): { code: "failed" } => ({ code: "failed" });

export type Machine =
  | { loggedIn: false }
  | {
      loggedIn: true;
      /** The deployment address the device logged in to (base, no trailing slash). */
      url: string;
      orgId: string;
      deviceId: string;
      mode: "os" | "docker";
      control: "ok" | "absent" | "unavailable";
      controlReason?: string;
      live: LiveStatus | null;
    };

export const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ["off", "while-busy", "connected"];

export const isKeepAwakeMode = (v: unknown): v is KeepAwakeMode =>
  KEEP_AWAKE_MODES.includes(v as KeepAwakeMode);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Runs a read command and answers its first JSON line `parse` accepts; throws failed otherwise. */
async function readJson<T>(
  cli: DeviceCli,
  args: string[],
  parse: (v: unknown) => T | undefined,
): Promise<T> {
  let out: T | undefined;
  await cli(args, {
    onLine: (line) => {
      out ??= parse(line);
    },
  });
  if (out === undefined) throw failed();
  return out;
}

function parseMachine(v: unknown): Machine | undefined {
  if (!isRecord(v)) return undefined;
  if (v.loggedIn === false) return { loggedIn: false };
  if (v.loggedIn !== true) return undefined;
  const { url, orgId, deviceId, mode, control, controlReason, live } = v;
  if (typeof url !== "string" || typeof orgId !== "string" || typeof deviceId !== "string") {
    return undefined;
  }
  if (mode !== "os" && mode !== "docker") return undefined;
  if (control !== "ok" && control !== "absent" && control !== "unavailable") return undefined;
  return {
    loggedIn: true,
    url,
    orgId,
    deviceId,
    mode,
    control,
    ...(typeof controlReason === "string" && { controlReason }),
    live: control === "ok" && isLiveStatus(live) ? live : null,
  };
}

/** `status --json` (exit 1 only means "not logged in"; the JSON line is the answer). */
export const readMachine = (cli: DeviceCli): Promise<Machine> =>
  readJson(cli, ["status", "--json"], parseMachine);

/** `keep-awake show --json`: the policy's mode, whether or not a runner lives. */
export const readKeepAwake = (cli: DeviceCli): Promise<KeepAwakeMode> =>
  readJson(cli, ["keep-awake", "show", "--json"], (v) =>
    isRecord(v) && isKeepAwakeMode(v.keepAwake) ? v.keepAwake : undefined,
  );

export interface OwnerCeiling {
  fullAccess: boolean;
  projectReach: "workspace" | "os-user";
}

export const isProjectReach = (v: unknown): v is OwnerCeiling["projectReach"] =>
  v === "workspace" || v === "os-user";

/** `ceiling show --json`: this machine's owner ceiling now. */
export const readCeiling = (cli: DeviceCli): Promise<OwnerCeiling> =>
  readJson(cli, ["ceiling", "show", "--json"], (v) =>
    isRecord(v) && typeof v.fullAccess === "boolean" && isProjectReach(v.projectReach)
      ? { fullAccess: v.fullAccess, projectReach: v.projectReach }
      : undefined,
  );

/** The origin of a deployment address, through the same normalization as the profiles. */
export function originOf(url: string): string | null {
  const n = normalizeAddress(url);
  return n.ok ? n.origin : null;
}

export type LoggedInMachine = Extract<Machine, { loggedIn: true }>;

/** The machine when it is logged in to this profile's deployment (origins compared), else null. */
export function hereOrNull(machine: Machine, profile: Profile): LoggedInMachine | null {
  return machine.loggedIn && originOf(machine.url) === originOf(profile.origin) ? machine : null;
}

/** Whether the machine is logged in to this profile's deployment. */
export const isThisDeployment = (machine: Machine, profile: Profile): boolean =>
  hereOrNull(machine, profile) !== null;

/** The longest offline reason passed to the page. */
const REASON_MAX = 300;

/**
 * Maps the machine to what the profile's page may know of it: another deployment is only its
 * origin. `extra` is read only when connected here: whether the login service is installed and
 * the policy's keep-awake mode (used when no runner answers).
 */
export function machineStatus(
  profile: Profile,
  machine: Machine,
  extra: { serviceInstalled: boolean; keepAwakeMode: KeepAwakeMode },
): ThisMachineStatus {
  if (!machine.loggedIn) return { state: "not_connected" };
  if (hereOrNull(machine, profile) === null) {
    const origin = originOf(machine.url);
    // An address the device accepted but the shell cannot read is still another deployment.
    return origin === null ? { state: "not_connected" } : { state: "connected_elsewhere", origin };
  }
  const { serviceInstalled, keepAwakeMode } = extra;
  const live = machine.live;
  const base = {
    state: "connected" as const,
    deviceId: machine.deviceId,
    orgId: machine.orgId,
    mode: machine.mode,
    serviceInstalled,
  };
  if (live) {
    return {
      ...base,
      connection: live.connection,
      ...(live.offlineReason !== undefined && {
        offlineReason: String(live.offlineReason).slice(0, REASON_MAX),
      }),
      keepAwake: {
        mode: live.keepAwake.mode,
        held: live.keepAwake.held === true,
        ...(typeof live.keepAwake.unavailable === "string" && {
          unavailable: live.keepAwake.unavailable.slice(0, REASON_MAX),
        }),
      },
      ...(typeof live.lastWakeAt === "string" && { lastWakeAt: live.lastWakeAt }),
    };
  }
  // A program runs but gives no live status: offline with the program's reason, never "stopped".
  if (machine.control === "unavailable") {
    return {
      ...base,
      connection: "offline",
      offlineReason: (machine.controlReason ?? "no live status").slice(0, REASON_MAX),
      keepAwake: { mode: keepAwakeMode, held: false },
    };
  }
  return { ...base, connection: "stopped", keepAwake: { mode: keepAwakeMode, held: false } };
}
