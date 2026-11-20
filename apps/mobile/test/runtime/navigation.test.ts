import { describe, expect, test } from "vitest";
import {
  decideBack,
  decideNavigation,
  isAuthorizationUrl,
  type NavigationContext,
  nextOauthReturn,
  OAUTH_RETURN_TTL_MS,
  oauthReturnPending,
} from "../../src/runtime/navigation.ts";
import vectors from "../fixtures/navigation.json" with { type: "json" };

const profile = { origin: "https://cap.example.com", base: "https://cap.example.com/team" };
const ctx = (over: Partial<NavigationContext> = {}): NavigationContext => ({
  profile,
  isMainFrame: true,
  targetBlank: false,
  oauthReturnPending: false,
  ...over,
});

describe("decideNavigation", () => {
  test("a same-origin main frame stays", () => {
    expect(decideNavigation("https://cap.example.com/team/chat/1", ctx())).toBe("allow");
  });

  test("another origin top level goes to the browser sheet", () => {
    expect(decideNavigation("https://docs.example.org/x", ctx())).toBe("sheet");
  });

  test("a connector OAuth leave-and-return stays in the WebView (desktop spec §7.1)", () => {
    const authorize =
      "https://idp.example/authorize?response_type=code&redirect_uri=" +
      encodeURIComponent("https://cap.example.com/team/api/v1/oauth/callback");
    expect(decideNavigation(authorize, ctx())).toBe("allow");
    // The provider's own pages until the return, then the profile origin again.
    expect(decideNavigation("https://sso.idp2.example/login", ctx())).toBe("sheet");
    expect(
      decideNavigation("https://sso.idp2.example/login", ctx({ oauthReturnPending: true })),
    ).toBe("allow");
  });

  test("target=_blank goes to the sheet, on the profile origin too", () => {
    expect(decideNavigation("https://docs.example.org/", ctx({ targetBlank: true }))).toBe("sheet");
    expect(decideNavigation("https://cap.example.com/team/x", ctx({ targetBlank: true }))).toBe(
      "sheet",
    );
  });

  test("javascript:, file: and data: top level are blocked", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/hosts", "data:text/html,x"]) {
      expect(decideNavigation(url, ctx()), url).toBe("block");
    }
  });

  test("the two sign-in routes as navigations are blocked", () => {
    expect(decideNavigation("https://cap.example.com/team/api/v1/auth/login", ctx())).toBe("block");
    expect(decideNavigation("https://cap.example.com/team/api/v1/auth/sso/lark/start", ctx())).toBe(
      "block",
    );
  });

  test.each(vectors)("vector: $name", (v) => {
    expect(
      decideNavigation(v.url, {
        profile: v.profile,
        isMainFrame: v.isMainFrame,
        targetBlank: v.targetBlank,
        oauthReturnPending: v.oauthReturnPending,
      }),
    ).toBe(v.expect);
  });
});

describe("isAuthorizationUrl", () => {
  test("needs response_type and a redirect_uri on exactly the profile origin", () => {
    const origin = "https://cap.example.com";
    const ok = "https://idp.example/a?response_type=code&redirect_uri=https://cap.example.com/cb";
    expect(isAuthorizationUrl(ok, origin)).toBe(true);
    expect(isAuthorizationUrl(ok.replace("response_type", "x"), origin)).toBe(false);
    expect(isAuthorizationUrl(ok.replace("cap.example.com/cb", "evil.test/cb"), origin)).toBe(
      false,
    );
    expect(isAuthorizationUrl("https://idp.example/a?response_type=code", origin)).toBe(false);
    expect(isAuthorizationUrl("::", origin)).toBe(false);
  });
});

describe("nextOauthReturn (the pending leave-and-return)", () => {
  const p = profile;
  const authorize =
    "https://idp.example/a?response_type=code&redirect_uri=https://cap.example.com/team/cb";

  test("starts when a main-frame navigation leaves the origin, ends back on it", () => {
    const started = nextOauthReturn(null, {
      url: authorize,
      decision: "allow",
      profile: p,
      now: 5,
    });
    expect(started).toEqual({ since: 5 });
    // Further provider pages keep the first start time.
    expect(
      nextOauthReturn(started, {
        url: "https://idp2.example/x",
        decision: "allow",
        profile: p,
        now: 9,
      }),
    ).toEqual({ since: 5 });
    expect(
      nextOauthReturn(started, {
        url: "https://cap.example.com/team/cb?code=1",
        decision: "allow",
        profile: p,
        now: 9,
      }),
    ).toBeNull();
  });

  test("a sheet or a block changes nothing", () => {
    expect(
      nextOauthReturn(null, { url: authorize, decision: "sheet", profile: p, now: 1 }),
    ).toBeNull();
    expect(
      nextOauthReturn({ since: 1 }, { url: "javascript:x", decision: "block", profile: p, now: 2 }),
    ).toEqual({ since: 1 });
  });

  test("expires after the OAuth state's lifetime", () => {
    expect(oauthReturnPending({ since: 0 }, OAUTH_RETURN_TTL_MS - 1)).toBe(true);
    expect(oauthReturnPending({ since: 0 }, OAUTH_RETURN_TTL_MS)).toBe(false);
    expect(oauthReturnPending(null, 0)).toBe(false);
    // An expired return is gone: a new authorization URL starts a new one.
    expect(
      nextOauthReturn(
        { since: 0 },
        { url: authorize, decision: "allow", profile: p, now: OAUTH_RETURN_TTL_MS },
      ),
    ).toEqual({ since: OAUTH_RETURN_TTL_MS });
  });
});

describe("decideBack (Android, amended 2026-11-21)", () => {
  test("history while the WebView can go back, else the app goes to the background", () => {
    expect(decideBack({ canGoBack: true })).toBe("history");
    expect(decideBack({ canGoBack: false })).toBe("background");
  });

  test("reads nothing but canGoBack (no nav@1 state)", () => {
    expect(decideBack({ canGoBack: true, nav: { visible: true } } as never)).toBe("history");
  });
});
