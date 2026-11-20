import { describe, expect, test, vi } from "vitest";
import { createAppProtocolHandler, LOCAL_CSP } from "../src/main/app-protocol.ts";
import { localPageUrl } from "../src/shared/protocol.ts";

describe("app://local", () => {
  const files: Record<string, string> = {
    "/dist/local/onboarding.html": "<html></html>",
    "/dist/local/onboarding.js": "void 0",
    "/dist/local/base.css": "body{}",
  };
  const readFile = vi.fn(async (p: string) => {
    const v = files[p];
    if (v === undefined) throw new Error("ENOENT");
    return Buffer.from(v);
  });
  const handle = createAppProtocolHandler({ localDir: "/dist/local", readFile });

  test("serves flat page files with types and the local CSP", async () => {
    for (const [url, type] of [
      [localPageUrl("onboarding"), "text/html"],
      ["app://local/onboarding.js", "text/javascript"],
      ["app://local/base.css", "text/css"],
    ]) {
      const res = await handle({ url: url as string });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type as string);
      expect(res.headers.get("content-security-policy")).toBe(LOCAL_CSP);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(localPageUrl("onboarding")).toBe("app://local/onboarding.html");
    expect(LOCAL_CSP).toContain("default-src 'none'");
    expect(LOCAL_CSP).toContain("script-src 'self'");
    expect(LOCAL_CSP).toContain("style-src 'self' 'unsafe-inline'");
    expect(LOCAL_CSP).toContain("img-src 'self' data:");
    expect(LOCAL_CSP).not.toContain("connect-src");
  });

  test("anything else is 404 and never reads outside the directory", async () => {
    readFile.mockClear();
    for (const url of [
      "app://local/../main/index.cjs",
      "app://local/%2e%2e/main/index.cjs",
      "app://local/..%2fmain%2findex.cjs",
      "app://local/sub/onboarding.html",
      "app://local/onboarding.js.map",
      "app://local/Onboarding.html",
      "app://local/.hidden.js",
      "app://local/",
      "app://local/missing.html",
      "app://other/onboarding.html",
    ]) {
      expect((await handle({ url })).status, url).toBe(404);
    }
    for (const call of readFile.mock.calls)
      expect(String(call[0])).toMatch(/^\/dist\/local\/[a-z0-9-]+\.(html|css|js)$/);
  });
});
