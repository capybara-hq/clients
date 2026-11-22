// The device program's own risk texts (spec §9.5): the widening dialog shows exactly what the
// bundled program says, never a copy kept here that could drift from it. The bundled Node prints
// the bundled package's `CEILING_WIDENING_TEXT` and `outsideSandboxRiskText(deviceId)` as one JSON
// line; the answer is kept per connection for the app run (the bundled package does not change
// while the app runs; an update installs at quit).
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deviceEnv, devicePaths, type SpawnLike } from "./cli.ts";
import { ID_PATTERN } from "./machine.ts";

export interface DeviceTexts {
  /** `CEILING_WIDENING_TEXT` (device `commands/ceiling.js`). */
  ceilingWidening: string;
  /** `outsideSandboxRiskText(deviceId)` (device `commands/login.js`). */
  outsideSandboxRisk: string;
}

export interface DeviceTextsDeps {
  resourcesPath: string;
  spawn: SpawnLike;
  env: Record<string, string | undefined>;
  /** How long the bundled Node may take (default 15 s). */
  timeoutMs?: number;
}

/**
 * Self-contained: the two module URLs and the device id arrive as arguments, never spliced into
 * the source.
 */
const SCRIPT = [
  "const [ceilingUrl, loginUrl, deviceId] = process.argv.slice(1);",
  "const ceiling = await import(ceilingUrl);",
  "const login = await import(loginUrl);",
  "console.log(JSON.stringify({ ceilingWidening: ceiling.CEILING_WIDENING_TEXT, outsideSandboxRisk: login.outsideSandboxRiskText(deviceId) }));",
].join("\n");

const TEXT_MAX = 4000;
const OUT_MAX = 64 * 1024;

function parse(stdout: string): DeviceTexts | undefined {
  for (const line of stdout.split("\n").reverse()) {
    try {
      const v = JSON.parse(line) as Record<string, unknown>;
      const { ceilingWidening, outsideSandboxRisk } = v ?? {};
      const ok = (s: unknown): s is string =>
        typeof s === "string" && s.trim() !== "" && s.length <= TEXT_MAX;
      if (ok(ceilingWidening) && ok(outsideSandboxRisk))
        return { ceilingWidening, outsideSandboxRisk };
    } catch {
      // not the answer line
    }
  }
  return undefined;
}

/**
 * Answers the texts for a connection; rejects (and asks again next time) when the program gives
 * none or the device id is not a safe one.
 */
export function createDeviceTexts(
  deps: DeviceTextsDeps,
): (deviceId: string) => Promise<DeviceTexts> {
  const cached = new Map<string, Promise<DeviceTexts>>();
  const { node } = devicePaths(deps.resourcesPath);
  const dist = join(deps.resourcesPath, "device", "dist", "commands");
  const args = [
    "--input-type=module",
    "-e",
    SCRIPT,
    "--",
    pathToFileURL(join(dist, "ceiling.js")).href,
    pathToFileURL(join(dist, "login.js")).href,
  ];

  function run(deviceId: string): Promise<DeviceTexts> {
    return new Promise((resolve, reject) => {
      const child = deps.spawn(node, [...args, deviceId], {
        env: deviceEnv(deps.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("the device program did not print its texts in time"));
      }, deps.timeoutMs ?? 15_000);
      timer.unref?.();
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (out.length < OUT_MAX) out += chunk;
      });
      child.stderr?.resume();
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", () => {
        clearTimeout(timer);
        const texts = parse(out);
        if (texts) resolve(texts);
        else reject(new Error("the device program printed no risk texts"));
      });
    });
  }

  return (deviceId) => {
    if (!ID_PATTERN.test(deviceId)) return Promise.reject(new Error("invalid device id"));
    let texts = cached.get(deviceId);
    if (texts === undefined) {
      texts = run(deviceId).catch((err: unknown) => {
        cached.delete(deviceId);
        throw err;
      });
      cached.set(deviceId, texts);
    }
    return texts;
  };
}
