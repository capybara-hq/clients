---
"@capybara-hq/mobile": patch
---

Wire the address page and the capabilities into the runtime: the app starts on the address page or
the current profile, the framed address page discovers and adds a deployment through the runtime
over its own port, and profiles get chrome@1, haptics@1, share@1, menu@1 and openExternal@1.
