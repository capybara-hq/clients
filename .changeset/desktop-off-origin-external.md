---
"@capybara-hq/desktop": minor
---

A deployment window never leaves its deployment's origin on a navigation the page starts: a
navigation or server redirect to another origin is stopped and an http or https target opens in
the system browser, so connector OAuth and login linking finish there. The app's own loads still
follow redirects (a deployment behind an identity-aware proxy). `openExternal@1` carries `returnScheme`, the app's
own URL scheme (capability data fields now reach the page on the desktop too).
