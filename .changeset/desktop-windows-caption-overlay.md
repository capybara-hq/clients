---
"@capybara-hq/desktop": patch
---

Windows and Linux: the main window has no system title bar or menu bar any more. As on macOS, the
web runs to the window's top edge. The caption buttons are a title bar overlay as high as the top
row (48). The overlay is see-through, so the web shows under the buttons: the shell's ground, a
paper's corner or a dialog's scrim. Only the symbols take the profile's muted color. The shell
reports the buttons as a 138 by 48 controls rectangle at the window's right edge, and re-announces
it when the width changes. The app menu's accelerators still work. The local pages name Windows
and Linux monospace and CJK faces, so they no longer fall back to NSimSun.
Windows and Linux windows, the taskbar and the tray show the app icon, also in an unpackaged run,
and Windows groups the taskbar buttons under the app's id instead of Electron's.
