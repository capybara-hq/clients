---
"@capybara-hq/mobile": minor
"@capybara-hq/shell": patch
---

Sign in through the system browser: Safari (`ASWebAuthenticationSession`) on iOS and Custom Tabs on
Android, with the code exchanged from the platform's own page so the session stays in that
platform's data store. Sign-in inside the app's page is blocked, and a platform too old for app
sign-in shows its own error state.
