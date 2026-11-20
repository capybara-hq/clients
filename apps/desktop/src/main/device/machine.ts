// What this machine is, read from the device program (spec §8: `status --json` and the control
// socket). Every reader keeps only the fields it names, so whatever else a command prints (the
// working directory, the connect URL, and never, but even if, a credential) does not travel on.
import type {
  DeviceCeilingRequest,
  KeepAwakeMode,
  ThisMachineStatus,
} from "@capybara-hq/plugin-sdk";
import { isRecord, normalizeAddress } from "@capybara-hq/shell";
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

/** This machine's owner ceiling, as `ceiling show --json` prints it (device policy version 3). */
export interface OwnerCeiling {
  outsideSandbox: boolean;
  network: "open" | "allowlist";
  projectReach: "workspace" | "os-user";
}

/** The ceiling fields `device@1.requestCeiling` may name. */
export const CEILING_FIELDS = ["outsideSandbox", "network", "projectReach"] as const;
export type CeilingField = (typeof CEILING_FIELDS)[number];

const isNetwork = (v: unknown): v is OwnerCeiling["network"] => v === "open" || v === "allowlist";
const isProjectReach = (v: unknown): v is OwnerCeiling["projectReach"] =>
  v === "workspace" || v === "os-user";

/**
 * A `device@1.requestCeiling` input (`DeviceCeilingRequest`): at least one known field,
 * each with a valid value, and nothing else (an older page's `{ fullAccess, projectReach }` is
 * refused, never half applied); undefined otherwise.
 */
export function parseCeilingRequest(v: unknown): DeviceCeilingRequest | undefined {
  if (!isRecord(v)) return undefined;
  const keys = Object.keys(v);
  if (keys.length === 0) return undefined;
  if (!keys.every((k) => (CEILING_FIELDS as readonly string[]).includes(k))) return undefined;
  const { outsideSandbox, network, projectReach } = v;
  if ("outsideSandbox" in v && typeof outsideSandbox !== "boolean") return undefined;
  if ("network" in v && !isNetwork(network)) return undefined;
  if ("projectReach" in v && !isProjectReach(projectReach)) return undefined;
  return v as DeviceCeilingRequest;
}

/** Whether `next[field]` allows more than `cur[field]` (an absent field changes nothing). */
export function widensField(
  cur: OwnerCeiling,
  next: DeviceCeilingRequest,
  field: CeilingField,
): boolean {
  switch (field) {
    case "outsideSandbox":
      return !cur.outsideSandbox && next.outsideSandbox === true;
    case "network":
      return cur.network === "allowlist" && next.network === "open";
    case "projectReach":
      return cur.projectReach === "workspace" && next.projectReach === "os-user";
  }
}

/** `ceiling set` arguments naming only the requested fields (the program keeps the others). */
export function ceilingSetArgs(req: DeviceCeilingRequest): string[] {
  return [
    "ceiling",
    "set",
    ...(req.outsideSandbox !== undefined
      ? ["--outside-sandbox", req.outsideSandbox ? "on" : "off"]
      : []),
    ...(req.network !== undefined ? ["--network", req.network] : []),
    ...(req.projectReach !== undefined ? ["--project-reach", req.projectReach] : []),
  ];
}

/** `ceiling show --json`: this machine's owner ceiling now; an older program's shape fails. */
export const readCeiling = (cli: DeviceCli): Promise<OwnerCeiling> =>
  readJson(cli, ["ceiling", "show", "--json"], (v) =>
    isRecord(v) &&
    typeof v.outsideSandbox === "boolean" &&
    isNetwork(v.network) &&
    isProjectReach(v.projectReach)
      ? { outsideSandbox: v.outsideSandbox, network: v.network, projectReach: v.projectReach }
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
