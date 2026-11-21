import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const raw = await readFile(`${repo}.github/workflows/release-mobile.yml`, "utf8");

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = { "runs-on": string; steps: Step[]; env?: Record<string, string>; environment?: string };
const workflow = parse(raw) as {
  on: Record<string, { inputs?: Record<string, { type?: string; default?: unknown }> }>;
  permissions: unknown;
  jobs: Record<string, Job>;
};
const jobs = Object.values(workflow.jobs);
const steps = jobs.flatMap((job) => job.steps);
const stepsOf = (job: Job) =>
  job.steps.map((s) => `${s.name ?? ""} ${s.uses ?? ""} ${s.run ?? ""}`);

const IOS_SECRETS = [
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER_ID",
  "APPLE_API_KEY_P8",
  "IOS_DIST_CERT_P12",
  "IOS_DIST_CERT_PASSWORD",
  "IOS_PROVISIONING_PROFILE",
];

describe("the mobile release workflow", () => {
  test("runs only on workflow_dispatch, with no default token permissions", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({});
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
    expect(Object.keys(inputs).sort()).toEqual(["android", "dry_run", "ios", "upload"]);
    expect(inputs.upload?.default).toBe(false);
    expect(inputs.dry_run?.default).toBe(true);
    for (const input of Object.values(inputs)) expect(input.type).toBe("boolean");
  });

  test("pins every action to a 40-hex commit SHA", () => {
    const uses = steps.map((s) => s.uses).filter((u): u is string => Boolean(u));
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  test("the iOS job runs on macOS and first fails listing the missing secrets", () => {
    const ios = workflow.jobs.ios;
    expect(ios?.["runs-on"]).toMatch(/^macos-/);
    const first = ios?.steps[0];
    expect(first?.run).toBeDefined();
    for (const name of IOS_SECRETS) {
      expect(ios?.env?.[name] ?? first?.run).toBeDefined();
      expect(raw).toContain(`secrets.${name}`);
      expect(first?.run).toContain(name);
    }
    expect(first?.run).toMatch(/exit 1/);
    expect(first?.run).toMatch(/::error/);
  });

  test("the Play upload needs inputs.upload and the service account; otherwise a notice", () => {
    const upload = steps.find((s) => /internal/.test(s.run ?? "") && /fastlane/.test(s.run ?? ""));
    expect(upload?.if).toContain("inputs.upload");
    expect(upload?.if).toContain("PLAY_SERVICE_ACCOUNT_JSON");
    const notice = steps.find((s) => /::notice/.test(s.run ?? ""));
    expect(notice?.run).toMatch(/AAB/);
    expect(notice?.run).toMatch(/APK/);
    expect(notice?.if).toContain("PLAY_SERVICE_ACCOUNT_JSON");
  });

  test("no run script mentions a secrets expression", () => {
    for (const step of steps) expect(step.run ?? "").not.toMatch(/secrets\./);
    expect(raw).not.toMatch(/echo[^\n]*\$\{\{\s*secrets\./);
  });

  test("secrets are set only on the steps that need them, never on a job or an action step", () => {
    for (const job of jobs) {
      for (const value of Object.values(job.env ?? {}))
        expect(String(value)).not.toMatch(/secrets\./);
    }
    for (const step of steps) {
      const secretEnv = Object.values(step.env ?? {}).some((v) => /secrets\./.test(String(v)));
      if (step.uses) expect(secretEnv, String(step.uses)).toBe(false);
      if (/pnpm install|cap sync|pnpm .*build/.test(step.run ?? "")) expect(secretEnv).toBe(false);
    }
    const usingSecrets = steps.filter((s) =>
      Object.values(s.env ?? {}).some((v) => /secrets\./.test(String(v))),
    );
    expect(usingSecrets.length).toBeGreaterThan(0);
  });

  test("exports the application id from the generated brand files before building", () => {
    for (const job of jobs) {
      const text = stepsOf(job);
      const idStep = text.findIndex(
        (t) => t.includes("CAPYBARA_APP_ID") && t.includes("brand.properties"),
      );
      const build = text.findIndex((t) => /fastlane (ios|android) /.test(t));
      expect(idStep).toBeGreaterThanOrEqual(0);
      expect(build).toBeGreaterThan(idStep);
    }
  });

  test("jobs read secrets from a deployment environment", () => {
    for (const job of jobs) expect(job.environment).toBe("mobile-release");
  });

  test("checks the brand file before building", () => {
    for (const job of jobs) {
      const text = stepsOf(job);
      const check = text.findIndex((t) => t.includes("check:brand"));
      const build = text.findIndex((t) => /fastlane (ios|android)/.test(t));
      expect(check).toBeGreaterThanOrEqual(0);
      expect(build).toBeGreaterThan(check);
    }
  });

  test("build numbers come from github.run_number", () => {
    expect(raw).toContain("github.run_number");
    expect(raw).toMatch(/BUILD_NUMBER:\s*\$\{\{\s*github\.run_number/);
  });

  test("uploads the IPA, the APK and the AAB as artifacts", () => {
    const paths = steps
      .filter((s) => s.uses?.startsWith("actions/upload-artifact@"))
      .map((s) => String(s.with?.path ?? ""))
      .join("\n");
    expect(paths).toMatch(/\.ipa/);
    expect(paths).toMatch(/\.apk/);
    expect(paths).toMatch(/\.aab/);
  });
});

describe("the fastlane lanes", () => {
  test("take the application id from the brand and sign through the project settings", async () => {
    const fastfile = await readFile(`${repo}apps/mobile/fastlane/Fastfile`, "utf8");
    const appfile = await readFile(`${repo}apps/mobile/fastlane/Appfile`, "utf8");
    expect(fastfile).not.toContain("com.capybarahq.mobile");
    expect(appfile).not.toContain("com.capybarahq.mobile");
    expect(fastfile).toContain("brand.properties");
    expect(fastfile).toContain("update_code_signing_settings");
    expect(fastfile).not.toMatch(/xcargs:[^\n]*(CODE_SIGN|PROVISIONING|DEVELOPMENT_TEAM)/);
  });

  test("define the three lanes", async () => {
    const fastfile = await readFile(`${repo}apps/mobile/fastlane/Fastfile`, "utf8");
    expect(fastfile).toMatch(/platform :ios/);
    expect(fastfile).toMatch(/lane :beta/);
    for (const action of [
      "setup_ci",
      "app_store_connect_api_key",
      "build_app",
      "upload_to_testflight",
    ]) {
      expect(fastfile).toContain(action);
    }
    expect(fastfile).toMatch(/platform :android/);
    expect(fastfile).toMatch(/lane :release/);
    expect(fastfile).toContain("assembleRelease");
    expect(fastfile).toContain("bundleRelease");
    expect(fastfile).toMatch(/lane :internal/);
    expect(fastfile).toMatch(/upload_to_play_store\([^)]*track: "internal"/s);
  });
});
