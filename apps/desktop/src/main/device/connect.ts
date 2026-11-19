// 「连接本机」 (spec §9.1 – §9.3): a native confirmation, then the device program's own login on
// the bundled Node, whose verification page opens in a child window of the profile's partition
// (the signed-in person confirms there with `org=` preselected), then the login service. The
// program writes its credential to its own file; this module only relays the login's JSON events,
// which never carry it, and answers plain strings.
import type { Profile } from "../profiles.ts";
import type { DeviceCli } from "./cli.ts";
import type { DeviceDialogs } from "./dialogs.ts";
import { failed, isThisDeployment, originOf, readMachine } from "./machine.ts";
import type { DeviceService } from "./service.ts";

/** The calling profile and its window (the parent of every dialog and of the child window). */
export interface DeviceTarget {
  profile: Profile;
  window: unknown;
}

export interface VerificationWindow {
  close(): void;
  /** Called once when the window closes, whoever closed it. */
  onClosed(cb: () => void): void;
}

export interface ConnectDeps {
  cli: DeviceCli;
  service: Pick<DeviceService, "ensureService">;
  dialogs: DeviceDialogs;
  /** Opens `url` in a child window of the profile's partition above `target.window`. */
  openVerification(target: DeviceTarget, url: string): VerificationWindow;
  /** After the machine changed (connected, disconnected): status listeners read it again. */
  onChanged?: () => void;
  log?: (message: string, err?: unknown) => void;
}

/** Opaque kernel ids: a conservative charset and length, checked before any use. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The verification URL the login printed, with `org=<orgId>` set, only when it is on the profile's
 * own origin (a program or a deployment answering with another origin gets no window); else null.
 */
export function verificationUrl(raw: string, profile: Profile, orgId: string): string | null {
  const origin = originOf(raw);
  if (origin === null || origin !== originOf(profile.origin)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  url.searchParams.set("org", orgId);
  return url.href;
}

function parseInput(input: unknown): { orgId: string; deviceId?: string } {
  if (typeof input !== "object" || input === null) throw failed();
  const { orgId, deviceId } = input as Record<string, unknown>;
  if (typeof orgId !== "string" || !ID_PATTERN.test(orgId)) throw failed();
  if (deviceId !== undefined && (typeof deviceId !== "string" || !ID_PATTERN.test(deviceId))) {
    throw failed();
  }
  return { orgId, ...(deviceId !== undefined && { deviceId }) };
}

/** Throws failed unless the device command exited 0. */
export async function run(cli: DeviceCli, args: string[]): Promise<void> {
  const { code } = await cli(args);
  if (code !== 0) throw failed();
}

/**
 * Ends whatever runs for the current login and forgets it on this machine: `service stop` while
 * the login service is loaded (a signalled service would be started again), then `logout`, which
 * also ends a runner started in a terminal. The device stays registered at its deployment.
 */
export async function stopAndLogout(cli: DeviceCli): Promise<void> {
  let loaded = false;
  await cli(["service", "status", "--json"], {
    onLine: (line) => {
      if (typeof line === "object" && line !== null && (line as { loaded?: unknown }).loaded) {
        loaded = true;
      }
    },
  });
  if (loaded) await run(cli, ["service", "stop"]);
  await run(cli, ["logout"]);
}

type LoginOutcome = "done" | "closed" | "denied" | "failed";

export function createConnect(deps: ConnectDeps) {
  const log = deps.log ?? (() => {});
  /** One machine, one login at a time: a connect from any other profile meanwhile is busy. */
  let connecting = false;

  /** Runs `login --json`; the verification page opens in the child window. */
  async function login(target: DeviceTarget, orgId: string): Promise<LoginOutcome> {
    const abort = new AbortController();
    let win: VerificationWindow | undefined;
    let outcome: LoginOutcome | undefined;
    const finish = (o: LoginOutcome) => {
      outcome ??= o;
    };
    const closeWindow = () => {
      const w = win;
      win = undefined;
      w?.close();
    };
    const result = await deps.cli(["login", "--json", "--url", target.profile.base], {
      // A person reads and confirms: no timeout here; the program ends at the code's expiry.
      timeoutMs: 0,
      signal: abort.signal,
      onLine: (line) => {
        if (typeof line !== "object" || line === null) return;
        const ev = line as Record<string, unknown>;
        if (ev.event === "verification" && typeof ev.url === "string" && win === undefined) {
          const url = verificationUrl(ev.url, target.profile, orgId);
          if (url === null) {
            // Never the URL itself: it carries the one-time code.
            log("the device login named a verification page on another origin; stopped");
            finish("failed");
            abort.abort();
            return;
          }
          const opened = deps.openVerification(target, url);
          win = opened;
          opened.onClosed(() => {
            if (win !== opened) return; // closed by this module
            win = undefined;
            finish("closed");
            abort.abort();
          });
        } else if (ev.event === "done") {
          finish("done");
          closeWindow();
        } else if (ev.event === "error") {
          const code = typeof ev.code === "string" ? ev.code : "";
          finish(code === "device_sign_in.denied" ? "denied" : "failed");
          log(`the device login failed (${/^[a-z0-9_.]{1,64}$/.test(code) ? code : "error"})`);
        }
      },
    });
    closeWindow();
    if (outcome === "done" && result.code !== 0) return "failed";
    return outcome ?? "failed";
  }

  return async function connect(
    target: DeviceTarget,
    input: unknown,
  ): Promise<"connected" | "cancelled"> {
    // deviceId is accepted for the contract; the link page takes only org= today (core Task 8).
    const { orgId } = parseInput(input);
    if (connecting) throw { code: "busy" };
    connecting = true;
    try {
      return await connectOnce(target, orgId);
    } finally {
      connecting = false;
    }
  };

  async function connectOnce(
    target: DeviceTarget,
    orgId: string,
  ): Promise<"connected" | "cancelled"> {
    const machine = await readMachine(deps.cli);
    // One runner, one deployment (spec §9.3): already here, nothing to do.
    if (isThisDeployment(machine, target.profile)) return "connected";

    if (!(await deps.dialogs.confirmConnect(target.window, target.profile))) return "cancelled";
    if (machine.loggedIn) {
      const other = originOf(machine.url) ?? machine.url;
      if (!(await deps.dialogs.confirmDisconnectOther(target.window, other))) return "cancelled";
      await stopAndLogout(deps.cli);
      deps.onChanged?.();
    }

    const outcome = await login(target, orgId);
    if (outcome === "closed" || outcome === "denied") return "cancelled";
    if (outcome !== "done") throw failed();

    try {
      await deps.service.ensureService();
      await run(deps.cli, ["service", "start"]);
    } catch (err) {
      log("the device login service did not start", err);
      throw failed();
    } finally {
      deps.onChanged?.();
    }
    return "connected";
  }
}
