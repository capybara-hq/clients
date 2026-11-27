# Desktop end-to-end and acceptance

## The automated smoke (`pnpm e2e`)

`smoke.spec.ts` (the shell, security and sign-out/expiry/unreachable specs, one launched app) and
`onboarding.spec.ts` (a fresh first launch through the onboarding, its own app) launch the real
Electron app through Playwright's `_electron` (no browser is downloaded; `harness.ts` is the shared
launcher) against `packages/shell/test/fixtures/fake-deployment.ts`, a dependency-free fake
deployment. Its switches: `meta` / `features` / `metaStatus` / `metaRaw` (meta shapes, including
`appRedirectUris`), `tokenError` (every token exchange refused with that kernel code), `down`
(503), `holdLogoutBody`, and `GET /protected` (a 302 to `/login?returnTo=%2Fprotected` without a
session). It needs no network and no real sign-in. Run it from the repository
root:

```bash
pnpm e2e
```

It builds the app, runs Electron's install script (the binary download that the workspace's
`allowBuilds: electron: false` skips for ordinary installs, so the unit-test jobs stay fast; the
script is idempotent), then runs the specs. CI runs it as the `e2e` job on `macos-latest`, which
`ci-ok` requires. It runs in full on every PR and every push to main (no diff-based planning):
the repository is small and this is its only runtime check of the app. A failure uploads the
Playwright trace (`trace.zip`, recorded by the spec on the app's context) and error context as the
`e2e-failure` artifact (kept 7 days). Electron windows appear for a few seconds; the app is closed
at the end.

The test seam: the app honours `CAPYBARA_E2E_USER_DATA` only when it is not packaged
(`!app.isPackaged`). It gives the run its own userData directory and keeps the run from calling
`setAsDefaultProtocolClient`. Nothing else differs from a normal run. The system browser is
stubbed by replacing `shell.openExternal` from the test (the URL is captured, nothing opens), and
the callback deep link is delivered by emitting `open-url` on `app`, the same event the OS raises,
so the app's own router handles it. No launchd, Keychain or login item is touched.

What it covers:

- First launch (`onboarding.spec.ts`): the small window is 480×600 and not resizable, on connect, with
  no profile saved. An address that is not a Capybara platform shows `not_capybara` inline and saves
  nothing. A platform whose `appRedirectUris` lacks the app's redirect URI: found (name, host), then
  `not_allowed` before the browser opens. A refused token exchange (`auth.account_disabled`) shows
  the error and saves nothing. An `access_denied` callback shows the cancelled error, its button
  signs in again, and the callback then closes the small window and opens the main window on `/`.
- An expired session (cookie removed from the partition, reload of a protected page): the expired
  overlay, no `/login` request reaches the server, and signing in again returns to the page.
- The web's logout and `/login` end in the signed-out small window. Its 「移除这个平台」 opens a shell
  dialog as a window of its own (not an overlay); cancel closes it and keeps the profile. The
  theme toggle on that local page writes `cb-theme` into the profile's partition, not the default
  session.
- The small window's frame origin is `app://local` (read in main), and the local page registry
  accepts its actions, so connect -> meta discovery -> icon -> 在浏览器中登录 -> callback -> the main
  window on `/` works, and the small window closes.
- The small window's theme toggle before any profile is the app's choice and seeds the new
  profile's `cb-theme` cookie (path `/`, `SameSite=Lax`, not HttpOnly) in its partition.
- The deployment page sees `window.capybaraShell` (`kind: desktop`, `platform: macos`, `version: 1`,
  insets `{0,0,0,0}`, controls `{0,0,92,48}`) with `signIn@1`, `notify@1`, `openExternal@1`,
  `chrome@1`, and no device capability. `executeInMainWorld` works.
- Same-origin and `/plugin-ui/...` iframes do not see `capybaraShell`.
- A `signIn@1` call without a user activation is refused (`no_activation`); a real click opens
  the authorize URL (client, redirect URI, S256 challenge, state) in the (stubbed) system browser.
- The callback deep link (`code`, `state`, `iss`) is exchanged (CSRF header, PKCE S256, one use);
  the cookie lands in the profile's partition and not in the default session; the window reloads
  signed in; a replayed callback sends nothing. `ses.fetch` honours the partition's cookies.
- `POST /api/v1/auth/login` from the window is blocked and never reaches the server.
- The desktop user agent goes to the profile's origin (page, fetch, exchange); a request that hops
  to another origin gets Chromium's own user agent there.
- The main window never leaves the profile's origin on a navigation the page starts: one that
  redirects to another origin is stopped and its target opens in the (stubbed) system browser. A
  load the page did not start still follows such a redirect (an identity-aware proxy).
- The web's own sign-out (`POST /api/v1/auth/logout` seen on the partition, then `/login`) closes
  the main window and shows the small window's signed-out page; the profile stays, signed out.
  When the logout completes only after the page navigated to `/login`, that `/login` is stopped
  (it never reaches the server), the expired overlay shows, and the completion ends the sign-out.
- A `/login` navigation without a logout is stopped and the main window shows the expired page
  (a `WebContentsView` with `app://local/main-error.html`); signing in again removes it and loads
  the `returnTo` page.
- `restart.spec.ts` launches twice on the same userData directory: a signed-in profile opens its
  main window (its persistent session cookie kept), a signed-out one its signed-out small window;
  a provisional partition directory left on disk is removed at start, the profile's own stays.
  The 「平台」 menu's sign-out, confirmed in the shell dialog, posts the logout and clears
  `cap_at` / `cap_rt`. A run in the background never gets OS focus, so the spec makes the dialog
  window report focus (as a click would) before the confirming button counts; its 500 ms lockout
  stays real. A deployment page has no `window.capybaraLocal`.
- A deployment document answered 503 shows the unreachable page; 重试 probes `/api/v1/meta`
  (still 503: the page stays); once it answers 2xx the overlay goes and the page loads again.

## Manual acceptance on a real Mac with a dev kernel

Use a Mac with the unsigned or signed build (`pnpm --filter @capybara-hq/desktop dist`), a dev
kernel whose `http.publicUrl` is set and `auth.appRedirectUris` containing
`capybara://auth/callback`.

### Sign-in and shell

- [ ] First launch opens the small window's connect page; enter the dev kernel's address; Continue
      shows its name and icon.
- [ ] 「在浏览器中登录」 opens the system browser; after approving, the callback returns to the app
      (the first `capybara://` link while the app is not running launches it; `open-url` before
      `ready` is not lost) and the window reloads signed in. Deny returns without signing in.
- [ ] The traffic lights sit in the web's top row, vertically centred on the sidebar's brand row,
      and the page's controls rectangle (`{0,0,92,48}`) covers them on the built window; in full
      screen `controls` is `null`.
- [ ] After sign-in the app window comes forward from behind the browser (macOS may not bring a
      background app forward without `app.focus({ steal: true })`).
- [ ] A signed-in session survives quitting and relaunching. 「移除平台」 (app menu 平台 and the
      tray) asks natively with the platform's name and host (取消 is the default), closes the
      platform's windows
      and clears its session; it is not offered under `lockDeployments`.

### Updates

- [ ] A running app checks for updates every 6 hours; a downloaded update shows one notification,
      and clicking it restarts into the new version.

### Menus, Dock, managed settings

- [ ] The tray icon shows platforms and the actions; the app menu follows the focused platform.
      The Dock icon shows the platform's icon only when exactly one platform is saved and it has
      set an icon (spec §11), else the app's own icon (reverting needs `build/icons/icon.png`).
- [ ] With the system language set to Chinese, every app menu item (including the ones macOS adds,
      such as the window list and the Edit menu's extras) is Chinese; in English, English.
- [ ] Managed preferences on a real MDM profile (`plutil` output): `lockDeployments`,
      `profiles`,
      `autoUpdate`, `updateFeed`.
- [ ] A packaged build starts `electron-updater` (it works only packaged) and the bundle includes it.

### Known caveats to keep in mind

- The Shell environment is installed on the profile origin's top frame in every document of the
  window, including `/plugin-ui/...` opened as a top-level page: that page is same-origin and
  gets `capybaraShell`, like any page of the deployment.
- A same-origin iframe WITHOUT a sandbox could read `parent.capybaraShell`: the preload skips
  iframes, but a same-origin frame can reach its parent's global. The web must keep sandboxing
  frames (core `EMBED_SANDBOX`, `HTML_DOCUMENT_SANDBOX` and the sandbox CSP, no
  `allow-same-origin`); that protection is the web's, not the shell's. The smoke's iframes report
  `undefined` for their own global only.
