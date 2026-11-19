import { defineConfig } from "@playwright/test";

// One Electron app per run, driven through Playwright's `_electron` (no browser download). The
// tests share a launched app and run in order. No per-test timeouts: the CI job has a time limit,
// and every wait in the spec is on a condition.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 0,
  globalTimeout: 10 * 60 * 1000,
  // Failure artifacts land here; CI uploads the directory. `use.trace` does not apply to an app
  // launched with `_electron.launch`, so the spec records its own trace into this directory.
  outputDir: "./test-results",
  reporter: [["list"]],
});
