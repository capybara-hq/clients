// Runs a `capybara-device` command on the app's own Node and the app's copy of the published
// device package (spec §5.2): `<Resources>/node/node <Resources>/device/bin/capybara-device.mjs`.
// The app binary never acts as Node (§7.2: RunAsNode is fused off). The spawn function and the
// parent environment are injected, so this module tests without Electron or a real process.
import { join } from "node:path";

/** The parts of a child process this module reads. */
export interface ChildLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; stdio: ["ignore", "pipe", "pipe"] },
) => ChildLike;

export interface DeviceCliResult {
  /** The exit code; a process ended by a signal reports 128 + its number (or 1). */
  code: number;
  /** The tail of stderr (the device prints its human lines and errors there with --json). */
  stderr: string;
  /** True when the command outlived its timeout and was killed; `code` is then 124. */
  timedOut?: true;
}

export interface DeviceCliOptions {
  /** Called with each JSON object line of stdout; an exception it throws is logged, not raised. */
  onLine?: (obj: unknown) => void;
  /** Overrides the default timeout for this command (`login --json` waits for a person); 0: none. */
  timeoutMs?: number;
  /** Ends the command (SIGTERM, then SIGKILL after the grace) when it aborts. */
  signal?: AbortSignal;
  /**
   * Replaces inherited variables for this command only (`service install` records PATH in the
   * service file). Names outside {@link INHERITED_ENV} are ignored.
   */
  env?: Partial<Record<InheritedName, string>>;
}

export type DeviceCli = (args: string[], o?: DeviceCliOptions) => Promise<DeviceCliResult>;

/** A device CLI that can also end every command still running (at app quit). */
export type DeviceCliHandle = DeviceCli & { dispose(): void };

/** The exit code reported for a command killed at its timeout (as timeout(1) does). */
export const TIMEOUT_CODE = 124;

export interface DeviceCliDeps {
  /** `process.resourcesPath` in a packaged app; `apps/desktop/build` in a development run. */
  resourcesPath: string;
  spawn: SpawnLike;
  /** The app's own environment; only the names in {@link INHERITED_ENV} are passed on. */
  env: Record<string, string | undefined>;
  /** How long a command may run before SIGTERM (default 60 s; 0: no limit). */
  timeoutMs?: number;
  /** How long after SIGTERM a command still running gets SIGKILL (default 5 s). */
  killGraceMs?: number;
  /** Schedules a timer; answers how to cancel it (tests drive it by hand). */
  schedule?: (fn: () => void, ms: number) => () => void;
  log?: (message: string, err?: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 5000;

function defaultSchedule(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  // A pending kill never keeps the app alive at quit.
  t.unref?.();
  return () => clearTimeout(t);
}

/**
 * What the device program needs from the app's environment: where home and the state directory
 * are, the PATH it looks up tools on (docker), the user and the locale. Nothing Electron set
 * (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, launchd's `XPC_SERVICE_NAME`, which the device reads
 * to tell whether launchd started it) and no other variable of the app reaches the program.
 */
export const INHERITED_ENV = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;

export type InheritedName = (typeof INHERITED_ENV)[number];

/** Most stderr bytes kept for the caller (the tail). */
const STDERR_KEEP = 64 * 1024;
/** A stdout line longer than this is dropped rather than buffered without bound. */
const LINE_MAX = 1024 * 1024;

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

export function devicePaths(resourcesPath: string): { node: string; bin: string } {
  return {
    node: join(resourcesPath, "node", "node"),
    bin: join(resourcesPath, "device", "bin", "capybara-device.mjs"),
  };
}

export function deviceEnv(
  parent: Record<string, string | undefined>,
  override: Partial<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = Object.hasOwn(override, name) ? override[name] : parent[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function asJsonObject(line: string): object | undefined {
  const text = line.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createDeviceCli(deps: DeviceCliDeps): DeviceCliHandle {
  const { node, bin } = devicePaths(deps.resourcesPath);
  const schedule = deps.schedule ?? defaultSchedule;
  const grace = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  /** Every running command: how to end it (SIGTERM, then SIGKILL after the grace). */
  const live = new Set<() => void>();

  const cli: DeviceCli = (args, o) =>
    new Promise<DeviceCliResult>((resolve, reject) => {
      const child = deps.spawn(node, [bin, ...args], {
        env: deviceEnv(deps.env, o?.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let timedOut = false;
      let buf = "";
      let dropping = false;
      let stderr = "";
      const cancels: Array<() => void> = [];
      const terminate = () => {
        child.kill("SIGTERM");
        cancels.push(
          schedule(() => {
            child.kill("SIGKILL");
            // A child that ignores even SIGKILL (or whose close never comes) still settles.
            if (timedOut) settle({ code: TIMEOUT_CODE, stderr, timedOut: true });
          }, grace),
        );
      };
      const onAbort = () => {
        if (!settled) terminate();
      };
      const settle = (result: DeviceCliResult | Error) => {
        if (settled) return;
        settled = true;
        for (const cancel of cancels) cancel();
        live.delete(terminate);
        o?.signal?.removeEventListener("abort", onAbort);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      live.add(terminate);
      if (o?.signal?.aborted) terminate();
      else o?.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = o?.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (timeout > 0) {
        cancels.push(
          schedule(() => {
            if (settled) return;
            timedOut = true;
            deps.log?.(`capybara-device ${args.join(" ")} timed out after ${timeout} ms`);
            terminate();
          }, timeout),
        );
      }
      const emit = (line: string) => {
        const obj = asJsonObject(line);
        if (obj === undefined) return;
        try {
          o?.onLine?.(obj);
        } catch (err) {
          deps.log?.(`a capybara-device ${args[0] ?? ""} line listener failed`, err);
        }
      };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (dropping) dropping = false;
          else emit(line);
        }
        if (buf.length > LINE_MAX) {
          buf = "";
          dropping = true;
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_KEEP);
      });
      child.on("error", (error) => settle(error));
      child.on("close", (code, signal) => {
        if (settled) return;
        // A last line without a newline still counts.
        if (!dropping && buf !== "") emit(buf);
        if (timedOut) return settle({ code: TIMEOUT_CODE, stderr, timedOut: true });
        const exit = code ?? (signal !== null ? 128 + (SIGNALS[signal] ?? 0) : 1);
        settle({ code: exit === 128 ? 1 : exit, stderr });
      });
    });

  return Object.assign(cli, {
    dispose() {
      for (const terminate of [...live]) terminate();
    },
  });
}
