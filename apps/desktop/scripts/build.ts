// Builds the app into dist/: the main process and the preloads as single CommonJS bundles (a
// sandboxed preload cannot require local files), the address page's static files, and the local
// pages: each src/local/pages/<name>.ts bundled for the browser into dist/local/<name>.js (one
// IIFE per page, kit and runtime included), next to its html (and css, if any) and base.css.
// Run: pnpm --filter @capybara-hq/desktop build
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build, type Plugin } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist`;

await rm(dist, { recursive: true, force: true });

// The app imports only the shell types and key constants of `@capybara-hq/plugin-sdk`, whose
// package.json declares no `sideEffects`; without this every module of its index (zod schemas,
// yaml, kysely, ...) would be bundled. Its modules have no import-time effects the app relies on.
const sdkWithoutSideEffects: Plugin = {
  name: "plugin-sdk-side-effect-free",
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData === "sdk-resolve") return undefined;
      const inSdk = (p: string) => /[\\/]@capybara-hq[\\/]plugin-sdk[\\/]/.test(p);
      if (!args.path.startsWith("@capybara-hq/plugin-sdk") && !inSdk(args.importer)) {
        return undefined;
      }
      const result = await b.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: "sdk-resolve",
      });
      if (result.errors.length > 0 || !inSdk(result.path)) return undefined;
      return { path: result.path, sideEffects: false };
    });
  },
};

const common: BuildOptions = {
  absWorkingDir: root,
  bundle: true,
  format: "cjs",
  outdir: dist,
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
  logLevel: "warning",
  plugins: [sdkWithoutSideEffects],
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
    "preload/local": "src/preload/local.ts",
  },
  platform: "browser",
  target: "chrome130",
});

await mkdir(`${dist}/address-page`, { recursive: true });
for (const file of ["index.html", "address.css", "address.js"]) {
  await copyFile(`${root}src/address-page/${file}`, `${dist}/address-page/${file}`);
}
// Flat names only: app://local serves `/<name>.(html|css|js)` and nothing nested.
const LOCAL_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.(ts|html|css)$/;
const pagesDir = `${root}src/local/pages`;
const pageFiles = (await readdir(pagesDir).catch(() => [] as string[])).filter((f) => {
  if (f.endsWith(".test.ts") || f.startsWith(".")) return false;
  if (!LOCAL_NAME.test(f)) throw new Error(`local page file ${f}: use a flat lowercase name`);
  return true;
});
await mkdir(`${dist}/local`, { recursive: true });
await copyFile(`${root}src/local/base.css`, `${dist}/local/base.css`);
const pageEntries = Object.fromEntries(
  pageFiles.filter((f) => f.endsWith(".ts")).map((f) => [f.slice(0, -3), `src/local/pages/${f}`]),
);
if (Object.keys(pageEntries).length > 0) {
  await build({
    absWorkingDir: root,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome130",
    outdir: `${dist}/local`,
    entryPoints: pageEntries,
    logLevel: "warning",
  });
}
for (const f of pageFiles.filter((f) => !f.endsWith(".ts"))) {
  await copyFile(`${pagesDir}/${f}`, `${dist}/local/${f}`);
}
console.log("built apps/desktop/dist");
