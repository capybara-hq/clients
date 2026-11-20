---
"@capybara-hq/mobile": patch
---

The origin gate and the capability runtime: profile WebViews (their own data store or named
profile, never Capacitor's WebView) inject the Shell environment script into the profile origin's
top document only and accept a post only from the main frame on exactly the profile origin; every
other frame or origin is dropped with a "denied" reply. Calls run in a TypeScript registry that
re-checks the origin and gates user activation and one dialog per profile. Popups never get a
WebView, and Android WebViews without the document-start script, message listener and profiles
load no deployment.
