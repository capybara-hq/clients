import { afterEach, describe, expect, it, vi } from "vitest";
import { printReport, verifySteps } from "../verify.ts";

describe("verifySteps", () => {
  it("--fast runs lint, i18n, brand, typecheck and the tests, in that order", () => {
    expect(verifySteps({ fast: true }).map((s) => s.id)).toEqual([
      "lint",
      "i18n",
      "brand",
      "typecheck",
      "test",
    ]);
  });

  it("without --fast also runs the desktop e2e smoke, last", () => {
    const steps = verifySteps({ fast: false });
    expect(steps.slice(0, -1)).toEqual(verifySteps({ fast: true }));
    expect(steps.at(-1)).toEqual({ id: "e2e", title: "Desktop e2e smoke", cmd: ["pnpm", "e2e"] });
  });
});

describe("printReport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints the JSON contract and fails when a check failed", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = printReport(
      [
        { id: "lint", title: "Lint", status: "pass", detail: "pnpm lint" },
        { id: "test", title: "Tests", status: "fail", detail: "exit 1" },
      ],
      true,
    );
    expect(code).toBe(1);
    const report = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(report.ok).toBe(false);
    expect(report.checks.map((c: { id: string }) => c.id)).toEqual(["lint", "test"]);
  });
});
