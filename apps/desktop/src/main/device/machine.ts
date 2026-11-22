// What this machine is, read from the device program (spec §8: `status --json` and the control
// socket). Every reader keeps only the fields it names, so whatever else a command prints (the
// working directory, the connect URL, and never, but even if, a credential) does not travel on.
import { join } from "node:path";
import type {
  DeviceConnection,
  KeepAwakeMode,
  ThisMachineConnection,
} from "@capybara-hq/plugin-sdk";
import { isRecord, normalizeAddress } from "@capybara-hq/shell";
import type { Profile } from "../profiles.ts";
import type { DeviceCli } from "./cli.ts";
import { isLiveStatus, type LiveStatus } from "./control.ts";

// The device@1 shapes of plugin-sdk 0.1.0-rc.53, which rc.57 replaced with device@2. Kept here
// only so the device@1 wiring compiles until it is replaced (plan Task 13).
/** What this machine is to the deployment the shell shows (device@1). */
export type ThisMachineStatus =
  | { state: "not_connected" }
  | { state: "connected_elsewhere"; origin: string }
  | {
      state: "connected";
      deviceId: string;
      orgId: string;
      mode: "os" | "docker";
      connection: DeviceConnection;
      offlineReason?: string;
      serviceInstalled: boolean;
      keepAwake: { mode: KeepAwakeMode; held: boolean; unavailable?: string };
      lastWakeAt?: string;
    };
/** A device@1 `requestCeiling` input (device policy version 3's project reach). */
export interface DeviceCeilingRequest {
  outsideSandbox?: boolean;
  network?: "open" | "allowlist";
  projectReach?: "workspace" | "os-user";
}

/** Opaque kernel ids: a conservative charset and length, checked before any use. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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

/** One connection of this machine, as `status --json` shows it (only these fields). */
export interface MachineConnection {
  deviceId: string;
  orgId: string;
  orgName: string | null;
  deviceName: string | null;
  /** The deployment address the connection logged in to. */
  url: string;
  host: string;
  mode: "os" | "docker";
  serviceInstalled: boolean;
  /** `<machineDir>/run/<16 hex>.sock`; null when the program gave no path of that form. */
  controlSocket: string | null;
  control: "ok" | "absent" | "unavailable";
  controlReason?: string;
  live: LiveStatus | null;
}

/** The control socket file name the program uses (the first 16 hex of the device id's sha256). */
const SOCKET_NAME = /^[0-9a-f]{16}\.sock$/;

const nullableString = (v: unknown): v is string | null => v === null || typeof v === "string";

/** The `controlSocket` when it is a socket file of `<machineDir>/run/`; null otherwise. */
function checkedSocket(v: unknown, machineDir: string): string | null {
  if (typeof v !== "string") return null;
  const name = v.slice(v.lastIndexOf("/") + 1);
  return SOCKET_NAME.test(name) && v === join(machineDir, "run", name) ? v : null;
}

function parseConnection(v: unknown, machineDir: string): MachineConnection | undefined {
  if (!isRecord(v)) return undefined;
  const { deviceId, orgId, orgName, deviceName, url, host, mode, serviceInstalled } = v;
  // A device id becomes a path segment and a CLI argument: only a safe one is kept.
  if (typeof deviceId !== "string" || !ID_PATTERN.test(deviceId)) return undefined;
  if (typeof orgId !== "string" || typeof url !== "string" || typeof host !== "string") {
    return undefined;
  }
  if (!nullableString(orgName) || !nullableString(deviceName)) return undefined;
  if (mode !== "os" && mode !== "docker") return undefined;
  const { control, controlReason, live } = v;
  if (control !== "ok" && control !== "absent" && control !== "unavailable") return undefined;
  const controlSocket = checkedSocket(v.controlSocket, machineDir);
  const base = {
    deviceId,
    orgId,
    orgName,
    deviceName,
    url,
    host,
    mode,
    serviceInstalled: serviceInstalled === true,
    controlSocket,
  } as const;
  // Without a socket path the app cannot reach the runner: no live status, whatever was printed.
  if (controlSocket === null) {
    return {
      ...base,
      control: "unavailable",
      controlReason:
        control === "unavailable" && typeof controlReason === "string"
          ? controlReason
          : "no usable control socket path",
      live: null,
    };
  }
  return {
    ...base,
    control,
    ...(typeof controlReason === "string" && { controlReason }),
    live: control === "ok" && isLiveStatus(live) ? live : null,
  };
}

/**
 * `status --json`: every readable connection of this machine (exit 1 only means none; the JSON
 * line is the answer). An entry with an unsafe device id or of another shape is dropped.
 * `machineDir` is the program's state directory (`deviceStateDir`), against which each
 * `controlSocket` is checked.
 */
export const readConnections = (cli: DeviceCli, machineDir: string): Promise<MachineConnection[]> =>
  readJson(cli, ["status", "--json"], (v) =>
    isRecord(v) && Array.isArray(v.connections)
      ? v.connections.flatMap((c) => parseConnection(c, machineDir) ?? [])
      : undefined,
  );

/** The connections into this profile's deployment (origins compared). */
export function connectionsHere(all: MachineConnection[], profile: Profile): MachineConnection[] {
  const origin = originOf(profile.origin);
  return origin === null ? [] : all.filter((c) => originOf(c.url) === origin);
}

/**
 * What the page may know of one connection. `keepAwakeMode` is the policy's mode, used when no
 * runner answers.
 */
export function connectionView(
  c: MachineConnection,
  keepAwakeMode: KeepAwakeMode,
): ThisMachineConnection {
  const base = {
    deviceId: c.deviceId,
    orgId: c.orgId,
    mode: c.mode,
    serviceInstalled: c.serviceInstalled,
  };
  const live = c.live;
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
  if (c.control === "unavailable") {
    return {
      ...base,
      connection: "offline",
      offlineReason: (c.controlReason ?? "no live status").slice(0, REASON_MAX),
      keepAwake: { mode: keepAwakeMode, held: false },
    };
  }
  return { ...base, connection: "stopped", keepAwake: { mode: keepAwakeMode, held: false } };
}

/** `keep-awake show -c <deviceId> --json`: the connection policy's mode, runner or not. */
export const readKeepAwake = (cli: DeviceCli, deviceId: string): Promise<KeepAwakeMode> =>
  readJson(cli, ["keep-awake", "show", "-c", deviceId, "--json"], (v) =>
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
export function ceilingSetArgs(deviceId: string, req: DeviceCeilingRequest): string[] {
  return [
    "ceiling",
    "set",
    "-c",
    deviceId,
    ...(req.outsideSandbox !== undefined
      ? ["--outside-sandbox", req.outsideSandbox ? "on" : "off"]
      : []),
    ...(req.network !== undefined ? ["--network", req.network] : []),
    ...(req.projectReach !== undefined ? ["--project-reach", req.projectReach] : []),
  ];
}

/** `ceiling show -c <deviceId> --json`: the connection's owner ceiling now. */
export const readCeiling = (cli: DeviceCli, deviceId: string): Promise<OwnerCeiling> =>
  readJson(cli, ["ceiling", "show", "-c", deviceId, "--json"], (v) =>
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
