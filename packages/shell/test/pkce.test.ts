import { expect, test, vi } from "vitest";
import { createPkceWeb } from "../src/pkce.ts";
import { createPkce } from "../src/pkce-node.ts";

test("RFC 7636 Appendix B vector", () => {
  const bytes = Buffer.from([
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77,
    105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
  ]);
  expect(createPkce(() => bytes)).toEqual({
    verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  });
});

test("random by default: 43 url-safe characters, distinct", () => {
  const a = createPkce();
  expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(createPkce().verifier).not.toBe(a.verifier);
});

test("createPkceWeb: RFC 7636 Appendix B vector with Web Crypto", async () => {
  const bytes = Uint8Array.from([
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77,
    105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
  ]);
  expect(await createPkceWeb(() => bytes)).toEqual({
    verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  });
});

test("createPkceWeb: asks for 32 random bytes by default, works without Buffer", async () => {
  vi.stubGlobal("Buffer", undefined);
  try {
    const a = await createPkceWeb();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await createPkceWeb()).verifier).not.toBe(a.verifier);
  } finally {
    vi.unstubAllGlobals();
  }
});
