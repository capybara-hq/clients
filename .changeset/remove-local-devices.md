---
"@capybara-hq/desktop": minor
"@capybara-hq/shell": minor
---

The desktop no longer connects, shows or manages local devices (maintainer decision 2026-11-23):
local devices are connected only with the `capybara-device` program. Gone: 「连接本机」 and the
`device@2` capability, the tray's device rows and device state in its icon, title and tooltip, the
signed-out page's device note, the device question when removing a platform, the bundled Node and
`@capybara-hq/device` program, and the managed `connectThisMachine` key (now ignored). The sign-out
dialog no longer says the computer stays connected as a device. The shell's meta parser no longer
requires `features.localDevices` or `protocols.device`.
