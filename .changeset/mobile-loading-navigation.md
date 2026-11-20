---
"@capybara-hq/mobile": patch
---

Loading, navigation, splash and the error state: the runtime opens the current profile with its
stored appearance applied first; every navigation passes one policy (vitest, Swift and Kotlin share
its vectors), so other origins and new windows open in the browser sheet and never in a profile
WebView; `chrome@1` sets the native background and status bar and drops the splash on `ready()`;
an unreachable or insecure deployment shows a local error page with retry and the profile switcher;
Android shows a native unsupported state on WebViews without the gate features, recreates a dead
render process and goes back through history. A document's end now cancels its calls and frees the
dialog slot, and a new document gets the current state.
