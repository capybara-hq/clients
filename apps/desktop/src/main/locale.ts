// The app's language before K8's per-profile choice: the OS locale mapped onto the catalog.
import type { Locale } from "@capybara-hq/shell";

/** `app.getLocale()` → the catalog: zh* is zh, everything else en. */
export function localeFrom(appLocale: string): Locale {
  return appLocale.toLowerCase().startsWith("zh") ? "zh" : "en";
}
