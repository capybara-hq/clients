---
"@capybara-hq/desktop": patch
---

The desktop bundles `@capybara-hq/device` 0.1.0-rc.30 (device protocol 6) and builds on
`@capybara-hq/plugin-sdk` 0.1.0-rc.58. The device program now matches a UUID connection selector
to a device id only, so the desktop no longer refuses an id that another connection's name or host
equals.
