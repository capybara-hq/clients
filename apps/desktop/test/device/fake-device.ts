// A scripted device CLI and the other device@2 collaborators, for the capability, connect and
// removal tests. Nothing here runs a process, launchctl or the Keychain.
import { vi } from "vitest";
import type { DeviceCli, DeviceCliOptions, DeviceCliResult } from "../../src/main/device/cli.ts";
import type {
  ConnectionControls,
  ControlClient,
  LiveStatus,
  RunningOperation,
} from "../../src/main/device/control.ts";
import type { DeviceDialogs } from "../../src/main/device/dialogs.ts";
import { type MachineConnection, readConnections } from "../../src/main/device/machine.ts";
import type { ServiceStatus } from "../../src/main/device/service.ts";
import type { ConfirmScope } from "../../src/main/ipc.ts";
import type { Profile } from "../../src/main/profiles.ts";

/** A credential value that must never come out of any device@2 function. */
export const SECRET = "cap_dev_SECRET_credential_value";

export const profileA: Profile = {
  id: "pa",
  signedIn: true,
  base: "https://a.example.com/team",
  origin: "https://a.example.com",
  name: "Acme 平台",
};

export const profileB: Profile = {
  id: "pb",
  signedIn: true,
  base: "https://b.example.com",
  origin: "https://b.example.com",
  name: "Beta",
};

export const live = (over: Partial<LiveStatus> = {}): LiveStatus => ({
  pid: 41,
  version: "0.1.0-rc.30",
  url: "https://a.example.com/team",
  orgId: "org_1",
  deviceId: "dev_1",
  mode: "os",
  connection: "online",
  since: "2026-11-20T08:00:00.000Z",
  keepAwake: { mode: "while-busy", held: false },
  ...over,
});

/** The device program's state directory in these tests. */
export const MACHINE_DIR = "/m/capybara-device";

/**
 * One connection as `status --json` prints it (device rc.29 `ConnectionStatusJson`), with fields
 * the readers must not pass on, a credential among them.
 */
export const connectionJson = (deviceId: string, over: Record<string, unknown> = {}) => ({
  deviceId,
  orgId: "org_1",
  orgName: "Acme",
  deviceName: `${deviceId}-laptop`,
  url: "https://a.example.com/team",
  host: "a.example.com",
  mode: "os",
  dir: `/Users/me/capybara-device/${deviceId}`,
  serviceInstalled: true,
  // 16 hex derived from the id, only so that each connection has its own socket in the tests
  controlSocket: `${MACHINE_DIR}/run/${Buffer.from(deviceId).toString("hex").padEnd(16, "0").slice(0, 16)}.sock`,
  control: "ok",
  live: live({ deviceId, url: (over.url as string | undefined) ?? "https://a.example.com/team" }),
  credential: SECRET,
  ...over,
});

/**
 * `status --json` of a machine with two connections into A (`https://a.example.com/team`) and one
 * into B (`https://b.example.com`).
 */
export const threeConnections = (
  over: Partial<Record<"dev_a1" | "dev_a2" | "dev_b1", Record<string, unknown>>> = {},
) => ({
  connections: [
    connectionJson("dev_a1", over.dev_a1),
    connectionJson("dev_a2", { orgId: "org_2", ...over.dev_a2 }),
    connectionJson("dev_b1", {
      orgId: "org_b",
      url: "https://b.example.com",
      host: "b.example.com",
      ...over.dev_b1,
    }),
  ],
  unreadable: [],
});

/**
 * `status --json` of a machine logged in to `url` (the old single-connection shape, which no
 * reader accepts now).
 */
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

/** The reads every connection answers by default (any device id). */
const READS = [
  /^status --json$/,
  /^service status -c \S+ --json$/,
  /^ceiling show -c \S+ --json$/,
  /^keep-awake show -c \S+ --json$/,
];

type Ceiling = {
  outsideSandbox: boolean;
  network: "open" | "allowlist";
  projectReach: "machine" | "paths" | "workspace";
};

/**
 * Answers by the command (the arguments joined with spaces). `status --json`, `service status -c
 * <id> --json`, `ceiling show -c <id> --json` and `keep-awake show -c <id> --json` have defaults
 * from `state` (the same for every connection).
 */
export function fakeCli(
  state: {
    status?: Record<string, unknown>;
    service?: Partial<ServiceStatus>;
    ceiling?: Ceiling;
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
      const s = state.status ?? { connections: [], unreadable: [] };
      r = { code: s.loggedIn === false ? 1 : 0, lines: [s] };
    } else if (READS[1]?.test(cmd)) {
      r = {
        code: 1,
        lines: [
          { installed: false, loaded: false, running: false, binExists: false, ...state.service },
        ],
      };
    } else if (READS[2]?.test(cmd)) {
      r = {
        lines: [
          {
            ...(state.ceiling ?? {
              outsideSandbox: false,
              network: "allowlist",
              projectReach: "workspace",
            }),
            allowedDomains: [],
            projectPaths: [],
            revision: null,
          },
        ],
      };
    } else if (READS[3]?.test(cmd)) {
      r = { lines: [{ keepAwake: state.keepAwake ?? "while-busy" }] };
    } else r = { code: 0 };
    for (const line of (r as Scripted).lines ?? []) o?.onLine?.(line);
    return { code: r.code ?? 0, stderr: r.stderr ?? "" };
  };
  const commands = () => calls.map((c) => c.args.join(" "));
  /** The commands that change something (not the reads). */
  const writes = () => commands().filter((c) => !READS.some((re) => re.test(c)));
  return { cli, calls, commands, writes };
}

/** A control client of one connection whose answers the test sets. */
export function fakeControlClient(running: unknown[] = []) {
  const subscribers: ((s: LiveStatus | undefined) => void)[] = [];
  return {
    status: vi.fn(async (): Promise<LiveStatus | undefined> => undefined),
    running: vi.fn(async () => running as RunningOperation[]),
    drain: vi.fn(async () => undefined),
    subscribe: vi.fn((cb: (s: LiveStatus | undefined) => void) => {
      subscribers.push(cb);
      return () => {};
    }),
    subscribers,
  } satisfies ControlClient & { subscribers: unknown[] };
}

/**
 * Connection controls over the fake CLI: `read` parses its `status --json` with the real reader;
 * `forDevice` hands each device id its own fake client (created on first use); `subscribeAll`
 * records its callbacks (`changed()` calls them, like a runner event or a rescan would).
 */
export function fakeControls(cli: DeviceCli, o: { running?: unknown[] } = {}) {
  const clients = new Map<string, ReturnType<typeof fakeControlClient>>();
  const callbacks: (() => void)[] = [];
  const unsubscribe = vi.fn();
  const client = (id: string) => {
    let c = clients.get(id);
    if (c === undefined) {
      c = fakeControlClient(o.running ?? []);
      clients.set(id, c);
    }
    return c;
  };
  const controls = {
    read: vi.fn(() => readConnections(cli, MACHINE_DIR)),
    forDevice: vi.fn((id: string) => client(id)),
    subscribeAll: vi.fn((cb: () => void) => {
      callbacks.push(cb);
      return unsubscribe;
    }),
  } satisfies ConnectionControls<MachineConnection>;
  return {
    controls,
    client,
    clients,
    unsubscribe,
    changed: () => {
      for (const cb of callbacks) cb();
    },
  };
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
    confirmResume: (...a) => reply("confirmResume", a),
    confirmWidenCeiling: (...a) => reply("confirmWidenCeiling", a),
    confirmRaiseKeepAwake: (...a) => reply("confirmRaiseKeepAwake", a),
    confirmRemoveDevice: (...a) => reply("confirmRemoveDevice", a),
  };
  return { dialogs, asked, names: () => asked.map((a) => a.name) };
}

/** A fake login service: `ensureService` (connect, resume) and `status` (disconnect). */
export function fakeService(status: Partial<ServiceStatus> = {}) {
  return {
    ensureService: vi.fn(async (_deviceId: string) => "installed" as const),
    status: vi.fn(
      async (_deviceId: string): Promise<ServiceStatus> => ({
        installed: false,
        loaded: false,
        running: false,
        binExists: false,
        ...status,
      }),
    ),
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
