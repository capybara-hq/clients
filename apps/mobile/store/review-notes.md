# Store review notes (official app)

Text for the App Store Connect "App Review Information" and the Play Console review notes. Spec:
mobile app design section 10.

## Demo access

App Review needs a reachable deployment and a test account. The maintainer supplies both at
submission time (they are never committed here):

- Deployment address: `<demo deployment URL>`
- Test account: `<login>` / `<password>`

Enter the address on the first screen, then sign in with the test account.

## What the app is beyond a website (guideline 4.2)

- Native chrome: a native tab bar and navigation bar drive the deployment's pages, with native
  haptics, menus and safe-area handling.
- Native sign-in: sign-in runs in the system browser sheet and returns to the app through its
  custom URL scheme; the app never sees the password.
- Native share: sharing uses the system share sheet.
- Several deployments (profiles), each with its own isolated session, and managed configuration
  for organizations.
- Links to other sites open in the system browser sheet, never in the app's web view.

## Maintenance notes

- R19: `@capacitor/android` carries a small pnpm patch (`patches/@capacitor__android@8.6.2.patch`)
  so Capacitor's cookie handler does not wipe the default profile's session; guarded by a vitest
  check and an instrumented test. Re-check it on each Capacitor upgrade.
- R24: on Android a 307 redirect onto the login route cannot be blocked; the server still requires
  credentials, so the block is defense in depth.
- Spike rulings: [mobile app design, section 13 and the spike results](https://github.com/capybara-hq/core/blob/main/docs/superpowers/specs/2026-11-20-mobile-app-design.md).
