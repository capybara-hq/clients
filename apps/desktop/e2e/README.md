# Desktop end-to-end and acceptance

## The automated smoke (`pnpm e2e`)

`smoke.spec.ts` launches the real Electron app through Playwright's `_electron` (no browser is
downloaded) against `packages/shell/test/fixtures/fake-deployment.ts`, a dependency-free fake
deployment. It needs no network and no real sign-in. Run it from the repository root:

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

- The small window's frame origin is `app://local` (read in main), and the local page registry
  accepts its actions, so connect -> meta discovery -> icon -> 在浏览器中登录 -> callback -> the main
  window on `/` works, and the small window closes.
- The deployment page sees `window.capybaraShell` (`kind: desktop`, `platform: macos`, `version: 1`,
  insets `{28,0,0,0}`, controls `{0,0,80,28}`) with `signIn@1`, `notify@1`, `openExternal@1`,
  `chrome@1`; `device@1` appears after discovery (macOS or Linux, `localDevices`, protocol 4 in
  range) without a reload. `executeInMainWorld` works.
- Same-origin and `/plugin-ui/...` iframes do not see `capybaraShell`.
- A `signIn@1` call without a user activation is refused (`no_activation`); a real click opens
  the authorize URL (client, redirect URI, S256 challenge, state) in the (stubbed) system browser.
- The callback deep link (`code`, `state`, `iss`) is exchanged (CSRF header, PKCE S256, one use);
  the cookie lands in the profile's partition and not in the default session; the window reloads
  signed in; a replayed callback sends nothing. `ses.fetch` honours the partition's cookies.
- `POST /api/v1/auth/login` from the window is blocked and never reaches the server.
- The desktop user agent goes to the profile's origin (page, fetch, exchange); a redirect hop to
  another origin gets Chromium's own user agent, and the Shell environment is absent there.
- A `device@1` event subscription returns an unsubscribe function across `contextBridge`, and
  calling it (twice) does not throw.
- The web's own sign-out (`POST /api/v1/auth/logout` seen on the partition, then `/login`) closes
  the main window and shows the small window's signed-out page; the profile stays, signed out.

## Manual acceptance on a real Mac with a dev kernel

Use a Mac with the unsigned or signed build (`pnpm --filter @capybara-hq/desktop dist`), a dev
kernel whose `http.publicUrl` is set, `auth.appRedirectUris` containing `capybara://auth/callback`,
and a version that offers local devices.

### Sign-in and shell

- [ ] First launch opens the small window's connect page; enter the dev kernel's address; Continue
      shows its name and icon.
- [ ] 「在浏览器中登录」 opens the system browser; after approving, the callback returns to the app
      (the first `capybara://` link while the app is not running launches it; `open-url` before
      `ready` is not lost) and the window reloads signed in. Deny returns without signing in.
- [ ] The traffic lights sit at the announced position, and the page's controls rectangle
      (`{0,0,80,28}`) covers them on the built window; in full screen the inset is 0 and
      `controls` is `null`.
- [ ] After sign-in the app window comes forward from behind the browser (macOS may not bring a
      background app forward without `app.focus({ steal: true })`).
- [ ] A signed-in session survives quitting and relaunching. 「移除平台」 (app menu 平台 and the
      tray) asks natively with the platform's name and host (取消 is the default), asks whether
      to disconnect this computer too when it is connected there, closes the platform's windows
      and clears its session; it is not offered under `lockDeployments`.

### Connect this machine

- [ ] 「连接本机」 shows the native confirmation 「允许 <平台名称>（<host>）在这台电脑上运行命令吗？」
      with 「允许」/「取消」; Escape equals cancel (`cancelId` mapping on macOS); the dialog is
      attached to the calling window.
- [ ] After allowing, the device verification page opens in a child window above the main window,
      signed in, and closes with it.
- [ ] `launchctl print gui/$UID/top.capybara.device` shows the service running the bundled node
      (`Contents/Resources/node/node`) and the bundled device, not a system node.
- [ ] Close the window: the device stays online in the web (Devices page).
- [ ] Quit the app (Cmd-Q): the device is still online; reopen the app and it shows connected.
- [ ] Keep-awake: run a long command (`sleep 600`) on the device; in another terminal
      `pmset -g assertions` lists a `PreventUserIdleSystemSleep` assertion from the device; it is
      gone when the command ends (mode `while-busy`); mode `connected` holds it while online.
- [ ] Lid closed on battery: the Mac sleeps (expected), the device goes offline, and after wake it
      reconnects and the conversation shows the note 「电脑曾休眠」.
- [ ] Lid closed on power with keep-awake `connected`: stays online (clamshell rules apply).
- [ ] 断开 in the tray (menu bar icon) stops the service (`launchctl print` no longer finds it)
      and logs the device out on this computer; the device stays registered on the platform until
      someone deletes it. Pause/Resume (暂停 / 恢复) behave.
- [ ] An app update that replaces the bundled device restarts the service at the next start
      (`repairService().then(afterUpdate)`); an app moved to another folder repairs the service
      at the next start.
- [ ] A running app checks for updates every 6 hours; a downloaded update shows one notification,
      and clicking it restarts into the new version.

### Menus, Dock, managed settings

- [ ] The tray icon shows platforms and the actions; the app menu follows the focused platform.
      The Dock icon shows the platform's icon only when exactly one platform is saved and it has
      set an icon (spec §11), else the app's own icon (reverting needs `build/icons/icon.png`).
- [ ] With the system language set to Chinese, every app menu item (including the ones macOS adds,
      such as the window list and the Edit menu's extras) is Chinese; in English, English.
- [ ] Managed preferences on a real MDM profile (`plutil` output): `lockDeployments`,
      `connectThisMachine: false` (no 「连接本机」 and no device section in the tray), `profiles`,
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
