// The packaging guard (afterPack, macOS): the packed app must carry the bundled runtime exactly
// as scripts/bundle-node.ts made it, or the build fails. Contents/Resources/device must be the
// pinned @capybara-hq/device with every file hash-equal to node_modules (its runtime attestation
// hashes these files), and Contents/Resources/node/node a universal (x86_64 + arm64) binary.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { hashTree, pinnedDeviceVersion } from "./bundle-node.ts";

export interface VerifyDeps {
  /** apps/desktop (holds package.json and node_modules/@capybara-hq/device). */
  root: string;
  /** The architectures of a Mach-O file (`lipo -archs`). */
  archsOf?: (file: string) => string[];
}

function lipoArchs(file: string): string[] {
  return execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim().split(/\s+/);
}

/** Throws with every problem found in `<app>/Contents/Resources`. */
export function verifyPackedResources(appPath: string, deps: VerifyDeps): void {
  const resources = join(appPath, "Contents", "Resources");
  const problems: string[] = [];

  const expected = pinnedDeviceVersion(readFileSync(join(deps.root, "package.json"), "utf8"));
  const device = join(resources, "device");
  const pkgFile = join(device, "package.json");
  if (!existsSync(pkgFile)) {
    problems.push(`${device} is missing (run: pnpm --filter @capybara-hq/desktop bundle-node)`);
  } else {
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { name?: unknown; version?: unknown };
    if (pkg.name !== "@capybara-hq/device" || pkg.version !== expected) {
      problems.push(
        `Resources/device is ${String(pkg.name)}@${String(pkg.version)}, ` +
          `not the pinned @capybara-hq/device@${expected}`,
      );
    } else {
      const original = hashTree(
        realpathSync(join(deps.root, "node_modules", "@capybara-hq", "device")),
      );
      const packed = hashTree(device);
      for (const [path, hash] of original) {
        if (!packed.has(path)) problems.push(`Resources/device/${path} is missing`);
        else if (packed.get(path) !== hash) problems.push(`Resources/device/${path} differs`);
      }
      for (const path of packed.keys()) {
        if (!original.has(path)) problems.push(`Resources/device/${path} is not in node_modules`);
      }
    }
  }

  const node = join(resources, "node", "node");
  if (!existsSync(node)) {
    problems.push(`${node} is missing (run: pnpm --filter @capybara-hq/desktop bundle-node)`);
  } else {
    const archs = (deps.archsOf ?? lipoArchs)(node).sort();
    if (archs.join(" ") !== "arm64 x86_64") {
      problems.push(
        `Resources/node/node is not universal (${archs.join(" ") || "no architecture"})`,
      );
    }
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, 20).join("\n  ");
    const more = problems.length > 20 ? `\n  … and ${problems.length - 20} more` : "";
    throw new Error(`the packed app's bundled runtime is wrong:\n  ${shown}${more}`);
  }
}
