// Builds the app's local pages into dist/local, the folder Capacitor copies into the native
// projects (`webDir`): every file of src/local, with each `.ts` file bundled into an IIFE beside its
// page, and the shell environment script (src/inject/shell-environment.ts) as
// dist/local/inject/shell-environment.js for the native side to inject into profile WebViews.
// Everything targets the browser: no Node built-ins (node:crypto included) reach the bundle.
// Run: pnpm --filter @capybara-hq/mobile build
import { cp, glob, mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}dist/local`;

await rm(`${root}dist`, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const entryPoints: Record<string, string> = {};
for await (const file of glob("src/local/**/*", { cwd: root })) {
  if (!(await stat(`${root}${file}`)).isFile()) continue;
  const rel = file.slice("src/local/".length);
  if (file.endsWith(".ts")) {
    entryPoints[rel.slice(0, -".ts".length)] = file;
  } else {
    await mkdir(dirname(`${out}/${rel}`), { recursive: true });
    await cp(`${root}${file}`, `${out}/${rel}`);
  }
}
const inject = "src/inject/shell-environment.ts";
if (await stat(`${root}${inject}`).catch(() => null)) {
  entryPoints["inject/shell-environment"] = inject;
}

if (Object.keys(entryPoints).length > 0) {
  await build({
    absWorkingDir: root,
    entryPoints,
    outdir: out,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["safari17", "chrome120"],
    logLevel: "warning",
  });
}
