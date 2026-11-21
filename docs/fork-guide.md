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
   | `push`         | Optional: the push channels the build carries. Leave it out for none; see [Push notifications](#push-notifications).                                                                             |

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

The official app carries no push channel and never offers notifications. A fork turns on the
channels it wants in `brand.ts`; each channel also needs its push plugin set up on the deployment.
The channels are APNs (iOS, plugin `push-apns`), FCM (Android with Google Play services,
`push-fcm`) and JPush (Android without Play services, mainland China, `push-jpush`). An Android
build may carry both: the app registers with FCM where Play services work and with JPush otherwise.

### 1. Create the credentials

- **APNs:** in the Apple Developer account, turn on Push Notifications for the App ID of your
  `appId` and regenerate the App Store provisioning profile (`IOS_PROVISIONING_PROFILE`) so it
  includes it. Create an APNs key (Keys, Apple Push Notifications service): download the `.p8`
  file once and note its Key ID and your Team ID.
- **FCM:** create a Firebase project and add an Android app whose package name is your `appId`.
  Download its `google-services.json`. Then, in Project settings, Service accounts, generate a
  private key: a service account allowed to send through Firebase Cloud Messaging (FCM HTTP v1).
- **JPush:** create an app in the JPush console (极光推送) with your `appId` as the package name and
  note its AppKey and Master Secret.

### 2. Set the brand's `push` field

Add only the channels the build carries:

```ts
push: {
  apns: { environment: "production" },
  fcm: { googleServicesFile: "android/app/google-services.json" },
  aggregator: { appKey: "<your JPush AppKey>" },
},
```

| Key          | Meaning                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apns`       | APNs. `environment` is `production` for TestFlight and App Store builds (what the release workflow builds) or `sandbox` for development builds run from Xcode.                |
| `fcm`        | FCM. `googleServicesFile` is always `android/app/google-services.json`: put the file there for local builds. It is git-ignored; the release workflow writes it from a secret. |
| `aggregator` | JPush. `appKey` is the JPush AppKey. It ships inside the APK, so it is not a secret and lives in `brand.ts`.                                                                  |

Run `pnpm --filter @capybara-hq/mobile apply-brand` and commit. It writes `BRAND_APS_ENVIRONMENT`
and the device builds' entitlements file (`Push.entitlements`) into `ios/App/Brand.xcconfig`, and
the switches `pushFcm=true` and `jpushAppKey` into `android/brand.properties`; a channel without
its switch is not compiled into the app at all. `check:brand` fails when these disagree with
`brand.ts`.

### 3. Store the build secret

| Secret                        | Platform            | What it is                                                       |
| ----------------------------- | ------------------- | ---------------------------------------------------------------- |
| `MOBILE_GOOGLE_SERVICES_JSON` | Android, FCM brands | The contents of `google-services.json` (plain JSON, not base64). |

Add it to the `mobile-release` environment like the signing secrets. The release workflow fails
early when the brand carries FCM and the secret is empty, and writes the file only just before the
Android build. APNs and JPush need no build secret. The `.p8` key, the service account key and the
JPush Master Secret never go into the repository or the workflow: they belong to the deployment.

### 4. Set up the deployment

As super admin:

1. Import `push-apns`, `push-fcm` and `push-jpush` from the official marketplace, whichever your
   build carries, and enable them.
2. Fill each one's deployment config on its extension page:
   - `push-apns`: the `.p8` key (its full text), the Key ID, the Team ID, and under bundles your
     `appId` with the environment of the build (`production` for TestFlight and App Store builds).
   - `push-fcm`: the service account key file (JSON) and your `appId` among the application ids.
   - `push-jpush`: the AppKey, the Master Secret and your `appId` among the application ids.
3. Run each plugin's credential check from its setup guide on the extension page
   (`apns-credentials`, `fcm-credentials`, `jpush-credentials`). None of them delivers anything.
4. Confirm that `GET /api/v1/meta` lists your `appId` under `features.push` with the providers your
   build carries. Only then does the app offer notifications for that deployment.

A push carries the agent's name and a fixed sentence; it passes through Apple, Google or JPush.
Set `push.previews` to `titles` (`CAPYBARA_PUSH__PREVIEWS`) only if conversation titles may leave
the deployment that way; message and tool text are never sent.

### JPush vendor channels

This version does not wire JPush's vendor channels (Huawei, Honor, Xiaomi, OPPO, vivo; ruling R19).
A JPush build delivers over JPush's own connection only, which these phones often close while the
app is in the background, so notifications may arrive late or only when the app is opened. Adding
the vendor channels is a follow-up that needs vendor developer accounts. A fork that wants them
would need, per vendor: a developer account and a push-enabled app for the same `appId` (Huawei and
Honor: their app ids, Huawei's `agconnect-services.json`; Xiaomi, OPPO, vivo: their app id, key and
secret), JPush's vendor plugin SDKs compiled into the Android build with those ids, the vendor
credentials entered in the JPush console, and, for the service (non-marketing) classification, the
vendor fields in the `push-jpush` deployment config.

## Maintenance notes

- The Android project carries a pnpm patch of `@capacitor/android`
  (`patches/@capacitor__android@8.6.2.patch`, ruling R19): Capacitor's cookie handler wiped the
  default profile's session cookies even when disabled. A vitest check and an instrumented test
  guard it; re-check the patch on every Capacitor upgrade.
- Android cannot block a 307 redirect onto the login route (ruling R24). The server still requires
  credentials; the block is defense in depth only.
- The app id must stay letters and digits only (R23); `apply-brand` and `check:brand` refuse others.
