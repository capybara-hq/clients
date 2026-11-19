// Fills build/node and build/device, which electron-builder ships under Contents/Resources outside
// ASAR (spec §5.2). Run: pnpm --filter @capybara-hq/desktop bundle-node (macOS: needs tar, lipo).
//
// build/node/node      the pinned Node 22 LTS for darwin-arm64 and darwin-x64, each tarball checked
//                      against the sha256 pinned below AND the release's SHASUMS256.txt, merged
//                      into one universal binary with `lipo -create` (plus Node's LICENSE).
// build/device/        the exact @capybara-hq/device from node_modules (pnpm's symlink resolved),
//                      copied byte for byte: its runtime attestation hashes these files. The
//                      package carries its runtime closure itself (`bundledRuntime`, under
//                      dist/node_modules) and declares no runtime dependencies, so the package
//                      directory is the whole closure; a version that declares dependencies is
//                      refused here until this script copies them too.
//
// Downloads are cached in build/.cache/node (gitignored); a cached tarball is reused only while it
// still hashes to its pin.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "22.23.5";

export type NodeArch = "darwin-arm64" | "darwin-x64";

/** sha256 of `node-v<NODE_VERSION>-<arch>.tar.gz`, from nodejs.org's SHASUMS256.txt. */
export const NODE_PINS: Record<NodeArch, string> = {
  "darwin-arm64": "e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d",
  "darwin-x64": "c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422",
};

const DIST = `https://nodejs.org/dist/v${NODE_VERSION}`;

export function nodeTarballName(arch: NodeArch): string {
  return `node-v${NODE_VERSION}-${arch}.tar.gz`;
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** `<sha256>  <file>` lines → file → sha256. */
export function parseShasums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m?.[1] && m[2]) out.set(m[2], m[1]);
  }
  return out;
}

export interface FetchDeps {
  cacheDir: string;
  download: (url: string) => Promise<Uint8Array>;
  pins?: Record<NodeArch, string>;
}

/**
 * The verified tarball for `arch` in the cache: SHASUMS256.txt must list the pinned sha256, and
 * the tarball's bytes must hash to it. Any mismatch fails the build.
 */
export async function fetchNodeTarball(arch: NodeArch, deps: FetchDeps): Promise<string> {
  const pin = (deps.pins ?? NODE_PINS)[arch];
  const name = nodeTarballName(arch);
  const listed = parseShasums(
    new TextDecoder().decode(await deps.download(`${DIST}/SHASUMS256.txt`)),
  ).get(name);
  if (listed !== pin) {
    throw new Error(
      `SHASUMS256.txt of Node v${NODE_VERSION} lists ${listed ?? "nothing"} for ${name}, ` +
        `but the pinned sha256 is ${pin}`,
    );
  }
  mkdirSync(deps.cacheDir, { recursive: true });
  const file = join(deps.cacheDir, name);
  if (existsSync(file) && sha256(readFileSync(file)) === pin) return file;
  const bytes = await deps.download(`${DIST}/${name}`);
  const got = sha256(bytes);
  if (got !== pin) {
    throw new Error(`checksum mismatch for ${name}: got ${got}, pinned ${pin}`);
  }
  const partial = `${file}.partial`;
  writeFileSync(partial, bytes);
  renameSync(partial, file);
  return file;
}

/** Every regular file under `dir` (relative path → sha256). Symlinks and other types throw. */
export function hashTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`unexpected symlink in the device package: ${p}`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.set(relative(dir, p), sha256(readFileSync(p)));
      else throw new Error(`unexpected file type in the device package: ${p}`);
    }
  };
  walk(dir);
  return out;
}

function sameTree(a: Map<string, string>, b: Map<string, string>): string | undefined {
  for (const [path, hash] of a) {
    if (!b.has(path)) return `${path} is missing from the copy`;
    if (b.get(path) !== hash) return `${path} differs from node_modules`;
  }
  for (const path of b.keys()) if (!a.has(path)) return `${path} is not in node_modules`;
  return undefined;
}

/**
 * Copies the device package at `src` (its real directory) to `dest`, replacing `dest`, and checks
 * that every file of the copy hashes equal to the original.
 */
export function copyDevicePackage(src: string, dest: string, expectedVersion: string): void {
  const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  if (pkg.name !== "@capybara-hq/device" || pkg.version !== expectedVersion) {
    throw new Error(
      `expected @capybara-hq/device@${expectedVersion} at ${src}, found ${String(pkg.name)}@${String(pkg.version)}`,
    );
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (deps !== undefined && Object.keys(deps as object).length > 0) {
      throw new Error(
        `@capybara-hq/device@${expectedVersion} declares ${field}; bundle-node copies only the ` +
          "package directory, so it must learn to copy their closure first",
      );
    }
  }
  const original = hashTree(src); // throws on a symlink before anything is written
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(resolve(dest, ".."), { recursive: true });
  cpSync(src, dest, { recursive: true, preserveTimestamps: true });
  const problem = sameTree(original, hashTree(dest));
  if (problem !== undefined) throw new Error(`the device copy is not exact: ${problem}`);
}

/** The exact version pinned in apps/desktop/package.json (a range is refused). */
export function pinnedDeviceVersion(packageJson: string): string {
  const pkg = JSON.parse(packageJson) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const v =
    pkg.devDependencies?.["@capybara-hq/device"] ?? pkg.dependencies?.["@capybara-hq/device"];
  if (v === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v)) {
    throw new Error(`apps/desktop must pin @capybara-hq/device to an exact version, found ${v}`);
  }
  return v;
}

/**
 * Downloads only from nodejs.org's dist directory over https and follows no redirect, so the
 * bytes checked against the pins can come from nowhere else.
 */
export async function httpDownload(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  if (!url.startsWith("https://nodejs.org/dist/")) {
    throw new Error(`refusing to download ${url}: only https://nodejs.org/dist/ is allowed`);
  }
  const res = await fetchImpl(url, { redirect: "error" });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("bundle-node builds the macOS app's runtime and needs macOS (lipo); skipped.");
    process.exit(1);
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const build = join(root, "build");
  const cacheDir = join(build, ".cache", "node");

  // Node: two verified tarballs, the binary of each, one universal binary.
  mkdirSync(cacheDir, { recursive: true });
  const work = mkdtempSync(join(build, ".cache", "extract-"));
  try {
    const slices: string[] = [];
    let license = "";
    for (const arch of ["darwin-arm64", "darwin-x64"] as const) {
      const tarball = await fetchNodeTarball(arch, {
        cacheDir,
        download: (url) => httpDownload(url),
      });
      const top = `node-v${NODE_VERSION}-${arch}`;
      const into = join(work, arch);
      mkdirSync(into);
      run("tar", ["-xzf", tarball, "-C", into, `${top}/bin/node`, `${top}/LICENSE`]);
      slices.push(join(into, top, "bin", "node"));
      license = join(into, top, "LICENSE");
    }
    const nodeDir = join(build, "node");
    rmSync(nodeDir, { recursive: true, force: true });
    mkdirSync(nodeDir, { recursive: true });
    const out = join(nodeDir, "node");
    run("lipo", ["-create", "-output", out, ...slices]);
    chmodSync(out, 0o755);
    cpSync(license, join(nodeDir, "LICENSE"));
    const archs = run("lipo", ["-archs", out]).trim().split(/\s+/).sort();
    if (archs.join(" ") !== "arm64 x86_64") {
      throw new Error(`build/node/node is not universal: ${archs.join(" ")}`);
    }
    const version = run(out, ["--version"]).trim();
    if (version !== `v${NODE_VERSION}`) throw new Error(`build/node/node reports ${version}`);
    console.log(`build/node/node: Node ${version}, ${archs.join(" + ")}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // The device package, unmodified.
  const expected = pinnedDeviceVersion(readFileSync(join(root, "package.json"), "utf8"));
  const src = realpathSync(join(root, "node_modules", "@capybara-hq", "device"));
  copyDevicePackage(src, join(build, "device"), expected);
  console.log(`build/device: @capybara-hq/device@${expected} from ${src}, every file hash-equal`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
