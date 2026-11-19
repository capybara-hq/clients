import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { verifyPackedResources } from "../../scripts/verify-resources.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** apps/desktop with a pinned device in node_modules, and a packed app holding a copy of it. */
function fixture(version = "0.1.0-rc.18") {
  const base = mkdtempSync(join(tmpdir(), "cdv-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "desktop");
  const pkg = join(root, "node_modules", "@capybara-hq", "device");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: { "@capybara-hq/device": "0.1.0-rc.18" } }),
  );
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@capybara-hq/device", version }),
  );
  writeFileSync(join(pkg, "bin", "capybara-device.mjs"), "run()\n");
  const app = join(base, "Capybara.app");
  const resources = join(app, "Contents", "Resources");
  cpSync(pkg, join(resources, "device"), { recursive: true });
  mkdirSync(join(resources, "node"), { recursive: true });
  writeFileSync(join(resources, "node", "node"), "mach-o");
  return { root, app, resources };
}

const universal = () => ["x86_64", "arm64"];

test("an exact device copy and a universal node pass", () => {
  const f = fixture();
  expect(() => verifyPackedResources(f.app, { root: f.root, archsOf: universal })).not.toThrow();
});

test("a missing device fails the build", () => {
  const f = fixture();
  rmSync(join(f.resources, "device"), { recursive: true });
  expect(() => verifyPackedResources(f.app, { root: f.root, archsOf: universal })).toThrow(
    /device is missing/,
  );
});

test("another device version than the pinned one fails the build", () => {
  const f = fixture("0.1.0-rc.17");
  expect(() => verifyPackedResources(f.app, { root: f.root, archsOf: universal })).toThrow(
    /not the pinned @capybara-hq\/device@0\.1\.0-rc\.18/,
  );
});

test("a changed, missing or extra device file fails the build", () => {
  const f = fixture();
  writeFileSync(join(f.resources, "device", "bin", "capybara-device.mjs"), "patched()\n");
  writeFileSync(join(f.resources, "device", "extra.js"), "x");
  expect(() => verifyPackedResources(f.app, { root: f.root, archsOf: universal })).toThrow(
    /bin\/capybara-device\.mjs differs[\s\S]*extra\.js is not in node_modules/,
  );
  rmSync(join(f.resources, "device", "bin", "capybara-device.mjs"));
  expect(() => verifyPackedResources(f.app, { root: f.root, archsOf: universal })).toThrow(
    /capybara-device\.mjs is missing/,
  );
});

test("a missing or single-architecture node fails the build", () => {
  const f = fixture();
  expect(() => verifyPackedResources(f.app, { root: f.root, archsOf: () => ["arm64"] })).toThrow(
    /not universal \(arm64\)/,
  );
  rmSync(join(f.resources, "node", "node"));
  expect(() => verifyPackedResources(f.app, { root: f.root, archsOf: universal })).toThrow(
    /node\/node is missing/,
  );
});
