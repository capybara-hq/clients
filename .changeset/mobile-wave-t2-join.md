---
"@capybara-hq/mobile": patch
---

Sign-in, managed configuration and the Android single store work together: every way a platform
opens (a switch, a managed lock, the launch, a retry) checks whether it can do app sign-in; a
platform hidden by a lock can neither start sign-in nor finish one; switching platforms in the
single store ends the previous page the same way closing it does; the last-resort wipe runs only in
the single store; and on Android a page can no longer forge the outcome of the code exchange.
