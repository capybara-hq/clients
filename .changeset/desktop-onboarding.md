---
"@capybara-hq/desktop": minor
"@capybara-hq/shell": minor
---

Desktop onboarding: the app now draws its own pre-sign-in pages in a small fixed window (connect
to a platform, sign in through the browser, inline errors) and never shows the deployment's
sign-in page; the main window remembers its size and position; every confirmation is a dialog
the app draws in a separate window the page cannot reach, replacing the OS message boxes.
An expired session or an unreachable platform is shown in the main window itself (sign in again
and return to the page; retry and return when the platform answers).
