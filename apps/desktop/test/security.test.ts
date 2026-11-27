import { describe, expect, test, vi } from "vitest";
import {
  decideTopNavigation,
  decideWindowOpen,
  GRANTED_PERMISSIONS,
  hardenLocalContents,
  hardenProfileContents,
  installDenyAllPermissions,
  installPermissionHandlers,
  isNavigationAllowed,
  LOCAL_PARTITION,
  localWebPreferences,
  profileWebPreferences,
} from "../src/main/security.ts";
import { fakeSession, fakeWebContents } from "./fakes.ts";

const ORIGIN = "https://capybara.example.com";

describe("webPreferences", () => {
  test("deployment windows are isolated, sandboxed and without node or webview", () => {
    const p = profileWebPreferences({ partition: "persist:profile-p1", preload: "/x/preload.cjs" });
    expect(p).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: "persist:profile-p1",
      preload: "/x/preload.cjs",
    });
  });
});

describe("permissions", () => {
  test("the granted list is explicit and small", () => {
    expect([...GRANTED_PERMISSIONS].sort()).toEqual(["clipboard-sanitized-write", "notifications"]);
  });

  test("the profile origin's top frame gets a listed permission", async () => {
    const s = fakeSession();
    installPermissionHandlers(s, ORIGIN);
    expect(await s.request("notifications", `${ORIGIN}/chat/1`)).toBe(true);
    expect(s.check("clipboard-sanitized-write", ORIGIN)).toBe(true);
  });

  test("a request from another origin is denied", async () => {
    const s = fakeSession();
    installPermissionHandlers(s, ORIGIN);
    expect(await s.request("notifications", "https://evil.example.com/")).toBe(false);
    expect(await s.request("notifications", "https://capybara.example.com.evil.io/")).toBe(false);
    expect(s.check("notifications", "https://evil.example.com")).toBe(false);
  });

  test("sub-frames and unlisted permissions are denied", async () => {
    const s = fakeSession();
    installPermissionHandlers(s, ORIGIN);
    expect(await s.request("notifications", `${ORIGIN}/plugin-ui/x`, false)).toBe(false);
    expect(s.check("notifications", ORIGIN, false)).toBe(false);
    for (const p of ["media", "geolocation", "clipboard-read", "openExternal", "hid", "unknown"]) {
      expect(await s.request(p, `${ORIGIN}/`)).toBe(false);
      expect(s.check(p, ORIGIN)).toBe(false);
    }
    expect(await s.request("notifications", "not a url")).toBe(false);
    expect(s.device({ deviceType: "usb", origin: ORIGIN })).toBe(false);
  });
});

describe("the local partition's permissions", () => {
  test("everything is denied, whatever the origin", async () => {
    const s = fakeSession();
    installDenyAllPermissions(s);
    for (const p of [...GRANTED_PERMISSIONS, "media", "geolocation"]) {
      expect(await s.request(p, "app://local/onboarding.html")).toBe(false);
      expect(s.check(p, "app://local")).toBe(false);
    }
    expect(s.device({ deviceType: "usb" })).toBe(false);
  });
});

describe("navigation", () => {
  test("a subframe may navigate over http(s) only", () => {
    expect(isNavigationAllowed("https://github.com/login/oauth/authorize")).toBe(true);
    expect(isNavigationAllowed("http://localhost:3000/")).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "app://local/onboarding.html",
      "data:text/html,x",
      "capybara://auth/callback",
      "nonsense",
    ]) {
      expect(isNavigationAllowed(url)).toBe(false);
    }
  });

  test("top-frame decisions", () => {
    expect(decideTopNavigation(`${ORIGIN}/connectors`, ORIGIN)).toEqual({ kind: "stay" });
    expect(decideTopNavigation("https://github.com/login/oauth/authorize?x=1", ORIGIN)).toEqual({
      kind: "external",
      url: "https://github.com/login/oauth/authorize?x=1",
    });
    // Another scheme or port is another origin.
    expect(decideTopNavigation("http://capybara.example.com/", ORIGIN).kind).toBe("external");
    expect(decideTopNavigation("https://capybara.example.com:8443/", ORIGIN).kind).toBe("external");
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "capybara://open", ""]) {
      expect(decideTopNavigation(url, ORIGIN)).toEqual({ kind: "refuse" });
    }
  });

  function hardened() {
    const wc = fakeWebContents();
    const openExternal = vi.fn();
    const openProfileWindow = vi.fn();
    hardenProfileContents(wc, { origin: ORIGIN, openExternal, openProfileWindow });
    return { wc, openExternal, openProfileWindow };
  }

  test("will-navigate to another origin is prevented and opened externally", () => {
    const { wc, openExternal } = hardened();
    const e = { url: "https://idp.example.com/sso", preventDefault: vi.fn() };
    wc.emit("will-navigate", e, e.url);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://idp.example.com/sso");
  });

  test("will-redirect likewise", () => {
    const { wc, openExternal } = hardened();
    const e = {
      url: "https://github.com/login/oauth/authorize?state=s",
      isMainFrame: true,
      preventDefault: vi.fn(),
    };
    wc.emit("will-redirect", e, e.url, false, true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?state=s");
  });

  test("same-origin navigation stays", () => {
    const { wc, openExternal } = hardened();
    const nav = { url: `${ORIGIN}/login?returnTo=%2F`, preventDefault: vi.fn() };
    wc.emit("will-navigate", nav, nav.url);
    // A server redirect within the origin (sign-out, the session's own pages).
    const hop = { url: `${ORIGIN}/`, isMainFrame: true, preventDefault: vi.fn() };
    wc.emit("will-redirect", hop, hop.url, false, true);
    expect(nav.preventDefault).not.toHaveBeenCalled();
    expect(hop.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("javascript: is prevented and not opened", () => {
    const { wc, openExternal } = hardened();
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "capybara://auth/callback"]) {
      const e = { url, preventDefault: vi.fn() };
      wc.emit("will-navigate", e, url);
      expect(e.preventDefault).toHaveBeenCalled();
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("a subframe's redirect to another origin stays in the frame, over http(s) only", () => {
    const { wc, openExternal } = hardened();
    const embed = { url: "https://cdn.example.net/x", isMainFrame: false, preventDefault: vi.fn() };
    wc.emit("will-redirect", embed, embed.url, false, false);
    expect(embed.preventDefault).not.toHaveBeenCalled();
    const bad = { url: "file:///etc/passwd", isMainFrame: false, preventDefault: vi.fn() };
    wc.emit("will-redirect", bad, bad.url, false, false);
    expect(bad.preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("<webview> is never attached", () => {
    const wc = fakeWebContents();
    hardenProfileContents(wc, {
      origin: ORIGIN,
      openExternal: vi.fn(),
      openProfileWindow: vi.fn(),
    });
    const e = { preventDefault: vi.fn() };
    wc.emit("will-attach-webview", e, {}, {});
    expect(e.preventDefault).toHaveBeenCalled();
  });
});

describe("window.open", () => {
  test("decisions", () => {
    expect(decideWindowOpen(`${ORIGIN}/files/1`, ORIGIN)).toEqual({
      kind: "profile",
      url: `${ORIGIN}/files/1`,
    });
    expect(decideWindowOpen("https://docs.example.com/x", ORIGIN)).toEqual({
      kind: "external",
      url: "https://docs.example.com/x",
    });
    for (const url of [
      "javascript:alert(1)",
      "file:///x",
      "mailto:a@b.c",
      `blob:${ORIGIN}/abc`,
      "data:text/html,x",
      "",
      "about:blank",
    ]) {
      expect(decideWindowOpen(url, ORIGIN)).toEqual({ kind: "refuse" });
    }
  });

  test("another origin goes to the system browser and the window is denied", () => {
    const wc = fakeWebContents();
    const openExternal = vi.fn();
    const openProfileWindow = vi.fn();
    hardenProfileContents(wc, { origin: ORIGIN, openExternal, openProfileWindow });
    expect(wc.openWindow("https://docs.example.com/x")).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://docs.example.com/x");
    expect(openProfileWindow).not.toHaveBeenCalled();
  });

  test("javascript: is refused without opening anything", () => {
    const wc = fakeWebContents();
    const openExternal = vi.fn();
    const openProfileWindow = vi.fn();
    hardenProfileContents(wc, { origin: ORIGIN, openExternal, openProfileWindow });
    expect(wc.openWindow("javascript:alert(1)")).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();
    expect(openProfileWindow).not.toHaveBeenCalled();
  });

  test("same origin opens a profile window", () => {
    const wc = fakeWebContents();
    const openExternal = vi.fn();
    const openProfileWindow = vi.fn();
    hardenProfileContents(wc, { origin: ORIGIN, openExternal, openProfileWindow });
    expect(wc.openWindow(`${ORIGIN}/share/abc`)).toEqual({ action: "deny" });
    expect(openProfileWindow).toHaveBeenCalledWith(`${ORIGIN}/share/abc`);
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("local page windows", () => {
  test("use the app's local partition with the baseline preferences", () => {
    expect(localWebPreferences({ preload: "/x/local.cjs" })).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      partition: LOCAL_PARTITION,
      preload: "/x/local.cjs",
    });
    expect(LOCAL_PARTITION).not.toMatch(/^persist:/);
  });

  test("stay on app://local and open no windows", () => {
    const wc = fakeWebContents("app://local/onboarding.html");
    hardenLocalContents(wc);
    for (const url of ["https://capybara.example.com/", "app://other/onboarding.html"]) {
      const away = { url, preventDefault: vi.fn() };
      wc.emit("will-navigate", away, url);
      expect(away.preventDefault).toHaveBeenCalled();
    }
    const stay = { url: "app://local/main-error.html", preventDefault: vi.fn() };
    wc.emit("will-navigate", stay, stay.url);
    expect(stay.preventDefault).not.toHaveBeenCalled();
    expect(wc.openWindow("https://capybara.example.com/")).toEqual({ action: "deny" });
  });
});
