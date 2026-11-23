// Decides which of CI's slow jobs a pull request needs, from the files it changes.
// Run: node scripts/ci-plan.ts <base-sha> <head-sha>   (writes the outputs to $GITHUB_OUTPUT)
//
// lint, typecheck, the Linux tests and commitlint always run; they are fast. The macOS tests, the
// desktop e2e smoke and the native iOS and Android suites run only when a file they cover changed.
// A file no rule knows runs everything, and so does a push to main (CI calls this only on PRs).
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Plan = { macosTest: boolean; e2e: boolean; ios: boolean; android: boolean };

const ALL: Plan = { macosTest: true, e2e: true, ios: true, android: true };
const NONE: Plan = { macosTest: false, e2e: false, ios: false, android: false };

/** The slow jobs one changed file needs; first match wins, and an unknown path needs them all. */
export function planForFile(file: string): Plan {
  const rules: [RegExp, Partial<Plan>][] = [
    // Read by people or by the fast jobs only.
    [/\.md$/, {}],
    [/^(docs|scripts|\.changeset)\//, {}],
    [/^LICENSE$|^biome\.json$|^commitlint\.config\.js$|^\.gitignore$/, {}],
    // Every workflow but this one runs elsewhere; a change to CI itself runs everything.
    [/^\.github\/workflows\/ci\.yml$/, ALL],
    [/^\.github\//, {}],
    // The shared shell runs in both apps.
    [/^packages\/shell\//, ALL],
    [/^apps\/desktop\//, { macosTest: true, e2e: true }],
    // Mobile release tooling builds no test target.
    [/^apps\/mobile\/(fastlane|store)\/|^apps\/mobile\/Gemfile(\.lock)?$/, {}],
    [/^apps\/mobile\/ios\//, { ios: true }],
    [/^apps\/mobile\/android\//, { android: true }],
    [/^apps\/mobile\//, { ios: true, android: true }],
  ];
  for (const [pattern, plan] of rules) if (pattern.test(file)) return { ...NONE, ...plan };
  return ALL;
}

/** The union of the files' plans. */
export function planFromFiles(files: string[]): Plan {
  const plan = { ...NONE };
  for (const file of files) {
    const p = planForFile(file);
    for (const key of Object.keys(plan) as (keyof Plan)[]) plan[key] ||= p[key];
  }
  return plan;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("usage: node scripts/ci-plan.ts <base-sha> <head-sha>");
  const files = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const plan = planFromFiles(files);
  console.log(`${files.length} changed files`);
  const lines = [
    `macos_test=${plan.macosTest}`,
    `e2e=${plan.e2e}`,
    `ios=${plan.ios}`,
    `android=${plan.android}`,
  ];
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}
