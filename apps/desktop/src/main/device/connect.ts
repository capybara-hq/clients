// 「连接本机」 (spec §9.1 – §9.3): a native confirmation, then the device program's own login on
// the bundled Node, whose verification page opens in a child window of the profile's partition
// (the signed-in person confirms there with `org=` preselected), then the new connection's login
// service. A login always adds a connection: every other connection of this machine, into this
// deployment or another, is left as it is. The program writes its credential to its own file;
// this module only relays the login's JSON events, which never carry it, and answers plain data.
import type { Profile } from "../profiles.ts";
import type { DeviceCli } from "./cli.ts";
import type { DeviceDialogs } from "./dialogs.ts";
import { failed, ID_PATTERN, originOf } from "./machine.ts";
import { type DeviceService, DeviceServiceError } from "./service.ts";

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
  /** After the machine changed (a connection added): status listeners read it again. */
  onChanged?: () => void;
  log?: (message: string, err?: unknown) => void;
}

/** What `device@2.connect` answers when the connection could not be made. */
export type ConnectError = "login_failed" | "service_failed" | "app_location";
export type ConnectResult = "connected" | "cancelled" | { error: ConnectError };

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

function parseOrgId(input: unknown): string {
  if (typeof input !== "object" || input === null) throw failed();
  const { orgId } = input as Record<string, unknown>;
  if (typeof orgId !== "string" || !ID_PATTERN.test(orgId)) throw failed();
  return orgId;
}

/** Throws failed unless the device command exited 0. */
export async function run(cli: DeviceCli, args: string[]): Promise<void> {
  const { code } = await cli(args);
  if (code !== 0) throw failed();
}

type LoginOutcome = { kind: "done"; deviceId: string } | { kind: "closed" | "denied" | "failed" };

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
            finish({ kind: "failed" });
            abort.abort();
            return;
          }
          const opened = deps.openVerification(target, url);
          win = opened;
          opened.onClosed(() => {
            if (win !== opened) return; // closed by this module
            win = undefined;
            finish({ kind: "closed" });
            abort.abort();
          });
        } else if (ev.event === "done") {
          // The new connection is named by its device id in every command that follows.
          if (typeof ev.deviceId === "string" && ID_PATTERN.test(ev.deviceId)) {
            finish({ kind: "done", deviceId: ev.deviceId });
          } else {
            log("the device login finished without a usable device id");
            finish({ kind: "failed" });
          }
          closeWindow();
        } else if (ev.event === "error") {
          const code = typeof ev.code === "string" ? ev.code : "";
          finish({ kind: code === "device_sign_in.denied" ? "denied" : "failed" });
          log(`the device login failed (${/^[a-z0-9_.]{1,64}$/.test(code) ? code : "error"})`);
        }
      },
    });
    closeWindow();
    if (outcome?.kind === "done" && result.code !== 0) return { kind: "failed" };
    return outcome ?? { kind: "failed" };
  }

  return async function connect(target: DeviceTarget, input: unknown): Promise<ConnectResult> {
    const orgId = parseOrgId(input);
    if (connecting) throw { code: "busy" };
    connecting = true;
    try {
      return await connectOnce(target, orgId);
    } finally {
      connecting = false;
    }
  };

  async function connectOnce(target: DeviceTarget, orgId: string): Promise<ConnectResult> {
    if (!(await deps.dialogs.confirmConnect(target.window, target.profile))) return "cancelled";

    const outcome = await login(target, orgId);
    if (outcome.kind === "closed" || outcome.kind === "denied") return "cancelled";
    if (outcome.kind !== "done") return { error: "login_failed" };

    const { deviceId } = outcome;
    try {
      await deps.service.ensureService(deviceId);
      await run(deps.cli, ["service", "start", "-c", deviceId]);
    } catch (err) {
      log("the device login service did not start", err);
      return {
        error:
          err instanceof DeviceServiceError && err.code === "app_location"
            ? "app_location"
            : "service_failed",
      };
    } finally {
      deps.onChanged?.();
    }
    return "connected";
  }
}
