# AGENTS.md

Capybara clients: the official Capybara desktop app (Electron, macOS first) and the mobile app shell.
Both are thin shells: they load a deployment's own web app, sign in through the system browser, and
connect the machine as a local device. TypeScript, pnpm monorepo, Apache-2.0.

The design lives in capybara-hq/core, not here: the plan is
`docs/superpowers/plans/2026-11-19-desktop-client.md` and the spec
`docs/superpowers/specs/2026-11-07-desktop-client-design.md` (the spec wins over the plan).
Skills in `.agents/skills/` (`onboarding`, `contributing`, `reviewing-prs`) are synced from
`capybara-hq/.github`: edit them there.

## Repository map

| Path             | What it is                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `packages/shell` | `@capybara-hq/shell` (private): pure logic and the i18n catalog (zh, en); no Electron imports |
| `apps/desktop`   | `@capybara-hq/desktop` (private): the Electron app; `brand.ts` is the only brand file         |
| `apps/mobile`    | `@capybara-hq/mobile` (private): the Capacitor app with its iOS and Android projects          |

## Rules

- Depend on published npm packages only for Capybara core packages (`@capybara-hq/plugin-sdk`,
  `@capybara-hq/device`, an exact version) and Electron: never the kernel, never
  `@capybara-hq/design`, never a `workspace:` / `file:` / `link:` reference or a path into a core
  checkout. Packages of this repository link to each other with `workspace:*`.
- Main-process modules take their Electron objects as parameters, so they test without Electron.
- Tests: `pnpm test` (vitest) from the root; no fixed sleeps, no per-test timeouts.
- English for code, comments, identifiers and commit messages. UI text goes through the shell i18n
  catalog; the zh copy says 平台 / 智能体 / 设备 / 本机, never 企业 or the Latin word `agent`.
- Mobile: `apps/mobile/brand.ts` is the only brand file; native code namespaces are fixed (Swift
  module `App`, Kotlin package `com.capybarahq.shell`). Capacitor's bridge never reaches a profile
  WebView.
- Tests never touch the real Keychain, real login items or launchd; use injected fakes.

## Commands

```bash
pnpm install
pnpm lint        # biome check
pnpm typecheck   # tsc -b plus the test files
pnpm test        # vitest run
pnpm check:i18n  # the zh and en catalogs have the same keys and placeholders
pnpm e2e         # builds the desktop app and runs the Playwright smoke (apps/desktop/e2e)
pnpm changeset   # a version note for an app or package

# The desktop app (from the root)
node apps/desktop/node_modules/electron/install.js   # once: the Electron binary (installs skip it)
pnpm --filter @capybara-hq/desktop dev           # build, then run Electron on the unpackaged app
pnpm --filter @capybara-hq/desktop bundle-node   # fill build/node and build/device (the device)
pnpm --filter @capybara-hq/desktop dist --mac --publish never   # an unsigned local package

# The mobile app (Xcode, JDK 21 and the Android SDK; Gradle only through the wrapper)
pnpm --filter @capybara-hq/mobile sync              # build the local pages, then cap sync
pnpm --filter @capybara-hq/mobile test:ios          # XCTest (AppTests) on an iPhone simulator
pnpm --filter @capybara-hq/mobile test:ios:ui       # XCUITest (AppUITests)
pnpm --filter @capybara-hq/mobile test:ios:all      # both, from one build-for-testing
pnpm --filter @capybara-hq/mobile test:android      # JVM unit tests (after build + cap sync)
pnpm --filter @capybara-hq/mobile test:android:device   # instrumented tests on a running emulator
```

## Work and commits

- Changes reach `main` only through pull requests; the required status is `ci-ok`.
- Work in a worktree under `.worktrees/<branch>`; the main checkout stays on `main`.
- Conventional Commits (checked by commitlint), body lines at most 100 characters. Apps are versioned
  by changesets (private packages are versioned, never published to npm).
