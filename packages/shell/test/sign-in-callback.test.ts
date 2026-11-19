import { describe, expect, test } from "vitest";
import { checkCallback } from "../src/sign-in-callback.ts";

const pending = { state: "s1", base: "https://x.example/p/", createdAt: 1_000_000 };
const cb = { kind: "auth" as const, code: "c", state: "s1", iss: "https://x.example/p" };
const min = 60 * 1000;

describe("checkCallback", () => {
  test("ok, ignoring trailing slashes on both sides", () => {
    expect(checkCallback(cb, pending, pending.createdAt + 1)).toBe("ok");
    expect(checkCallback({ ...cb, iss: "https://x.example/p/" }, pending, pending.createdAt)).toBe(
      "ok",
    );
  });
  test("unknown_state", () => {
    expect(checkCallback({ ...cb, state: "other" }, pending, pending.createdAt)).toBe(
      "unknown_state",
    );
  });
  test("wrong_issuer", () => {
    expect(
      checkCallback({ ...cb, iss: "https://evil.example/p" }, pending, pending.createdAt),
    ).toBe("wrong_issuer");
  });
  test("expired after 10 minutes, not at exactly 10", () => {
    expect(checkCallback(cb, pending, pending.createdAt + 10 * min)).toBe("ok");
    expect(checkCallback(cb, pending, pending.createdAt + 10 * min + 1)).toBe("expired");
  });
  test("order: state, then expiry, then issuer", () => {
    const late = pending.createdAt + 11 * min;
    expect(checkCallback({ ...cb, state: "x", iss: "https://evil" }, pending, late)).toBe(
      "unknown_state",
    );
    expect(checkCallback({ ...cb, iss: "https://evil" }, pending, late)).toBe("expired");
  });
});
