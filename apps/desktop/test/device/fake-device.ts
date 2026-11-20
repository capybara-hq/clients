// A scripted device CLI and the other device@1 collaborators, for the capability, connect and
// removal tests. Nothing here runs a process, launchctl or the Keychain.
import { vi } from "vitest";
import type { DeviceCli, DeviceCliOptions, DeviceCliResult } from "../../src/main/device/cli.ts";
import type { LiveStatus } from "../../src/main/device/control.ts";
import type { DeviceDialogs } from "../../src/main/device/dialogs.ts";
import type { ServiceStatus } from "../../src/main/device/service.ts";
import type { ConfirmScope } from "../../src/main/ipc.ts";
import type { Profile } from "../../src/main/profiles.ts";

/** A credential value that must never come out of any device@1 function. */
export const SECRET = "cap_dev_SECRET_credential_value";

export const profileA: Profile = {
  id: "pa",
  base: "https://a.example.com/team",
  origin: "https://a.example.com",
  name: "Acme 平台",
};

export const live = (over: Partial<LiveStatus> = {}): LiveStatus => ({
  pid: 41,
  version: "0.1.0-rc.19",
  url: "https://a.example.com/team",
  orgId: "org_1",
  deviceId: "dev_1",
  mode: "os",
  connection: "online",
  since: "2026-11-20T08:00:00.000Z",
  keepAwake: { mode: "while-busy", held: false },
  ...over,
});

/** `status --json` of a machine logged in to `url`, with a credential field slipped in. */
export const loggedIn = (over: Record<string, unknown> = {}) => ({
  loggedIn: true,
  url: "https://a.example.com/team",
  connectUrl: "wss://a.example.com/team/api/v1/devices/connect",
  orgId: "org_1",
  deviceId: "dev_1",
  dir: "/Users/me/capybara-device/dev_1",
  mode: "os",
  reconnectGraceSeconds: 30,
  maxFrameBytes: 16777216,
  sandboxMode: "sandbox",
  control: "ok",
  live: live(),
  // A real `status --json` never prints it; a mapping must not pass on what it does not know.
  credential: SECRET,
  ...over,
});

export interface Scripted {
  code?: number;
  lines?: unknown[];
  stderr?: string;
}

export type Handler = (
  args: string[],
  o: DeviceCliOptions | undefined,
) => Scripted | Promise<Scripted | DeviceCliResult>;

/**
 * Answers by the command (the arguments joined with spaces). `status --json`, `service status
 * --json`, `ceiling show --json` and `keep-awake show --json` have defaults from `state`.
 */
export function fakeCli(
  state: {
    status?: Record<string, unknown>;
    service?: Partial<ServiceStatus>;
    ceiling?: {
      outsideSandbox: boolean;
      network: "open" | "allowlist";
      projectReach: "workspace" | "os-user";
    };
    keepAwake?: "off" | "while-busy" | "connected";
  } = {},
  handlers: Record<string, Handler> = {},
) {
  const calls: { args: string[]; o: DeviceCliOptions | undefined }[] = [];
  const cli: DeviceCli = async (args, o) => {
    calls.push({ args, o });
    const cmd = args.join(" ");
    const h = handlers[cmd];
    let r: Scripted | DeviceCliResult;
    if (h) r = await h(args, o);
    else if (cmd === "status --json") {
      const s = state.status ?? { loggedIn: false };
      r = { code: s.loggedIn ? 0 : 1, lines: [s] };
    } else if (cmd === "service status --json") {
      r = {
        code: 1,
        lines: [
          { installed: false, loaded: false, running: false, binExists: false, ...state.service },
        ],
      };
    } else if (cmd === "ceiling show --json") {
      r = {
        lines: [
          {
            ...(state.ceiling ?? {
              outsideSandbox: false,
              network: "allowlist",
              projectReach: "workspace",
            }),
            allowedDomains: [],
            revision: null,
          },
        ],
      };
    } else if (cmd === "keep-awake show --json") {
      r = { lines: [{ keepAwake: state.keepAwake ?? "while-busy" }] };
    } else r = { code: 0 };
    for (const line of (r as Scripted).lines ?? []) o?.onLine?.(line);
    return { code: r.code ?? 0, stderr: r.stderr ?? "" };
  };
  const commands = () => calls.map((c) => c.args.join(" "));
  /** The commands that change something (not the reads). */
  const writes = () =>
    commands().filter(
      (c) =>
        ![
          "status --json",
          "service status --json",
          "ceiling show --json",
          "keep-awake show --json",
        ].includes(c),
    );
  return { cli, calls, commands, writes };
}

/** Dialogs that answer as told and record what they were asked. */
export function fakeDialogs(answer: boolean | ((name: keyof DeviceDialogs) => boolean) = true) {
  const asked: { name: keyof DeviceDialogs; args: unknown[] }[] = [];
  const reply = (name: keyof DeviceDialogs, args: unknown[]) => {
    asked.push({ name, args });
    return Promise.resolve(typeof answer === "function" ? answer(name) : answer);
  };
  const dialogs: DeviceDialogs = {
    confirmConnect: (...a) => reply("confirmConnect", a),
    confirmDisconnectOther: (...a) => reply("confirmDisconnectOther", a),
    confirmResume: (...a) => reply("confirmResume", a),
    confirmWidenCeiling: (...a) => reply("confirmWidenCeiling", a),
    confirmRaiseKeepAwake: (...a) => reply("confirmRaiseKeepAwake", a),
    confirmRemoveDevice: (...a) => reply("confirmRemoveDevice", a),
  };
  return { dialogs, asked, names: () => asked.map((a) => a.name) };
}

/** A fake service over the same fake CLI (ensureService is what connect calls). */
export function fakeService() {
  return {
    ensureService: vi.fn(async () => "installed" as const),
  };
}

/** The verification window: records the URL; `userCloses` simulates the person closing it. */
export function fakeVerification() {
  const opened: { url: string; parent: unknown }[] = [];
  let onClosed: (() => void) | undefined;
  const close = vi.fn(() => onClosed?.());
  const open = vi.fn((target: { window: unknown }, url: string) => {
    opened.push({ url, parent: target.window });
    return {
      close,
      onClosed(cb: () => void) {
        onClosed = cb;
      },
    };
  });
  return { open, opened, close, userCloses: () => onClosed?.() };
}

/** A context as the bridge passes it: the confirm scope takes and releases a slot. */
export function ctxFor(profile: Profile = profileA, window: unknown = { id: "win" }) {
  const mock = vi.fn((run: () => Promise<unknown>) => run());
  // A mock of a generic method: typed as both, so tests can call and inspect it.
  const confirm = mock as typeof mock & ConfirmScope["confirm"];
  return { profile, window, confirm };
}

/** Whether a value, at any depth, carries the credential. */
export function carriesSecret(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes(SECRET);
}
