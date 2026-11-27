---
"@capybara-hq/mobile": minor
---

The app routes `<scheme>://open?url=<page>` to the visible profile whose origin matches and loads
the page there (other origins, other schemes and non-http(s) URLs are ignored): iOS forwards the
scheme's links from the scene, Android takes `open` links in its main activity. `openExternal@1`
carries `returnScheme`, the brand's scheme.
