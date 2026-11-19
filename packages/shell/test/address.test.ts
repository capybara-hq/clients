import { describe, expect, test } from "vitest";
import { normalizeAddress } from "../src/address.ts";

describe("normalizeAddress", () => {
  test("adds https when there is no scheme", () => {
    expect(normalizeAddress("capybara.example.com")).toEqual({
      ok: true,
      origin: "https://capybara.example.com",
      base: "https://capybara.example.com",
    });
  });
  test("keeps the port and the path prefix, drops trailing slashes", () => {
    expect(normalizeAddress("https://example.com:8443/capybara/")).toEqual({
      ok: true,
      origin: "https://example.com:8443",
      base: "https://example.com:8443/capybara",
    });
  });
  test("trims whitespace", () => {
    expect(normalizeAddress("  example.com/x  ")).toMatchObject({
      ok: true,
      base: "https://example.com/x",
    });
  });
  test("allows http only on loopback", () => {
    expect(normalizeAddress("http://localhost:3000")).toEqual({
      ok: true,
      origin: "http://localhost:3000",
      base: "http://localhost:3000",
    });
    expect(normalizeAddress("http://127.0.0.1:3000")).toMatchObject({ ok: true });
    expect(normalizeAddress("http://[::1]:3000")).toMatchObject({
      ok: true,
      origin: "http://[::1]:3000",
    });
    expect(normalizeAddress("http://10.0.0.5")).toEqual({ ok: false, reason: "insecure" });
    expect(normalizeAddress("http://example.com")).toEqual({ ok: false, reason: "insecure" });
  });
  test("rejects credentials, other schemes and garbage", () => {
    expect(normalizeAddress("https://user:pw@example.com")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(normalizeAddress("ftp://example.com")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeAddress("")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeAddress("https://")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeAddress("not a url")).toEqual({ ok: false, reason: "invalid" });
  });
  test("drops the query and the fragment (documented choice)", () => {
    expect(normalizeAddress("https://example.com/p?x=1#frag")).toEqual({
      ok: true,
      origin: "https://example.com",
      base: "https://example.com/p",
    });
  });
});
