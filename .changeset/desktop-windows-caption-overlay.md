---
"@capybara-hq/desktop": patch
---

Windows and Linux: the main window has no system title bar or menu bar any more. As on macOS, the
web runs to the window's top edge. The caption buttons are a title bar overlay as high as the top
row (48), drawn in the profile's colors. The shell reports them as a 138 by 48 controls rectangle
at the window's right edge, and re-announces it when the width changes. The app menu's
accelerators still work. The local pages name Windows and Linux monospace and CJK faces, so
they no longer fall back to NSimSun.
