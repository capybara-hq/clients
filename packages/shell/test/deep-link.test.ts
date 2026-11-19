import { describe, expect, test } from "vitest";
import { parseDeepLink } from "../src/deep-link.ts";

describe("parseDeepLink", () => {
  test("auth callback with a code", () => {
    expect(
      parseDeepLink(
        "capybara://auth/callback?code=c1&state=s1&iss=https%3A%2F%2Fx.example",
        "capybara",
      ),
    ).toEqual({
      kind: "auth",
      code: "c1",
      state: "s1",
      iss: "https://x.example",
    });
  });
  test("deny callback", () => {
    expect(
      parseDeepLink(
        "capybara://auth/callback?error=access_denied&state=s1&iss=https%3A%2F%2Fx.example",
        "capybara",
      ),
    ).toEqual({ kind: "auth", error: "access_denied", state: "s1", iss: "https://x.example" });
  });
  test("auth callback without state or iss, or without code and error, is null", () => {
    expect(
      parseDeepLink("capybara://auth/callback?code=c&iss=https%3A%2F%2Fx", "capybara"),
    ).toBeNull();
    expect(parseDeepLink("capybara://auth/callback?code=c&state=s", "capybara")).toBeNull();
    expect(
      parseDeepLink("capybara://auth/callback?state=s&iss=https%3A%2F%2Fx", "capybara"),
    ).toBeNull();
  });
  test("connect and open", () => {
    expect(parseDeepLink("capybara://connect?url=https%3A%2F%2Fx.example%2Fp", "capybara")).toEqual(
      {
        kind: "connect",
        address: "https://x.example/p",
      },
    );
    expect(
      parseDeepLink("capybara://open?url=https%3A%2F%2Fx.example%2Fchat%2F1", "capybara"),
    ).toEqual({
      kind: "open",
      url: "https://x.example/chat/1",
    });
    expect(parseDeepLink("capybara://connect", "capybara")).toBeNull();
    expect(parseDeepLink("capybara://open?url=", "capybara")).toBeNull();
  });
  test("host matching is case-insensitive", () => {
    expect(
      parseDeepLink("capybara://AUTH/callback?code=c&state=s&iss=i", "capybara"),
    ).toMatchObject({
      kind: "auth",
    });
    expect(parseDeepLink("CAPYBARA://Connect?url=x", "capybara")).toEqual({
      kind: "connect",
      address: "x",
    });
  });
  test("error wins when code and error are both present", () => {
    expect(
      parseDeepLink(
        "capybara://auth/callback?code=c&error=access_denied&state=s&iss=i",
        "capybara",
      ),
    ).toEqual({
      kind: "auth",
      error: "access_denied",
      state: "s",
      iss: "i",
    });
  });
  test("the scheme is the caller's (a fork's brand scheme)", () => {
    expect(parseDeepLink("acme://connect?url=x", "acme")).toEqual({
      kind: "connect",
      address: "x",
    });
    expect(parseDeepLink("capybara://connect?url=x", "acme")).toBeNull();
    expect(parseDeepLink("acme://connect?url=x", "capybara")).toBeNull();
  });
  test("foreign scheme, unknown host and garbage are null", () => {
    expect(parseDeepLink("https://auth/callback?code=c&state=s&iss=i", "capybara")).toBeNull();
    expect(parseDeepLink("capybara://other?url=x", "capybara")).toBeNull();
    expect(parseDeepLink("capybara://auth/other?code=c&state=s&iss=i", "capybara")).toBeNull();
    expect(parseDeepLink("nonsense", "capybara")).toBeNull();
  });
});
