---
"@capybara-hq/mobile": patch
---

Managed configuration: an MDM can set `presetUrl` and `lockToPreset` (iOS AppConfig, Android
managed configurations). A lock hides the other platforms without deleting their data and opens
the preset at once. Profile removal no longer strands a profile when the native deletion fails,
and brand app ids allow only letters and digits per segment.
