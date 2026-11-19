import { describe, expect, test } from "vitest";
import {
  DESKTOP_PRODUCT,
  desktopUserAgent,
  installDesktopUserAgent,
  machineNameFrom,
} from "../src/main/user-agent.ts";
import { fakeSession } from "./fakes.ts";

const UA = "Capybara Desktop/0.1.0 (Grants-MacBook)";

describe("desktopUserAgent", () => {
  test("names the app, its version and the machine", () => {
    expect(DESKTOP_PRODUCT).toBe("Capybara Desktop");
    expect(desktopUserAgent("0.1.0", "Grants-MacBook.local")).toBe(UA);
  });

  test("uses the sign-in name's sanitising (printable, no .local, at most 64)", () => {
    const long = "m".repeat(80);
    expect(desktopUserAgent("0.1.0", `\u0007${long}`)).toBe(
      `Capybara Desktop/0.1.0 (${"m".repeat(64)})`,
    );
    expect(desktopUserAgent("0.1.0", "  ")).toBe("Capybara Desktop/0.1.0 (Desktop)");
    expect(machineNameFrom("Box.local")).toBe("Box");
  });

  test("stays a valid header value: non-ASCII and parentheses are percent-encoded", () => {
    const ua = desktopUserAgent("0.1.0\u0000", "我的(Mac)");
    expect(ua).toBe("Capybara Desktop/0.1.0 (%E6%88%91%E7%9A%84%28Mac%29)");
    expect(desktopUserAgent("0.1.0", "100%box")).toBe("Capybara Desktop/0.1.0 (100%25box)");
    // A Fetch Headers value must be a ByteString; this one is plain ASCII.
    expect(() => new Headers({ "User-Agent": ua })).not.toThrow();
  });
});

describe("installDesktopUserAgent", () => {
  function setup(origin = "https://capybara.example.com") {
    const ses = fakeSession();
    installDesktopUserAgent(ses, origin, UA);
    return ses;
  }

  test("registers one onBeforeSendHeaders listener", () => {
    const ses = setup();
    expect(ses.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
  });

  test("sets the header on requests to the profile origin, any path (path-prefix bases)", () => {
    const ses = setup();
    const chromium = { "User-Agent": "Mozilla/5.0 Chrome/140", Accept: "*/*" };
    expect(ses.beforeSendHeaders("https://capybara.example.com/team/api/v1/me", chromium)).toEqual({
      "User-Agent": UA,
      Accept: "*/*",
    });
    expect(ses.beforeSendHeaders("https://capybara.example.com/other", {})).toEqual({
      "User-Agent": UA,
    });
  });

  test("replaces a user agent header spelled in any case", () => {
    const ses = setup();
    expect(
      ses.beforeSendHeaders("https://capybara.example.com/", { "user-agent": "x", a: "1" }),
    ).toEqual({ a: "1", "User-Agent": UA });
  });

  test("leaves other origins untouched (OAuth providers, CDNs, other ports and schemes)", () => {
    const ses = setup();
    const headers = { "User-Agent": "Mozilla/5.0 Chrome/140" };
    for (const url of [
      "https://github.com/login/oauth/authorize",
      "https://cdn.example.net/lib.js",
      "https://capybara.example.com:8443/api",
      "http://capybara.example.com/api",
      "https://capybara.example.com.evil.test/",
      "not a url",
    ]) {
      expect(ses.beforeSendHeaders(url, { ...headers })).toEqual(headers);
    }
  });

  test("a redirect hop to another origin gets the session's default user agent back", () => {
    const ses = setup();
    // Chromium re-runs the listener per hop with the headers the first hop was given.
    for (const headers of [
      { "User-Agent": UA, Accept: "*/*" },
      { "user-agent": "Capybara Desktop/9.9 (Other)", Accept: "*/*" },
    ]) {
      expect(ses.beforeSendHeaders("https://github.com/login/oauth/authorize", headers)).toEqual({
        Accept: "*/*",
        "User-Agent": "Mozilla/5.0 Chrome/140 Electron/45",
      });
    }
  });

  test("the default is read once, at install, before anything changes it", () => {
    const ses = fakeSession();
    installDesktopUserAgent(ses, "https://capybara.example.com", UA);
    ses.userAgent = "changed later";
    expect(ses.beforeSendHeaders("https://cdn.example.net/x", { "User-Agent": UA })).toEqual({
      "User-Agent": "Mozilla/5.0 Chrome/140 Electron/45",
    });
  });
});
