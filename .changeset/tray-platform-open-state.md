---
"@capybara-hq/desktop": patch
"@capybara-hq/shell": patch
---

The tray and the 「平台」 menu no longer check the last-used platform as if only one were in use:
each platform is a plain item, and one with an open window reads "Example • 已打开" / "Example •
Open". The menus rebuild when a platform window opens or closes.
