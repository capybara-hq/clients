// Builds the app into dist/: the main process and both preloads as single CommonJS bundles (a
// sandboxed preload cannot require local files), plus the address page's static files.
// Run: pnpm --filter @capybara-hq/desktop build
import { copyFile, mkdir, rm } from "node:fs/promises";
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
  },
  platform: "browser",
  target: "chrome130",
});

await mkdir(`${dist}/address-page`, { recursive: true });
for (const file of ["index.html", "address.css", "address.js"]) {
  await copyFile(`${root}src/address-page/${file}`, `${dist}/address-page/${file}`);
}
console.log("built apps/desktop/dist");
