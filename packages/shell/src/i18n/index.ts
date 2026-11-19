import en from "./en.json" with { type: "json" };
import zh from "./zh.json" with { type: "json" };

export type Locale = "zh" | "en";

const catalogs: Record<Locale, Record<string, string>> = { zh, en };

/** Looks a key up and fills `{name}` placeholders. An unknown key returns the key itself. */
export function t(locale: Locale, key: string, vars?: Record<string, string>): string {
  const text = catalogs[locale][key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);
}
