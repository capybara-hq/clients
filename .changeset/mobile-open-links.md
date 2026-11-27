---
"@capybara-hq/mobile": minor
---

The app routes `<scheme>://open?url=<page>` to the visible profile whose origin matches (the
longest matching base on a shared origin) and loads the page there; other origins, other schemes
and non-http(s) URLs are ignored, and only the last link received opens. iOS takes `open` links
from the scene, Android in its main activity. `openExternal@1`
carries `returnScheme`, the brand's scheme.
