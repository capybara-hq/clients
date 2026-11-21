import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { brand } from "../brand.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const guide = await readFile(`${repo}docs/fork-guide.md`, "utf8");
const workflow = await readFile(`${repo}.github/workflows/release-mobile.yml`, "utf8");

describe("the fork guide", () => {
  test("names every secret the release workflow reads", () => {
    const secrets = new Set([...workflow.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
    expect(secrets.size).toBeGreaterThan(0);
    for (const name of secrets) expect(guide, name).toContain(name);
  });

  test("names every key of the brand", () => {
    for (const key of Object.keys(brand)) expect(guide, key).toContain(key);
  });

  test("covers the release environment and the redirect registration", () => {
    expect(guide).toContain("mobile-release");
    expect(guide).toContain("CAPYBARA_AUTH__APP_REDIRECT_URIS");
    expect(guide).toContain("auth.appRedirectUris");
    expect(guide).toContain("## Push notifications");
  });
});
