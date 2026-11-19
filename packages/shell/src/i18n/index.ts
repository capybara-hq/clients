import en from "./en.json" with { type: "json" };
import zh from "./zh.json" with { type: "json" };

export type Locale = "zh" | "en";
export type Catalogs = Record<Locale, Record<string, string>>;

/** Builds a translator over the given catalogs. An unknown key returns the key itself. */
export function createT(catalogs: Catalogs) {
  return (locale: Locale, key: string, vars?: Record<string, string>): string => {
    const catalog = catalogs[locale];
    const text = Object.hasOwn(catalog, key) ? (catalog[key] as string) : key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (m, name: string) =>
      Object.hasOwn(vars, name) ? (vars[name] as string) : m,
    );
  };
}

/** Looks a key up and fills `{name}` placeholders. */
export const t = createT({ zh, en });
