---
"@capybara-hq/mobile": minor
"@capybara-hq/shell": minor
---

Push notifications, the shell side: a build whose brand carries push offers `push@1` (`status`,
`register`, `registered`, `unregister`) on the profiles whose deployment lists its app id under
`features.push`; a push in the foreground shows as a banner unless its page is on screen, a tapped
push opens its profile (exact origin) on its path, and removing a profile deletes its registration
on the deployment first. The official build carries no push and never offers `push@1`; the native
modules come next. The SDK types are `@capybara-hq/plugin-sdk` 0.1.0-rc.46.
