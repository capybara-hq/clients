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
}

export type DeviceCli = (
  args: string[],
  o?: { onLine?: (obj: unknown) => void },
) => Promise<DeviceCliResult>;

export interface DeviceCliDeps {
  /** `process.resourcesPath` in a packaged app; `apps/desktop/build` in a development run. */
  resourcesPath: string;
  spawn: SpawnLike;
  /** The app's own environment; only the names in {@link INHERITED_ENV} are passed on. */
  env: Record<string, string | undefined>;
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

export function deviceEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = parent[name];
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

export function createDeviceCli(deps: DeviceCliDeps): DeviceCli {
  const { node, bin } = devicePaths(deps.resourcesPath);
  return (args, o) =>
    new Promise<DeviceCliResult>((resolve, reject) => {
      const child = deps.spawn(node, [bin, ...args], {
        env: deviceEnv(deps.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let buf = "";
      let dropping = false;
      let stderr = "";
      const emit = (line: string) => {
        const obj = asJsonObject(line);
        if (obj !== undefined) o?.onLine?.(obj);
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
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        // A last line without a newline still counts.
        if (!dropping && buf !== "") emit(buf);
        const exit = code ?? (signal !== null ? 128 + (SIGNALS[signal] ?? 0) : 1);
        resolve({ code: exit === 128 ? 1 : exit, stderr });
      });
    });
}
