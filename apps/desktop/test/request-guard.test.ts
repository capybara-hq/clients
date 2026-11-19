import { describe, expect, test } from "vitest";
import {
  blockInWindowSignIn,
  isInWindowSignIn,
  type WebRequestSession,
} from "../src/main/request-guard.ts";

const BASE = "https://capybara.example.com/team";

function fakeWebRequestSession() {
  let listener:
    | ((
        details: { url: string; method: string },
        callback: (response: { cancel?: boolean }) => void,
      ) => void)
    | undefined;
  let installs = 0;
  const session: WebRequestSession = {
    webRequest: {
      onBeforeRequest(l) {
        installs += 1;
        listener = l;
      },
    },
  };
  return {
    session,
    installs: () => installs,
    /** Runs a request through the listener: true when it is cancelled. */
    request(method: string, url: string): boolean {
      if (!listener) throw new Error("no listener");
      let cancelled: boolean | undefined;
      listener({ method, url }, (r) => {
        cancelled = r.cancel === true;
      });
      if (cancelled === undefined) throw new Error("the listener never answered");
      return cancelled;
    },
  };
}

describe("blockInWindowSignIn", () => {
  test("cancels the password sign-in and every SSO start under the base", () => {
    const s = fakeWebRequestSession();
    blockInWindowSignIn(s.session, BASE);
    expect(s.installs()).toBe(1);
    expect(s.request("POST", `${BASE}/api/v1/auth/login`)).toBe(true);
    expect(s.request("POST", `${BASE}/api/v1/auth/login?next=/x`)).toBe(true);
    expect(s.request("GET", `${BASE}/api/v1/auth/sso/lark/start`)).toBe(true);
    expect(s.request("GET", `${BASE}/api/v1/auth/sso/plugin-sso-x/start?redirect=%2F`)).toBe(true);
  });

  test("lets everything else through", () => {
    const s = fakeWebRequestSession();
    blockInWindowSignIn(s.session, BASE);
    for (const [method, url] of [
      ["GET", `${BASE}/api/v1/auth/login`],
      ["POST", `${BASE}/api/v1/auth/logout`],
      ["POST", `${BASE}/api/v1/auth/refresh`],
      ["GET", `${BASE}/api/v1/auth/sso/lark/callback?code=1`],
      ["GET", `${BASE}/api/v1/auth/sso/providers`],
      ["POST", `${BASE}/api/v1/app-auth/token`],
      ["GET", `${BASE}/`],
      ["GET", `${BASE}/chat/1`],
      // The same path outside the base prefix or on another origin is not the deployment's.
      ["POST", "https://capybara.example.com/api/v1/auth/login"],
      ["POST", "https://other.example.com/team/api/v1/auth/login"],
      ["GET", "https://idp.example.com/api/v1/auth/sso/x/start"],
      ["GET", "devtools://devtools/bundled/x.html"],
      ["GET", "not a url"],
    ]) {
      expect(s.request(method as string, url as string), `${method} ${url}`).toBe(false);
    }
  });
});

describe("isInWindowSignIn", () => {
  test("matches on the parsed path: case, a trailing slash, doubled slashes and dot segments", () => {
    for (const [method, url] of [
      ["post", `${BASE}/api/v1/auth/login`],
      ["POST", `${BASE}/api/v1/auth/login/`],
      ["POST", `${BASE}/API/V1/Auth/Login`],
      ["POST", `${BASE}//api//v1/auth/login`],
      ["POST", `${BASE}/x/../api/v1/auth/login`],
      ["POST", `${BASE}/api/v1/auth/%2e%2e/auth/login`],
      ["GET", `${BASE}/api/v1/auth/sso/a/b/start`],
      ["GET", `${BASE}/api/v1/auth/sso/a/start/`],
      ["HEAD", `${BASE}/api/v1/auth/sso/a/start`],
    ]) {
      expect(isInWindowSignIn(method as string, url as string, BASE), `${method} ${url}`).toBe(
        true,
      );
    }
  });

  test("a deployment at the origin root", () => {
    const root = "https://capybara.example.com";
    expect(isInWindowSignIn("POST", `${root}/api/v1/auth/login`, root)).toBe(true);
    expect(isInWindowSignIn("POST", `${root}/team/api/v1/auth/login`, root)).toBe(false);
    expect(isInWindowSignIn("GET", `${root}/api/v1/auth/sso//start`, root)).toBe(false);
  });
});

describe("percent-encoded paths", () => {
  test("encoded segments are decoded before matching", () => {
    expect(isInWindowSignIn("POST", `${BASE}/api/v1/auth/%6cogin`, BASE)).toBe(true);
    expect(isInWindowSignIn("POST", `${BASE}/%61pi/v1/auth/login`, BASE)).toBe(true);
    expect(isInWindowSignIn("GET", `${BASE}/api/v1/auth/sso/x/%73tart`, BASE)).toBe(true);
    expect(isInWindowSignIn("GET", `${BASE}/api/v1/auth/sso/%4Cark/start`, BASE)).toBe(true);
  });

  test("an encoded slash or backslash cannot hide the route (block when in doubt)", () => {
    for (const [method, path] of [
      ["POST", "/api/v1/auth%2Flogin"],
      ["POST", "/api%2fv1%2fauth%2flogin"],
      ["GET", "/api/v1/auth/sso/x%2Fstart"],
      ["GET", "/api/v1/auth/sso%2Fx/start"],
      ["POST", "/api\\v1\\auth\\login"],
      ["POST", "/api/v1/x/..%2Fauth/login"],
      ["POST", "/api/v1/auth/%2e%2e%2fauth/login"],
    ]) {
      expect(isInWindowSignIn(method as string, `${BASE}${path}`, BASE), path).toBe(true);
    }
  });

  test("a malformed escape does not throw and does not unblock the rest", () => {
    expect(isInWindowSignIn("POST", `${BASE}/api/v1/auth/login%zz`, BASE)).toBe(false);
    expect(isInWindowSignIn("POST", `${BASE}/%zz/../api/v1/auth/login`, BASE)).toBe(true);
  });

  test("encoded look-alikes of other routes still pass", () => {
    expect(isInWindowSignIn("POST", `${BASE}/api/v1/auth/%6cogout`, BASE)).toBe(false);
    expect(isInWindowSignIn("GET", `${BASE}/files/a%2Fb`, BASE)).toBe(false);
    expect(isInWindowSignIn("POST", "https://capybara.example.com/api/v1/auth/%6cogin", BASE)).toBe(
      false,
    );
  });
});
