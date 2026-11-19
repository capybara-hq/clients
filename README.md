# Capybara clients

The official Capybara desktop app and mobile app shell. Both are thin shells: they draw no UI of
their own beyond a deployment address page and load the deployment's own web app.

- Desktop design: [desktop client design](https://github.com/capybara-hq/core/blob/main/docs/superpowers/specs/2026-11-07-desktop-client-design.md)
- Shell environment and mobile layout: [mobile layout design](https://github.com/capybara-hq/core/blob/main/docs/superpowers/specs/2026-11-19-mobile-layout-design.md)

Only the official builds, with the Capybara name and icon, are published from this repository. To
ship your own brand, fork it and publish your own build.

Licensed under Apache-2.0.

## Development

Node 24 and pnpm 10 (`corepack enable`). Packages: `packages/shell` (pure logic) and `apps/desktop`
(Electron). See [AGENTS.md](AGENTS.md) for the rules.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

### Run the desktop app in development

```bash
node apps/desktop/node_modules/electron/install.js   # once: downloads the Electron binary
pnpm --filter @capybara-hq/desktop bundle-node       # optional: the bundled device for 「连接本机」
pnpm --filter @capybara-hq/desktop dev               # builds and starts the unpackaged app
```

`pnpm e2e` runs the end-to-end smoke against a fake deployment; `pnpm --filter
@capybara-hq/desktop dist --mac --publish never` builds an unsigned package in
`apps/desktop/release`. Automatic updates work only in a packaged app.
