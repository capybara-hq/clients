import { describe, expect, test } from "vitest";
import { parseDeepLink } from "../src/deep-link.ts";

describe("parseDeepLink", () => {
  test("auth callback with a code", () => {
    expect(
      parseDeepLink("capybara://auth/callback?code=c1&state=s1&iss=https%3A%2F%2Fx.example"),
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
      ),
    ).toEqual({ kind: "auth", error: "access_denied", state: "s1", iss: "https://x.example" });
  });
  test("auth callback without state or iss, or without code and error, is null", () => {
    expect(parseDeepLink("capybara://auth/callback?code=c&iss=https%3A%2F%2Fx")).toBeNull();
    expect(parseDeepLink("capybara://auth/callback?code=c&state=s")).toBeNull();
    expect(parseDeepLink("capybara://auth/callback?state=s&iss=https%3A%2F%2Fx")).toBeNull();
  });
  test("connect and open", () => {
    expect(parseDeepLink("capybara://connect?url=https%3A%2F%2Fx.example%2Fp")).toEqual({
      kind: "connect",
      address: "https://x.example/p",
    });
    expect(parseDeepLink("capybara://open?url=https%3A%2F%2Fx.example%2Fchat%2F1")).toEqual({
      kind: "open",
      url: "https://x.example/chat/1",
    });
    expect(parseDeepLink("capybara://connect")).toBeNull();
    expect(parseDeepLink("capybara://open?url=")).toBeNull();
  });
  test("foreign scheme, unknown host and garbage are null", () => {
    expect(parseDeepLink("https://auth/callback?code=c&state=s&iss=i")).toBeNull();
    expect(parseDeepLink("capybara://other?url=x")).toBeNull();
    expect(parseDeepLink("capybara://auth/other?code=c&state=s&iss=i")).toBeNull();
    expect(parseDeepLink("nonsense")).toBeNull();
  });
});
