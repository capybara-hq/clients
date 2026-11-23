---
"@capybara-hq/desktop": patch
---

macOS: closing a platform window hides it instead of destroying it, so a Dock click brings the same
window back with its page, scroll and draft (a full-screen window leaves full screen first). Quit,
an update's restart, removing a platform and signing out still close windows for real.
