import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { expect, test } from "vitest";
import {
  type ChildLike,
  createDeviceCli,
  deviceEnv,
  devicePaths,
  type SpawnLike,
} from "../../src/main/device/cli.ts";

interface Spawned {
  cmd: string;
  args: readonly string[];
  env: Record<string, string>;
  child: ChildLike & { stdout: PassThrough; stderr: PassThrough; emit: EventEmitter["emit"] };
}

function fakeSpawn() {
  const calls: Spawned[] = [];
  const spawn: SpawnLike = (cmd, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    calls.push({ cmd, args, env: options.env, child });
    return child;
  };
  return { spawn, calls };
}

const RESOURCES = "/Applications/Capybara.app/Contents/Resources";

/** Ends the fake's streams, waits until they drained, then closes it like a real child. */
async function finish(
  call: Spawned | undefined,
  code: number | null,
  signal: string | null = null,
) {
  if (!call) throw new Error("nothing was spawned");
  call.child.stdout.end();
  call.child.stderr.end();
  await Promise.all([finished(call.child.stdout), finished(call.child.stderr)]);
  call.child.emit("close", code, signal);
}

test("runs the bundled node on the bundled device bin with the arguments", async () => {
  const f = fakeSpawn();
  const cli = createDeviceCli({ resourcesPath: RESOURCES, spawn: f.spawn, env: {} });
  const done = cli(["service", "status", "--json"]);
  const call = f.calls[0];
  expect(call?.cmd).toBe(`${RESOURCES}/node/node`);
  expect(call?.args).toEqual([
    `${RESOURCES}/device/bin/capybara-device.mjs`,
    "service",
    "status",
    "--json",
  ]);
  await finish(call, 1);
  await expect(done).resolves.toMatchObject({ code: 1 });
});

test("devicePaths names the node binary and the bin script under Resources", () => {
  expect(devicePaths("/r")).toEqual({
    node: "/r/node/node",
    bin: "/r/device/bin/capybara-device.mjs",
  });
});

test("the environment keeps PATH and HOME and drops everything Electron-specific", () => {
  const env = deviceEnv({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/me",
    XDG_CONFIG_HOME: "/Users/me/.cfg",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    NODE_OPTIONS: "--require /tmp/evil.js",
    XPC_SERVICE_NAME: "top.capybara.device",
    SECRET_TOKEN: "x",
  });
  expect(env.PATH).toBe("/usr/bin:/bin");
  expect(env.HOME).toBe("/Users/me");
  expect(env.XDG_CONFIG_HOME).toBe("/Users/me/.cfg");
  expect(env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  expect(env).not.toHaveProperty("ELECTRON_NO_ATTACH_CONSOLE");
  expect(env).not.toHaveProperty("NODE_OPTIONS");
  expect(env).not.toHaveProperty("XPC_SERVICE_NAME");
  expect(env).not.toHaveProperty("SECRET_TOKEN");
});

test("the spawned process gets that environment, never ELECTRON_RUN_AS_NODE", async () => {
  const f = fakeSpawn();
  const cli = createDeviceCli({
    resourcesPath: RESOURCES,
    spawn: f.spawn,
    env: { PATH: "/bin", HOME: "/h", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect" },
  });
  const done = cli(["status", "--json"]);
  const call = f.calls[0];
  expect(call?.env).toEqual({ PATH: "/bin", HOME: "/h" });
  await finish(call, 0);
  await done;
});

test("parses JSON lines across chunks and ignores non-JSON lines", async () => {
  const f = fakeSpawn();
  const cli = createDeviceCli({ resourcesPath: RESOURCES, spawn: f.spawn, env: {} });
  const lines: unknown[] = [];
  const done = cli(["login", "--json"], { onLine: (obj) => lines.push(obj) });
  const out = f.calls[0]?.child.stdout;
  out?.write('{"event":"verifi');
  out?.write('cation","url":"https://x/devices/link?code=AB"}\nOpen the page\n');
  out?.write("not json {\n\n42\n");
  out?.write('{"event":"done","deviceId":"d1"}');
  await finish(f.calls[0], 0);
  await expect(done).resolves.toMatchObject({ code: 0 });
  expect(lines).toEqual([
    { event: "verification", url: "https://x/devices/link?code=AB" },
    { event: "done", deviceId: "d1" },
  ]);
});

test("keeps the tail of stderr for the caller", async () => {
  const f = fakeSpawn();
  const cli = createDeviceCli({ resourcesPath: RESOURCES, spawn: f.spawn, env: {} });
  const done = cli(["service", "install"]);
  f.calls[0]?.child.stderr.write("launchctl bootstrap failed\n");
  await finish(f.calls[0], 1);
  await expect(done).resolves.toEqual({ code: 1, stderr: "launchctl bootstrap failed\n" });
});

test("a process killed by a signal reports a non-zero code", async () => {
  const f = fakeSpawn();
  const cli = createDeviceCli({ resourcesPath: RESOURCES, spawn: f.spawn, env: {} });
  const done = cli(["status"]);
  await finish(f.calls[0], null, "SIGKILL");
  expect((await done).code).not.toBe(0);
});

test("a missing bundled node rejects", async () => {
  const f = fakeSpawn();
  const cli = createDeviceCli({ resourcesPath: RESOURCES, spawn: f.spawn, env: {} });
  const done = cli(["status"]);
  f.calls[0]?.child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  await expect(done).rejects.toThrow(/ENOENT/);
});
