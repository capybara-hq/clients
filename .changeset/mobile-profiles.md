---
"@capybara-hq/mobile": minor
---

Several platforms, each in its own WebView data store: iOS gives each its own website data store,
Android a WebView profile where the system WebView supports profiles, else one platform at a
time, asking before a switch signs out of the current one. A removed platform's store is deleted
once its WebView is gone (iOS) or at the next app start (Android).
