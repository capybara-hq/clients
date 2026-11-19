import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  copyDevicePackage,
  fetchNodeTarball,
  hashTree,
  NODE_PINS,
  NODE_VERSION,
  nodeTarballName,
  parseShasums,
} from "../../scripts/bundle-node.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "cdb-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

test("the pins name a Node 22 LTS of at least 22.12 for both mac architectures", () => {
  const [major, minor] = NODE_VERSION.split(".").map(Number);
  expect(major).toBe(22);
  expect(minor).toBeGreaterThanOrEqual(12);
  expect(Object.keys(NODE_PINS).sort()).toEqual(["darwin-arm64", "darwin-x64"]);
  for (const v of Object.values(NODE_PINS)) expect(v).toMatch(/^[0-9a-f]{64}$/);
});

test("parseShasums reads the sha256 of each file", () => {
  expect(
    parseShasums(`${"a".repeat(64)}  node-v1-darwin-x64.tar.gz\n${"b".repeat(64)}  other\n`),
  ).toEqual(
    new Map([
      ["node-v1-darwin-x64.tar.gz", "a".repeat(64)],
      ["other", "b".repeat(64)],
    ]),
  );
});

/** A downloader serving a tiny fake tarball and a SHASUMS256.txt. */
function fakeDownloads(tarball: Uint8Array, shasums: string) {
  const urls: string[] = [];
  return {
    urls,
    download: async (url: string) => {
      urls.push(url);
      if (url.endsWith("/SHASUMS256.txt")) return new TextEncoder().encode(shasums);
      return tarball;
    },
  };
}

test("a tarball matching the pin and SHASUMS256.txt is accepted and cached", async () => {
  const cache = temp();
  const tarball = new TextEncoder().encode("tiny tarball");
  const name = nodeTarballName("darwin-arm64");
  const d = fakeDownloads(tarball, `${sha(tarball)}  ${name}\n`);
  const pins = { "darwin-arm64": sha(tarball), "darwin-x64": "0".repeat(64) };
  const file = await fetchNodeTarball("darwin-arm64", { cacheDir: cache, pins, ...d });
  expect(readFileSync(file)).toEqual(Buffer.from(tarball));
  expect(d.urls).toEqual([
    `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`,
    `https://nodejs.org/dist/v${NODE_VERSION}/${name}`,
  ]);
  // A second run reuses the verified cache for the tarball.
  await fetchNodeTarball("darwin-arm64", { cacheDir: cache, pins, ...d });
  expect(d.urls.filter((u) => u.endsWith(".tar.gz"))).toHaveLength(1);
});

test("a wrong checksum fails the build", async () => {
  const tarball = new TextEncoder().encode("tampered");
  const name = nodeTarballName("darwin-x64");
  const pinned = "1".repeat(64);
  const pins = { "darwin-arm64": "0".repeat(64), "darwin-x64": pinned };
  // SHASUMS agrees with the pin, the downloaded bytes do not.
  await expect(
    fetchNodeTarball("darwin-x64", {
      cacheDir: temp(),
      pins,
      ...fakeDownloads(tarball, `${pinned}  ${name}\n`),
    }),
  ).rejects.toThrow(/checksum/i);
  // The bytes match the pin, but SHASUMS256.txt says otherwise.
  const good = { ...pins, "darwin-x64": sha(tarball) };
  await expect(
    fetchNodeTarball("darwin-x64", {
      cacheDir: temp(),
      pins: good,
      ...fakeDownloads(tarball, `${"2".repeat(64)}  ${name}\n`),
    }),
  ).rejects.toThrow(/SHASUMS256/);
  // SHASUMS256.txt does not list the file at all.
  await expect(
    fetchNodeTarball("darwin-x64", {
      cacheDir: temp(),
      pins: good,
      ...fakeDownloads(tarball, ""),
    }),
  ).rejects.toThrow(/SHASUMS256/);
});

test("a corrupt cached tarball is downloaded again", async () => {
  const cache = temp();
  const tarball = new TextEncoder().encode("real");
  const name = nodeTarballName("darwin-x64");
  writeFileSync(join(cache, name), "corrupt");
  const pins = { "darwin-arm64": "0".repeat(64), "darwin-x64": sha(tarball) };
  const d = fakeDownloads(tarball, `${sha(tarball)}  ${name}\n`);
  const file = await fetchNodeTarball("darwin-x64", { cacheDir: cache, pins, ...d });
  expect(readFileSync(file, "utf8")).toBe("real");
});

function fixturePackage(): string {
  const src = join(temp(), "device");
  mkdirSync(join(src, "bin"), { recursive: true });
  mkdirSync(join(src, "dist", "node_modules", "ws"), { recursive: true });
  writeFileSync(
    join(src, "package.json"),
    JSON.stringify({ name: "@capybara-hq/device", version: "0.1.0-rc.18" }),
  );
  writeFileSync(join(src, "bin", "capybara-device.mjs"), "#!/usr/bin/env node\n");
  chmodSync(join(src, "bin", "capybara-device.mjs"), 0o755);
  writeFileSync(join(src, "dist", "node_modules", "ws", "index.js"), "export {}\n");
  writeFileSync(join(src, "dist", "node_modules", "ws", ".npmignore"), "test\n");
  return src;
}

test("the copied device files hash equal to node_modules", () => {
  const src = fixturePackage();
  const dest = join(temp(), "out", "device");
  copyDevicePackage(src, dest, "0.1.0-rc.18");
  expect(hashTree(dest)).toEqual(hashTree(src));
  expect(hashTree(dest).size).toBe(4);
  expect(statSync(join(dest, "bin", "capybara-device.mjs")).mode & 0o777).toBe(0o755);
});

test("the copy replaces an older build/device completely", () => {
  const src = fixturePackage();
  const dest = join(temp(), "device");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "stale.js"), "old");
  copyDevicePackage(src, dest, "0.1.0-rc.18");
  expect([...hashTree(dest).keys()]).not.toContain("stale.js");
});

test("the copy refuses another version than the pinned one", () => {
  expect(() => copyDevicePackage(fixturePackage(), join(temp(), "d"), "0.1.0-rc.19")).toThrow(
    /0\.1\.0-rc\.18/,
  );
});

test("the copy refuses a package with runtime dependencies outside it", () => {
  const src = fixturePackage();
  writeFileSync(
    join(src, "package.json"),
    JSON.stringify({ name: "@capybara-hq/device", version: "1.0.0", dependencies: { ws: "^8" } }),
  );
  expect(() => copyDevicePackage(src, join(temp(), "d"), "1.0.0")).toThrow(/dependencies/);
});

test("the copy refuses symlinks inside the package", () => {
  const src = fixturePackage();
  symlinkSync("/etc/hosts", join(src, "dist", "link"));
  expect(() => copyDevicePackage(src, join(temp(), "d"), "0.1.0-rc.18")).toThrow(/symlink/);
});

test("hashTree changes when one byte changes", () => {
  const src = fixturePackage();
  const before = hashTree(src);
  writeFileSync(join(src, "dist", "node_modules", "ws", "index.js"), "export {};\n");
  expect(hashTree(src)).not.toEqual(before);
});
