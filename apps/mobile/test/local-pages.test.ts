import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const read = (rel: string) => readFileSync(new URL(`../src/local/${rel}`, import.meta.url), "utf8");

describe("local pages framed over the runtime document", () => {
  test("framed pages use no Capacitor plugin: they talk to the runtime by postMessage (N1)", () => {
    for (const page of ["address/address.ts", "error/error.ts"]) {
      const source = read(page);
      expect(source, page).not.toMatch(/@capacitor\//);
      expect(source, page).not.toMatch(/registerPlugin|Capacitor\./);
    }
  });

  test("the address page has a CSP: local scripts and styles only (M8)", () => {
    const html = read("address/index.html");
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    expect(csp).toBe(
      "default-src 'self'; img-src 'self' https: http://127.0.0.1:* http://localhost:*; style-src 'self'",
    );
    expect(html).not.toMatch(/<script[^>]+src="(https?:)?\/\//);
  });
});
