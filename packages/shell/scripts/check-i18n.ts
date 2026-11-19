// Fails when a key exists in one language catalog only. Run: pnpm check:i18n
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const placeholders = (text: string) =>
  [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string))].sort().join(",");

/** Returns one message per key that exists in only one catalog or whose placeholders differ. */
export function checkCatalogs(zh: Record<string, string>, en: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(zh)) if (!(key in en)) problems.push(`"${key}" is missing in en`);
  for (const key of Object.keys(en)) if (!(key in zh)) problems.push(`"${key}" is missing in zh`);
  for (const key of Object.keys(zh)) {
    const other = en[key];
    if (other !== undefined && placeholders(zh[key] as string) !== placeholders(other)) {
      problems.push(`"${key}" has different placeholders in zh and en`);
    }
  }
  return problems;
}

function load(name: string): Record<string, string> {
  const file = fileURLToPath(new URL(`../src/i18n/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkCatalogs(load("zh"), load("en"));
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.log("i18n catalogs are in sync");
}
