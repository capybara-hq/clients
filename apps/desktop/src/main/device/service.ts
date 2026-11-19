// The device as the login service (spec §5.2, §9.3, §9.4): the app never hosts the runner; it
// installs the published program's own launchd agent (`capybara-device service install`, which
// records the Node running it and the package's bin, so the plist points at the app's copies),
// repairs it when the app moved, and restarts it after an update changed the bundled device.
// Everything goes through the injected device CLI: tests use a fake one, never launchctl.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type DeviceCli, devicePaths } from "./cli.ts";

/** `capybara-device service status --json` (device `commands/service.js` statusJson). */
export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  pid?: number;
  /** The version the running program reported in its pid file. */
  runningVersion?: string;
  /** The version of the package at `binPath`: what a restart would run. */
  installedVersion?: string;
  nodePath?: string;
  binPath?: string;
  /** False when the service file's bin path is gone (the app that installed it moved). */
  binExists: boolean;
}

/** A refusal with a stable code: `app_location` (the app runs from a temporary place). */
export class DeviceServiceError extends Error {
  readonly code: "app_location" | "status_unreadable" | "command_failed";
  constructor(code: DeviceServiceError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "DeviceServiceError";
  }
}

export interface DeviceServiceDeps {
  cli: DeviceCli;
  /** The Resources directory holding node/ and device/ (see cli.ts). */
  resourcesPath: string;
  /** Resolves symlinks for path comparison; a missing path compares as written. */
  realpath?: (path: string) => string;
  /** The app's environment: its PATH is the base of the PATH the service file records. */
  env?: Record<string, string | undefined>;
}

/** Where docker usually lives on a Mac: Homebrew (Intel and Apple silicon) and Docker Desktop. */
export const DOCKER_PATHS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/Applications/Docker.app/Contents/Resources/bin",
] as const;

/** launchd's own PATH, what an app started from the Finder inherits. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * The PATH for `service install`, which records the installing process's PATH in the service file
 * (device `serviceEnv`): the inherited one, then each usual docker location it lacks. An app
 * started from the Finder has launchd's short PATH, which would leave a docker-mode device
 * unable to find docker.
 */
export function withDockerPath(path: string | undefined): string {
  const parts = (path ?? "").split(":").filter((p) => p !== "");
  const out = parts.length > 0 ? parts : LAUNCHD_PATH.split(":");
  for (const extra of DOCKER_PATHS) if (!out.includes(extra)) out.push(extra);
  return [...new Set(out)].join(":");
}

export interface DeviceService {
  status(): Promise<ServiceStatus>;
  /**
   * Makes the login service run this app's copy, unless the person installed one with the CLI:
   * `installed` (there was none), `kept` (this app's, another app copy's or a CLI-installed one
   * whose bin still exists), `reinstalled` (its bin is gone, or this app's bin runs another Node).
   */
  ensureService(): Promise<"installed" | "kept" | "reinstalled">;
  /**
   * At start: repairs an installed, loaded service whose app moved, like {@link ensureService},
   * but never installs one (connecting does) and never starts one that is not loaded (paused).
   */
  repairService(): Promise<"absent" | "kept" | "reinstalled">;
  /**
   * `service restart` when the service runs this app's copy and the program running is not the
   * version now on disk (an update replaced the bundled device). Never starts a stopped service.
   */
  afterUpdate(): Promise<void>;
}

const APP_COPY = /\.app\/Contents\/Resources\/device\/bin\/capybara-device\.mjs$/;

function parseStatus(v: unknown): ServiceStatus | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (
    typeof o.installed !== "boolean" ||
    typeof o.loaded !== "boolean" ||
    typeof o.running !== "boolean" ||
    typeof o.binExists !== "boolean"
  ) {
    return undefined;
  }
  const str = (k: string) => (typeof o[k] === "string" ? { [k]: o[k] as string } : {});
  return {
    installed: o.installed,
    loaded: o.loaded,
    running: o.running,
    binExists: o.binExists,
    ...(typeof o.pid === "number" && { pid: o.pid }),
    ...str("runningVersion"),
    ...str("installedVersion"),
    ...str("nodePath"),
    ...str("binPath"),
  };
}

/**
 * A copy that would vanish: an app Gatekeeper translocated (run from Downloads before it was
 * moved) or one run from a mounted disk image. A service pointing there breaks at the next
 * reboot, so none is installed from such a place.
 */
export function isTemporaryLocation(resourcesPath: string): boolean {
  return resourcesPath.includes("/AppTranslocation/") || resourcesPath.startsWith("/Volumes/");
}

export function createDeviceService(deps: DeviceServiceDeps): DeviceService {
  const own = devicePaths(deps.resourcesPath);
  const real = (p: string): string => {
    try {
      return (deps.realpath ?? realpathSync)(p);
    } catch {
      return resolve(p);
    }
  };
  const same = (a: string | undefined, b: string) => a !== undefined && real(a) === real(b);

  async function status(): Promise<ServiceStatus> {
    let parsed: ServiceStatus | undefined;
    const { stderr } = await deps.cli(["service", "status", "--json"], {
      onLine: (obj) => {
        parsed ??= parseStatus(obj);
      },
    });
    // Exit code 1 only means "not running"; the JSON line is the answer.
    if (parsed === undefined) {
      throw new DeviceServiceError(
        "status_unreadable",
        `capybara-device service status --json gave no status${stderr ? `: ${stderr.trim()}` : ""}`,
      );
    }
    return parsed;
  }

  async function run(args: string[], env?: { PATH: string }): Promise<void> {
    const { code, stderr } = await deps.cli(args, env ? { env } : undefined);
    if (code !== 0) {
      throw new DeviceServiceError(
        "command_failed",
        `capybara-device ${args.join(" ")} failed (exit ${code})${stderr ? `: ${stderr.trim()}` : ""}`,
      );
    }
  }

  function install(): Promise<void> {
    if (isTemporaryLocation(deps.resourcesPath)) {
      return Promise.reject(
        new DeviceServiceError(
          "app_location",
          `the app runs from a temporary location (${deps.resourcesPath}); move it to Applications first`,
        ),
      );
    }
    return run(["service", "install"], { PATH: withDockerPath(deps.env?.PATH) });
  }

  /**
   * Whether an installed service must be replaced by this app's copy: its bin is gone (the app or
   * the CLI install that wrote it was moved or removed), or it is this app's bin on another Node.
   * Another app bundle's copy whose bin still exists is kept, so two copies of the app never take
   * the service back and forth; a CLI-installed one is kept too (spec §5.2: used as is).
   */
  function needsReinstall(s: ServiceStatus): boolean {
    if (!s.binExists) return true;
    if (same(s.binPath, own.bin)) return !same(s.nodePath, own.node);
    return false;
  }

  /** A copy some app bundle installed (this one or another), as opposed to the CLI's. */
  const isAppCopy = (s: ServiceStatus): boolean =>
    s.binPath !== undefined && (same(s.binPath, own.bin) || APP_COPY.test(s.binPath));

  async function ensureService(): Promise<"installed" | "kept" | "reinstalled"> {
    const s = await status();
    if (!s.installed) {
      await install();
      return "installed";
    }
    if (!needsReinstall(s)) return "kept";
    await install();
    return "reinstalled";
  }

  return {
    status,
    ensureService,

    async repairService() {
      const s = await status();
      if (!s.installed) return "absent";
      // Only an app copy is repaired at start; a broken CLI-installed service waits for the
      // person to switch it to the app's copy (through ensureService; the UI for that is
      // capybara-hq/clients#13).
      if (!s.loaded || !isAppCopy(s) || !needsReinstall(s)) return "kept";
      // Not from a temporary location: the next start from the real place repairs it.
      if (isTemporaryLocation(deps.resourcesPath)) return "kept";
      await install();
      return "reinstalled";
    },

    async afterUpdate() {
      const s = await status();
      if (!s.installed || !s.running || !same(s.binPath, own.bin)) return;
      if (s.runningVersion === undefined || s.installedVersion === undefined) return;
      // Only a new device version restarts: an update that changes only the bundled Node keeps
      // the running program on the old Node until its next start (accepted).
      if (s.runningVersion === s.installedVersion) return;
      await run(["service", "restart"]);
    },
  };
}
