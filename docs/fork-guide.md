# Fork guide: your own mobile app

Ship the Capybara mobile app under your own name, icon and sign-in scheme. The app is a thin shell
that loads your deployment's web app; a fork changes one brand file and two images, registers its
callback with the deployment, and runs the release workflow with its own signing secrets.

## 1. Fork and set the brand

1. Fork `capybara-hq/clients` and clone it. Work in a branch.
2. Edit `apps/mobile/brand.ts`, the only brand file. Its keys:

   | Key            | Meaning                                                                                                                                                                                          |
   | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `productName`  | The name under the icon. No quotes, backslash, newline, `< > & @ ?`, `//` or `$(`.                                                                                                               |
   | `appId`        | Bundle id (iOS) and application id (Android). Reverse DNS, **letters and digits only**, each segment starting with a letter: App Store Connect rejects `_` and Android rejects `-` (ruling R23). |
   | `scheme`       | The custom URL scheme the sign-in callback returns on (`<scheme>://auth/callback`). Lowercase; not a scheme a browser or the system owns (`http`, `file`, `mailto`, ...).                        |
   | `icon`         | Always `assets/icon.png`: replace that file with a 1024 x 1024 PNG.                                                                                                                              |
   | `splash`       | `image` is always `assets/splash.png` (replace the file); `background.light` and `background.dark` are `#rrggbb` ground colours.                                                                 |
   | `presetUrl`    | A deployment the app opens straight into, or `null`. https only.                                                                                                                                 |
   | `lockToPreset` | `true`: only the preset is usable (needs a `presetUrl`).                                                                                                                                         |

3. Replace `apps/mobile/assets/icon.png` and `apps/mobile/assets/splash.png`.
4. Generate the native identifiers, icon sets and splash, then commit the result:

   ```bash
   pnpm install
   pnpm --filter @capybara-hq/mobile apply-brand
   git add -A && git commit -m "chore(mobile): brand"
   ```

   CI and the release workflow run `pnpm --filter @capybara-hq/mobile check:brand` and fail when
   the generated files drift from `brand.ts`.

## 2. Register the sign-in callback on the deployment

Sign-in returns to the app on `<scheme>://auth/callback`. The deployment accepts only redirect URIs
it knows, matched exactly. Add yours to `auth.appRedirectUris` (the environment variable
`CAPYBARA_AUTH__APP_REDIRECT_URIS`, an array; the default is `["capybara://auth/callback"]`), keeping
the official URI if the same deployment also serves the official app.

## 3. Preset deployment, or managed configuration

- Set `presetUrl` (and `lockToPreset`) in `brand.ts` to build an app bound to your deployment.
- Or leave the brand open and let an MDM set the same two keys, `presetUrl` and `lockToPreset`,
  through iOS AppConfig (`com.apple.configuration.managed`) or Android managed configurations.
  Managed values are untrusted input and are validated the same way as the brand's.

## 4. Signing assets and the release environment

The workflow `.github/workflows/release-mobile.yml` reads its secrets from a GitHub **environment**
named `mobile-release` in the repository that runs it: a fork creates its own.

**Before you add any secret**, restrict the environment: in Settings, Environments, `mobile-release`,
limit deployment branches to `main` and add required reviewers. Any run of the workflow can read the
environment's secrets, so a run from another branch or without review must not be possible.

Create the signing assets, then store them as environment secrets (binary files as base64):

| Secret                      | Platform          | What it is                                                                                         |
| --------------------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `APPLE_API_KEY_ID`          | iOS               | App Store Connect API key id.                                                                      |
| `APPLE_API_ISSUER_ID`       | iOS               | The API key's issuer id.                                                                           |
| `APPLE_API_KEY_P8`          | iOS               | The contents of the API key `.p8` file.                                                            |
| `IOS_DIST_CERT_P12`         | iOS               | Apple Distribution certificate (`.p12`), base64.                                                   |
| `IOS_DIST_CERT_PASSWORD`    | iOS               | The password of that `.p12`.                                                                       |
| `IOS_PROVISIONING_PROFILE`  | iOS               | App Store provisioning profile for your `appId`, base64.                                           |
| `ANDROID_KEYSTORE_BASE64`   | Android           | The release keystore, base64.                                                                      |
| `ANDROID_KEYSTORE_PASSWORD` | Android           | The keystore password (read by the build as `CAPYBARA_KEYSTORE_PASSWORD`).                         |
| `ANDROID_KEY_ALIAS`         | Android           | The signing key alias (`CAPYBARA_KEY_ALIAS`).                                                      |
| `ANDROID_KEY_PASSWORD`      | Android           | The signing key password (`CAPYBARA_KEY_PASSWORD`).                                                |
| `PLAY_SERVICE_ACCOUNT_JSON` | Android, optional | Play Console service account JSON; only when you want the AAB uploaded to the Play internal track. |

Secrets are set only on the steps that use them. Mainland Android stores are never uploaded by the
workflow: submit the signed AAB or APK to them yourself.

## 5. Run the release workflow

In Actions, run "Release mobile" on `main`:

1. First with the defaults (`dry_run` on): it checks the secrets, the brand drift and the fastlane
   lanes, and builds nothing.
2. Then `dry_run` off, `upload` off: builds the signed IPA and the signed APK and AAB as workflow
   artifacts.
3. Then `dry_run` off, `upload` on: also sends the IPA to TestFlight and, when
   `PLAY_SERVICE_ACCOUNT_JSON` is set, the AAB to the Play internal track.

The inputs `ios` and `android` pick the platforms. The build number is the workflow run number.

## Push notifications

Placeholder. The push plan fills this section in: the APNs key, the FCM project and the push plugins
of the channels your build carries on the deployment. See
[the push notifications plan](https://github.com/capybara-hq/core/blob/main/docs/superpowers/plans/2026-11-20-push-notifications.md).

## Maintenance notes

- The Android project carries a pnpm patch of `@capacitor/android`
  (`patches/@capacitor__android@8.6.2.patch`, ruling R19): Capacitor's cookie handler wiped the
  default profile's session cookies even when disabled. A vitest check and an instrumented test
  guard it; re-check the patch on every Capacitor upgrade.
- Android cannot block a 307 redirect onto the login route (ruling R24). The server still requires
  credentials; the block is defense in depth only.
- The app id must stay letters and digits only (R23); `apply-brand` and `check:brand` refuse others.
