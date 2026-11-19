import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlSocketPath as packageSocketPath,
  stateDir as packageStateDir,
} from "@capybara-hq/device";
import { afterEach, expect, test } from "vitest";
import {
  ControlError,
  controlClient,
  controlSocketPath,
  deviceStateDir,
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

function tempStateDir(): string {
  // Short: a unix socket path holds at most 103 bytes.
  const dir = mkdtempSync(join(tmpdir(), "cdc-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A runner stand-in: `onLine` answers each request line on its socket. */
async function runner(
  dir: string,
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
  await new Promise<void>((resolve) => server.listen(controlSocketPath(dir), resolve));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return { server, sockets };
}

const answer = (sock: Socket, line: unknown) => sock.write(`${JSON.stringify(line)}\n`);

test("the socket path and state directory match the device package", () => {
  expect(controlSocketPath("/s")).toBe(packageSocketPath("/s"));
  const env = { XDG_CONFIG_HOME: "/x" };
  expect(deviceStateDir(env, "/h")).toBe(packageStateDir(env, "/h"));
  expect(deviceStateDir({}, "/h")).toBe(packageStateDir({}, "/h"));
  expect(deviceStateDir({ XDG_CONFIG_HOME: "" }, "/h")).toBe(
    packageStateDir({ XDG_CONFIG_HOME: "" }, "/h"),
  );
});

test("status is undefined when no socket exists", async () => {
  const c = controlClient(tempStateDir());
  await expect(c.status()).resolves.toBeUndefined();
  await expect(c.running()).resolves.toEqual([]);
});

test("status is undefined when the path is a plain file, not a socket", async () => {
  const dir = tempStateDir();
  writeFileSync(controlSocketPath(dir), "x");
  await expect(controlClient(dir).status()).resolves.toBeUndefined();
});

test("status asks the runner with a JSON line and answers its LiveStatus", async () => {
  const dir = tempStateDir();
  const seen: unknown[] = [];
  await runner(dir, (req, sock) => {
    seen.push(req);
    answer(sock, { id: req.id, ok: true, result: LIVE });
  });
  await expect(controlClient(dir).status()).resolves.toEqual(LIVE);
  expect(seen).toEqual([{ id: 1, op: "status" }]);
});

test("malformed frames and answers to other ids are skipped", async () => {
  const dir = tempStateDir();
  await runner(dir, (req, sock) => {
    sock.write("garbage{\n");
    answer(sock, { event: "status", status: LIVE });
    answer(sock, { id: 99, ok: true, result: { other: true } });
    answer(sock, { id: req.id, ok: true, result: [OP, { tag: 5 }] });
  });
  await expect(controlClient(dir).running()).resolves.toEqual([OP]);
});

test("an answer of the wrong shape is no status", async () => {
  const dir = tempStateDir();
  await runner(dir, (req, sock) => answer(sock, { id: req.id, ok: true, result: { pid: "x" } }));
  await expect(controlClient(dir).status()).resolves.toBeUndefined();
});

test("a runner that never answers times out to undefined", async () => {
  const dir = tempStateDir();
  await runner(dir, () => {});
  await expect(controlClient(dir, { timeoutMs: 20 }).status()).resolves.toBeUndefined();
});

test("an over-long line ends the request without growing memory", async () => {
  const dir = tempStateDir();
  await runner(dir, (_req, sock) => sock.write("x".repeat(2 * 1024 * 1024)));
  await expect(controlClient(dir).status()).resolves.toBeUndefined();
});

test("drain sends drain; a refusal rejects with the runner's code", async () => {
  const dir = tempStateDir();
  const ops: string[] = [];
  let refuse = false;
  await runner(dir, (req, sock) => {
    ops.push(req.op);
    answer(
      sock,
      refuse
        ? { id: req.id, ok: false, error: { code: "failed", message: "no" } }
        : { id: req.id, ok: true, result: null },
    );
  });
  const c = controlClient(dir);
  await expect(c.drain()).resolves.toBeUndefined();
  refuse = true;
  await expect(c.drain()).rejects.toMatchObject({ code: "failed" });
  expect(ops).toEqual(["drain", "drain"]);
});

test("drain with no runner rejects with no_runner", async () => {
  const err = await controlClient(tempStateDir())
    .drain()
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ControlError);
  expect((err as ControlError).code).toBe("no_runner");
});

test("subscribe reports the current status, each event, then undefined and a retry", async () => {
  const dir = tempStateDir();
  const retries: Array<() => void> = [];
  const r = await runner(dir, (req, sock) => {
    answer(sock, { id: req.id, ok: true, result: LIVE });
    answer(sock, { event: "status", status: { ...LIVE, connection: "offline" } });
    sock.write("not json\n");
  });
  const got: unknown[] = [];
  let resolveSeen: () => void = () => {};
  const seen = new Promise<void>((resolve) => {
    resolveSeen = resolve;
  });
  const stop = controlClient(dir, {
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
  const stop = controlClient(tempStateDir(), {
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
