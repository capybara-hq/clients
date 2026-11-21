---
"@capybara-hq/mobile": minor
"@capybara-hq/shell": minor
---

Push notifications, the shell side: a build whose brand carries push offers `push@1` (`status`,
`register`, `registered`, `unregister`) on the profiles whose deployment lists its app id under
`features.push` (on Android only when the build has a channel this phone can use: FCM needs Google
Play services); a push in the foreground shows as a banner unless its page is on screen or its
origin is no profile's, a tapped push opens its profile (exact origin) on its path, and removing a
profile deletes its registration on the deployment first. The official build carries no push and
never offers `push@1`. The iOS (APNs) and Android (FCM, JPush) native modules ship alongside. The SDK types are `@capybara-hq/plugin-sdk` 0.1.0-rc.46.
