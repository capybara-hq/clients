---
"@capybara-hq/mobile": minor
---

Brand push fields: `brand.ts` gains an optional `push` field (`apns` with its environment, `fcm`
with `android/app/google-services.json`, `aggregator` with the JPush AppKey). `apply-brand` writes
the APNs entitlement settings into `Brand.xcconfig` and the FCM and JPush switches into
`brand.properties`, and `check:brand` fails when they or `Push.entitlements` disagree with the
brand. The release workflow writes an FCM brand's `google-services.json` from
`MOBILE_GOOGLE_SERVICES_JSON` at build time, and the fork guide's push section covers the
credentials, the brand, the secret and the deployment's push plugins. The official brand carries no
push.
