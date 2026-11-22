---
"@capybara-hq/desktop": minor
---

The desktop reads every connection of this computer from `capybara-device status --json` and
follows each connection's control socket at the path the program reports. It bundles
`@capybara-hq/device` 0.1.0-rc.29 (device protocol 6) and builds on `@capybara-hq/plugin-sdk`
0.1.0-rc.57.
