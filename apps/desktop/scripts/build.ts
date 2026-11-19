// Builds the app into dist/: the main process and both preloads as single CommonJS bundles (a
// sandboxed preload cannot require local files), plus the address page's static files.
// Run: pnpm --filter @capybara-hq/desktop build
import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist`;

await rm(dist, { recursive: true, force: true });

const common: BuildOptions = {
  absWorkingDir: root,
  bundle: true,
  format: "cjs",
  outdir: dist,
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: { "main/index": "src/main/index.ts" },
  platform: "node",
  target: "node22",
});

await build({
  ...common,
  entryPoints: {
    "preload/index": "src/preload/index.ts",
    "preload/address": "src/preload/address.ts",
  },
  platform: "browser",
  target: "chrome130",
});

await mkdir(`${dist}/address-page`, { recursive: true });
for (const file of ["index.html", "address.css", "address.js"]) {
  await copyFile(`${root}src/address-page/${file}`, `${dist}/address-page/${file}`);
}
console.log("built apps/desktop/dist");
