---
"@capybara-hq/mobile": patch
---

iPhone Duo: native strip navigation through `nav@1`. While the window has a strip (outer and inner
display) the profile WebView sits under a vertical system tab bar with the web's sections and a
menu button at the top of the strip; elsewhere, and on Android, `nav@1` is never offered.
