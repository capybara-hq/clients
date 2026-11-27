---
"@capybara-hq/desktop": minor
---

A deployment window never leaves its deployment's origin: a navigation or server redirect of the
window to another origin is stopped and an http or https target opens in the system browser, so
connector OAuth and login linking finish there. `openExternal@1` carries `returnScheme`, the app's
own URL scheme (capability data fields now reach the page on the desktop too).
