// Runs the local checks before pushing. Run: pnpm verify [--fast] [--json]
//
// --fast is the quick local check: lint, the i18n and brand checks, typecheck and the vitest
// tests (no containers here, so all of them). Without --fast it also runs the desktop e2e smoke.
// The native iOS and Android tests run only in CI, which is the merge gate.
// --json prints only the report on stdout: { ok, checks: [{ id, title, status, detail, fix? }] },
// the contract the shared contributing skill reads.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type VerifyStep = { id: string; title: string; cmd: string[] };
export type Check = { id: string; title: string; status: "pass" | "fail"; detail: string };

/** The steps in run order: the quick ones always, the desktop e2e smoke only without --fast. */
export function verifySteps(opts: { fast: boolean }): VerifyStep[] {
  const steps: VerifyStep[] = [
    { id: "lint", title: "Lint", cmd: ["pnpm", "lint"] },
    { id: "i18n", title: "i18n catalogs", cmd: ["pnpm", "check:i18n"] },
    {
      id: "brand",
      title: "Mobile brand",
      cmd: ["pnpm", "--filter", "@capybara-hq/mobile", "check:brand"],
    },
    { id: "typecheck", title: "Typecheck", cmd: ["pnpm", "typecheck"] },
    { id: "test", title: "Tests", cmd: ["pnpm", "test"] },
  ];
  if (!opts.fast) steps.push({ id: "e2e", title: "Desktop e2e smoke", cmd: ["pnpm", "e2e"] });
  return steps;
}

/** The report: one line per check, or the JSON contract; returns the exit code. */
export function printReport(checks: Check[], json: boolean): number {
  const ok = checks.every((c) => c.status !== "fail");
  if (json) console.log(JSON.stringify({ ok, checks }, null, 2));
  else {
    for (const c of checks) {
      const detail = c.status === "fail" ? `\n${c.detail}` : ` (${c.detail})`;
      console.log(`${c.status.toUpperCase()} ${c.title}${detail}`);
    }
    const failed = checks.filter((c) => c.status === "fail").length;
    console.log(`\n${ok ? "OK" : "NOT OK"}: ${checks.length - failed} passed, ${failed} failed`);
  }
  return ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes("--json");
  const fast = process.argv.includes("--fast");
  const root = fileURLToPath(new URL("..", import.meta.url));
  // In --json mode stdout carries only the report; progress goes to stderr.
  const say = (s: string) => (json ? console.error(s) : console.log(s));
  const checks: Check[] = [];
  for (const step of verifySteps({ fast })) {
    say(`\n==> ${step.title}: ${step.cmd.join(" ")}`);
    const [cmd, ...args] = step.cmd as [string, ...string[]];
    const r = spawnSync(cmd, args, {
      cwd: root,
      encoding: "utf8",
      stdio: json ? "pipe" : "inherit",
      maxBuffer: 256 * 1024 * 1024,
    });
    const ok = r.status === 0;
    const tail = json
      ? `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n").slice(-20).join("\n")
      : "";
    checks.push({
      id: step.id,
      title: step.title,
      status: ok ? "pass" : "fail",
      detail: ok ? step.cmd.join(" ") : `exit ${r.status ?? "signal"}${tail ? `\n${tail}` : ""}`,
    });
  }
  if (fast) {
    say("\nfast check only; run the tests of the files you changed, CI runs the native tests");
  }
  say("");
  process.exitCode = printReport(checks, json);
}
