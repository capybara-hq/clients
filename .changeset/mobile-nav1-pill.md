---
"@capybara-hq/mobile": minor
"@capybara-hq/shell": minor
---

The iPhone Duo strip takes the nav@1 minor version of 2026-11-22 (core phase 0b; ships with or
before the web that sends it, no older shape): `set({ items, current, action, account? })`, the
pill's top item is the page's action drawn accent-filled with the shell's own glyph (`plus` or
`square-pen`, the accent from chrome@1's tokens), then 对话 / 收件箱 / 智能体 / 定时任务 and 搜索;
the account avatar sits under the status (the image when it loads, else the initial, with a
badge). `onAction` and `onAccount` join `onSelect` (also for search); `onMenu` and the strip's
menu button are gone. `current: null` clears the highlight. The capability object reports the
strip's `side` (left only for the left app of an inner-display split), updated with `change`;
the shell's installer carries such data fields on a capability object. Strict validation: `menu`,
unknown keys, bad ids, labels, icons, counts, `current: "search"` and avatars that are not https
(or plain http on the profile's origin) reject the whole call. Android still offers no nav@1.
