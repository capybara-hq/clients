import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateDir as packageStateDir } from "@capybara-hq/device";
import { afterEach, expect, test } from "vitest";
import {
  type ConnectionSocket,
  ControlError,
  controlClient,
  createConnectionControls,
  deviceStateDir,
  RESCAN_MS,
} from "../../src/main/device/control.ts";

const LIVE = {
  pid: 42,
  version: "0.1.0-rc.18",
  url: "https://capy.example",
  orgId: "o1",
  deviceId: "d1",
  mode: "os",
  connection: "online",
  since: "2026-11-19T10:00:00.000Z",
  keepAwake: { mode: "while-busy", held: false },
};

const OP = {
  tag: "t1",
  conversationId: "c1",
  accountId: null,
  isolation: "restricted",
  startedAt: "2026-11-19T10:01:00.000Z",
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A socket path in a fresh directory (short: a unix socket path holds at most 103 bytes). */
function tempSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "cdc-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "0123456789abcdef.sock");
}

/** A runner stand-in listening on `path`: `onLine` answers each request line on its socket. */
async function runner(
  path: string,
  onLine: (req: { id: number; op: string }, sock: Socket) => void,
): Promise<{ server: Server; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(JSON.parse(line), sock);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return { server, sockets };
}

const answer = (sock: Socket, line: unknown) => sock.write(`${JSON.stringify(line)}\n`);

test("the state directory matches the device package", () => {
  const env = { XDG_CONFIG_HOME: "/x" };
  expect(deviceStateDir(env, "/h")).toBe(packageStateDir(env, "/h"));
  expect(deviceStateDir({}, "/h")).toBe(packageStateDir({}, "/h"));
  expect(deviceStateDir({ XDG_CONFIG_HOME: "" }, "/h")).toBe(
    packageStateDir({ XDG_CONFIG_HOME: "" }, "/h"),
  );
});

test("status is undefined when no socket exists", async () => {
  const c = controlClient(tempSocket());
  await expect(c.status()).resolves.toBeUndefined();
  await expect(c.running()).resolves.toEqual([]);
});

test("status is undefined when the path is a plain file, not a socket", async () => {
  const path = tempSocket();
  writeFileSync(path, "x");
  await expect(controlClient(path).status()).resolves.toBeUndefined();
});

test("status asks the runner with a JSON line and answers its LiveStatus", async () => {
  const path = tempSocket();
  const seen: unknown[] = [];
  await runner(path, (req, sock) => {
    seen.push(req);
    answer(sock, { id: req.id, ok: true, result: LIVE });
  });
  await expect(controlClient(path).status()).resolves.toEqual(LIVE);
  expect(seen).toEqual([{ id: 1, op: "status" }]);
});

test("malformed frames and answers to other ids are skipped", async () => {
  const path = tempSocket();
  await runner(path, (req, sock) => {
    sock.write("garbage{\n");
    answer(sock, { event: "status", status: LIVE });
    answer(sock, { id: 99, ok: true, result: { other: true } });
    answer(sock, { id: req.id, ok: true, result: [OP, { tag: 5 }] });
  });
  await expect(controlClient(path).running()).resolves.toEqual([OP]);
});

test("an answer of the wrong shape is no status", async () => {
  const path = tempSocket();
  await runner(path, (req, sock) => answer(sock, { id: req.id, ok: true, result: { pid: "x" } }));
  await expect(controlClient(path).status()).resolves.toBeUndefined();
});

test("a runner that never answers times out to undefined", async () => {
  const path = tempSocket();
  await runner(path, () => {});
  await expect(controlClient(path, { timeoutMs: 20 }).status()).resolves.toBeUndefined();
});

test("an over-long line ends the request without growing memory", async () => {
  const path = tempSocket();
  await runner(path, (_req, sock) => sock.write("x".repeat(2 * 1024 * 1024)));
  await expect(controlClient(path).status()).resolves.toBeUndefined();
});

test("drain sends drain; a refusal rejects with the runner's code", async () => {
  const path = tempSocket();
  const ops: string[] = [];
  let refuse = false;
  await runner(path, (req, sock) => {
    ops.push(req.op);
    answer(
      sock,
      refuse
        ? { id: req.id, ok: false, error: { code: "failed", message: "no" } }
        : { id: req.id, ok: true, result: null },
    );
  });
  const c = controlClient(path);
  await expect(c.drain()).resolves.toBeUndefined();
  refuse = true;
  await expect(c.drain()).rejects.toMatchObject({ code: "failed" });
  expect(ops).toEqual(["drain", "drain"]);
});

test("drain with no runner rejects with no_runner", async () => {
  const err = await controlClient(tempSocket())
    .drain()
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ControlError);
  expect((err as ControlError).code).toBe("no_runner");
});

test("subscribe reports the current status, each event, then undefined and a retry", async () => {
  const path = tempSocket();
  const retries: Array<() => void> = [];
  const r = await runner(path, (req, sock) => {
    answer(sock, { id: req.id, ok: true, result: LIVE });
    answer(sock, { event: "status", status: { ...LIVE, connection: "offline" } });
    sock.write("not json\n");
  });
  const got: unknown[] = [];
  let resolveSeen: () => void = () => {};
  const seen = new Promise<void>((resolve) => {
    resolveSeen = resolve;
  });
  const stop = controlClient(path, {
    schedule: (fn) => {
      retries.push(fn);
      return () => {};
    },
  }).subscribe((s) => {
    got.push(s);
    if (got.length === 3) resolveSeen();
    if (got.length === 2) for (const s of r.sockets) s.destroy();
  });
  await seen;
  expect(got).toEqual([LIVE, { ...LIVE, connection: "offline" }, undefined]);
  expect(retries).toHaveLength(1);
  stop();
});

test("subscribe with no runner reports undefined once and schedules a retry", async () => {
  const retries: Array<() => void> = [];
  const got: unknown[] = [];
  const stop = controlClient(tempSocket(), {
    schedule: (fn) => {
      retries.push(fn);
      return () => {};
    },
  }).subscribe((s) => got.push(s));
  await expect.poll(() => retries.length).toBe(1);
  retries[0]?.();
  await expect.poll(() => retries.length).toBe(2);
  expect(got).toEqual([undefined]);
  stop();
});

/** A runner for device `id` at a fresh socket, answering status and subscribe with its LIVE. */
async function connectionRunner(id: string) {
  const path = tempSocket();
  const subscribed: string[] = [];
  const r = await runner(path, (req, sock) => {
    if (req.op === "subscribe") subscribed.push(req.op);
    answer(sock, { id: req.id, ok: true, result: { ...LIVE, deviceId: id } });
  });
  const conn: ConnectionSocket = { deviceId: id, controlSocket: path, control: "ok" };
  const push = (over: Record<string, unknown>) => {
    for (const s of r.sockets)
      answer(s, { event: "status", status: { ...LIVE, deviceId: id, ...over } });
  };
  return { conn, subscribed, sockets: r.sockets, push };
}

/** A schedule that runs nothing by itself; `rescan()` runs the pending rescan. */
function manualSchedule() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const entry = { fn, ms };
      pending.push(entry);
      return () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    rescans: () => pending.filter((p) => p.ms === RESCAN_MS).length,
    rescan() {
      const i = pending.findIndex((p) => p.ms === RESCAN_MS);
      const [entry] = pending.splice(i, 1);
      entry?.fn();
    },
  };
}

test("subscribeAll follows every connection's socket and notices a new one at the next rescan", async () => {
  const a = await connectionRunner("dev-a");
  const b = await connectionRunner("dev-b");
  const c = await connectionRunner("dev-c");
  let list = [a.conn, b.conn];
  let reads = 0;
  const s = manualSchedule();
  const controls = createConnectionControls({
    readConnections: async () => {
      reads++;
      return list;
    },
    schedule: s.schedule,
  });
  let calls = 0;
  const stop = controls.subscribeAll(() => calls++);
  await expect.poll(() => a.subscribed.length + b.subscribed.length).toBe(2);
  await expect.poll(() => s.rescans()).toBe(1);
  // The state at subscription time is what the read showed: no callback for it.
  expect(calls).toBe(0);

  b.push({ connection: "offline" });
  await expect.poll(() => calls).toBe(1);

  // A new connection: noticed at the next rescan, and its socket followed from then on.
  list = [a.conn, b.conn, c.conn];
  s.rescan();
  await expect.poll(() => calls).toBe(2);
  await expect.poll(() => c.subscribed.length).toBe(1);
  c.push({ connection: "draining" });
  await expect.poll(() => calls).toBe(3);

  // A connection that goes: noticed, and its socket let go.
  list = [b.conn, c.conn];
  await expect.poll(() => s.rescans()).toBe(1);
  s.rescan();
  await expect.poll(() => calls).toBe(4);
  await expect.poll(() => a.sockets.size).toBe(0);

  // Nothing changed: a rescan calls nobody.
  await expect.poll(() => s.rescans()).toBe(1);
  const before = reads;
  s.rescan();
  await expect.poll(() => reads).toBe(before + 1);
  await expect.poll(() => s.rescans()).toBe(1);
  expect(calls).toBe(4);

  stop();
  await expect.poll(() => b.sockets.size + c.sockets.size).toBe(0);
  expect(s.rescans()).toBe(0);
});

test("a connection whose control state changes is followed afresh and announced", async () => {
  const a = await connectionRunner("dev-a");
  let conn: ConnectionSocket = { ...a.conn, control: "absent" };
  const s = manualSchedule();
  const controls = createConnectionControls({
    readConnections: async () => [conn],
    schedule: s.schedule,
  });
  let calls = 0;
  const stop = controls.subscribeAll(() => calls++);
  await expect.poll(() => a.subscribed.length).toBe(1);
  await expect.poll(() => s.rescans()).toBe(1);
  conn = { ...a.conn, control: "ok" };
  s.rescan();
  await expect.poll(() => calls).toBe(1);
  await expect.poll(() => a.subscribed.length).toBe(2);
  stop();
});

test("an unreadable status keeps the followed sockets and tries again", async () => {
  const a = await connectionRunner("dev-a");
  let fail = false;
  const s = manualSchedule();
  const controls = createConnectionControls({
    readConnections: async () => {
      if (fail) throw new Error("unreadable");
      return [a.conn];
    },
    schedule: s.schedule,
  });
  let calls = 0;
  const stop = controls.subscribeAll(() => calls++);
  await expect.poll(() => a.subscribed.length).toBe(1);
  await expect.poll(() => s.rescans()).toBe(1);
  fail = true;
  s.rescan();
  await expect.poll(() => s.rescans()).toBe(1);
  expect(calls).toBe(0);
  a.push({ connection: "offline" });
  await expect.poll(() => calls).toBe(1);
  stop();
});

test("forDevice asks the socket the last read showed; an unknown device has no runner", async () => {
  const a = await connectionRunner("dev-a");
  const controls = createConnectionControls({
    readConnections: async () => [
      a.conn,
      { deviceId: "dev-x", controlSocket: null, control: "unavailable" },
    ],
  });
  // Before any read nothing is known.
  await expect(controls.forDevice("dev-a").status()).resolves.toBeUndefined();
  await expect(controls.read()).resolves.toHaveLength(2);
  await expect(controls.forDevice("dev-a").status()).resolves.toEqual({
    ...LIVE,
    deviceId: "dev-a",
  });
  await expect(controls.forDevice("dev-x").status()).resolves.toBeUndefined();
  await expect(controls.forDevice("dev-x").running()).resolves.toEqual([]);
  const err = await controls
    .forDevice("nope")
    .drain()
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ControlError);
  expect((err as ControlError).code).toBe("no_runner");
});
