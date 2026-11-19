// The client of a running device's control socket (spec §4.2, §9.3): newline-delimited JSON over
// the unix socket `<stateDir>/control.sock` that every `capybara-device start` opens, whoever
// started it (the login service or a terminal). The app attaches through it for the live status,
// the running list and drain. Only the package's types are imported: its runtime entry pulls the
// whole program, which belongs in Resources/device, not in the main-process bundle. The two
// path rules it exports are restated below and pinned against the package in the tests.

import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type {
  ControlEvent,
  ControlRequest,
  ControlResponse,
  LiveStatus,
  RunningOperation,
} from "@capybara-hq/device";

export type { LiveStatus, RunningOperation };

/** The runner answered `ok: false`, or (`no_runner`) nothing answered an op that needs one. */
export class ControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ControlError";
  }
}

/** `<stateDir>/control.sock` (the package's `controlSocketPath`). */
export function controlSocketPath(stateDir: string): string {
  return join(stateDir, "control.sock");
}

/** `$XDG_CONFIG_HOME/capybara-device`, or `~/.config/capybara-device` (the package's `stateDir`). */
export function deviceStateDir(env: Record<string, string | undefined>, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg !== undefined && xdg !== "" ? xdg : join(home, ".config"), "capybara-device");
}

/** The parts of a socket this module uses (node:net's Socket satisfies it). */
export interface SocketLike {
  setEncoding(encoding: "utf8"): unknown;
  write(data: string): unknown;
  destroy(): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  once(event: "connect" | "close", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface ControlClientDeps {
  connect?: (path: string) => SocketLike;
  /** Whether `path` is a socket owned by this user (only such a socket is asked). */
  isOwnSocket?: (path: string) => boolean;
  /** How long one request waits for its answer. */
  timeoutMs?: number;
  /** Schedules a subscription retry; answers how to cancel it. */
  schedule?: (fn: () => void, delayMs: number) => () => void;
}

export interface ControlClient {
  /** The runner's live status; undefined when no runner answers (no socket, refused, timeout). */
  status(): Promise<LiveStatus | undefined>;
  /** What runs now; empty when no runner answers. */
  running(): Promise<RunningOperation[]>;
  /**
   * Calls `cb` with the status now and after every change, and with `undefined` when the runner
   * goes away (then retries with a growing delay until it is back). Answers how to stop.
   */
  subscribe(cb: (status: LiveStatus | undefined) => void): () => void;
  /** Asks the runner to drain (no new operations, exit when the running ones end). */
  drain(): Promise<void>;
}

/** How long one request waits for its answer by default. */
const DEFAULT_TIMEOUT_MS = 2000;
/** The most unanswered bytes kept from one connection (the runner's own write cap). */
const BUFFER_MAX = 1024 * 1024;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

const CONNECTIONS: ReadonlySet<string> = new Set(["starting", "online", "offline", "draining"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A shape check of the runner's status (the same fields `capybara-device status` checks). */
export function isLiveStatus(v: unknown): v is LiveStatus {
  return (
    isObject(v) &&
    typeof v.pid === "number" &&
    typeof v.connection === "string" &&
    CONNECTIONS.has(v.connection) &&
    typeof v.deviceId === "string" &&
    typeof v.since === "string"
  );
}

function isRunningOperation(v: unknown): v is RunningOperation {
  const nullableString = (x: unknown) => x === null || typeof x === "string";
  return (
    isObject(v) &&
    typeof v.tag === "string" &&
    nullableString(v.conversationId) &&
    nullableString(v.accountId) &&
    (v.isolation === "restricted" || v.isolation === "full") &&
    typeof v.startedAt === "string"
  );
}

function defaultIsOwnSocket(path: string): boolean {
  try {
    const st = lstatSync(path);
    const uid = process.getuid?.();
    return st.isSocket() && (uid === undefined || st.uid === uid);
  } catch {
    return false;
  }
}

/**
 * Splits a stream of chunks into lines; a buffer that outgrows {@link BUFFER_MAX} without a
 * newline calls `overflow` instead of growing.
 */
function lineReader(onLine: (msg: unknown) => void, overflow: () => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a malformed frame is skipped
      }
      onLine(msg);
    }
    if (buf.length > BUFFER_MAX) {
      buf = "";
      overflow();
    }
  };
}

type Answer = { ok: true; result: unknown } | { ok: false; code: string; message: string };

export function controlClient(stateDir: string, deps: ControlClientDeps = {}): ControlClient {
  const path = controlSocketPath(stateDir);
  const connect = deps.connect ?? ((p: string) => createConnection(p) as unknown as SocketLike);
  const isOwnSocket = deps.isOwnSocket ?? defaultIsOwnSocket;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });

  /** One request on its own connection; undefined when no runner answers. */
  function request(op: ControlRequest["op"]): Promise<Answer | undefined> {
    if (!isOwnSocket(path)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const sock = connect(path);
      let done = false;
      const finish = (answer: Answer | undefined) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.destroy();
        resolve(answer);
      };
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      sock.setEncoding("utf8");
      sock.once("error", () => finish(undefined));
      sock.once("close", () => finish(undefined));
      sock.once("connect", () => {
        const req: ControlRequest = { id: 1, op };
        sock.write(`${JSON.stringify(req)}\n`);
      });
      sock.on(
        "data",
        lineReader(
          (msg) => {
            // events and answers to other ids are not ours
            if (!isObject(msg) || msg.id !== 1) return;
            const res = msg as ControlResponse;
            if (res.ok === true) return finish({ ok: true, result: res.result });
            const error: Record<string, unknown> = isObject(res.error) ? res.error : {};
            finish({
              ok: false,
              code: typeof error.code === "string" ? error.code : "failed",
              message: typeof error.message === "string" ? error.message : "",
            });
          },
          () => finish(undefined),
        ),
      );
    });
  }

  return {
    async status() {
      const answer = await request("status");
      return answer?.ok && isLiveStatus(answer.result) ? answer.result : undefined;
    },

    async running() {
      const answer = await request("running");
      if (!answer?.ok || !Array.isArray(answer.result)) return [];
      return answer.result.filter(isRunningOperation);
    },

    async drain() {
      const answer = await request("drain");
      if (answer === undefined) {
        throw new ControlError("no_runner", "No capybara-device runner answers on this machine");
      }
      if (!answer.ok) throw new ControlError(answer.code, answer.message);
    },

    subscribe(cb) {
      let stopped = false;
      let sock: SocketLike | undefined;
      let cancelRetry: (() => void) | undefined;
      let delay = RETRY_MIN_MS;
      // undefined is reported once per absence, not on every failed retry
      let last: LiveStatus | undefined | null = null;
      const report = (s: LiveStatus | undefined) => {
        if (stopped || (s === undefined && last === undefined)) return;
        last = s;
        cb(s);
      };
      const retry = () => {
        if (stopped) return;
        report(undefined);
        const wait = delay;
        delay = Math.min(delay * 2, RETRY_MAX_MS);
        cancelRetry = schedule(open, wait);
      };
      function open(): void {
        cancelRetry = undefined;
        if (stopped) return;
        if (!isOwnSocket(path)) {
          retry();
          return;
        }
        const s = connect(path);
        sock = s;
        let ended = false;
        let answered = false;
        const end = () => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          s.destroy();
          if (sock === s) sock = undefined;
          retry();
        };
        const timer = setTimeout(() => {
          if (!answered) end();
        }, timeoutMs);
        s.setEncoding("utf8");
        s.once("error", end);
        s.once("close", end);
        s.once("connect", () => {
          const req: ControlRequest = { id: 1, op: "subscribe" };
          s.write(`${JSON.stringify(req)}\n`);
        });
        s.on(
          "data",
          lineReader((msg) => {
            if (!isObject(msg)) return;
            if (msg.id === 1) {
              answered = true;
              clearTimeout(timer);
              if (msg.ok !== true) return end();
              delay = RETRY_MIN_MS;
              const status = (msg as { result?: unknown }).result;
              report(isLiveStatus(status) ? status : undefined);
              return;
            }
            const event = msg as Partial<ControlEvent>;
            if (event.event === "status" && isLiveStatus(event.status)) report(event.status);
          }, end),
        );
      }
      open();
      return () => {
        stopped = true;
        cancelRetry?.();
        sock?.destroy();
      };
    },
  };
}
