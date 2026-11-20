// End-to-end of the onboarding (desktop spec §6) on a fresh first launch: the small window, the
// connect errors, the sign-in errors, sign-in through the (stubbed) system browser, the expired
// session, the signed-out window, the shell dialog and the profile's theme cookie. The system
// browser is stubbed and the callback deep link is delivered as `open-url` (see e2e/README.md).
// Every wait is on a condition. Run: pnpm e2e
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  type FakeDeployment,
  startFakeDeployment,
} from "../../../packages/shell/test/fixtures/fake-deployment.ts";
import { type Harness, launchApp } from "./harness.ts";

/** A catalog message in either UI language (the app follows the system's), as an exact match. */
const catalog = (lang: "en" | "zh") =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/shell/src/i18n/${lang}.json`, import.meta.url), "utf8"),
  ) as Record<string, string>;
const en = catalog("en");
const zh = catalog("zh");
const message = (key: string): RegExp => {
  const esc = (v: string | undefined) => (v ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(en[key], key).toBeTruthy();
  expect(zh[key], key).toBeTruthy();
  return new RegExp(`^(${esc(en[key])}|${esc(zh[key])})$`);
};

const SMALL = "app://local/onboarding.html";
const DIALOG = "app://local/dialog.html";
const ERROR_PAGE = "app://local/main-error.html";

let h: Harness;
let good: FakeDeployment;
let notCapybara: FakeDeployment;
let notAllowed: FakeDeployment;
let locked: FakeDeployment;
let small: Page;
let main: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  good = await startFakeDeployment();
  // An address that answers, but is not a Capybara platform: html where the meta should be.
  notCapybara = await startFakeDeployment({ metaRaw: "<!doctype html><title>nope</title>" });
  // A platform whose appRedirectUris does not list the app's redirect URI.
  notAllowed = await startFakeDeployment({ meta: { appRedirectUris: ["capybara://other/cb"] } });
  // A platform whose token exchange refuses the account (the kernel's `auth.account_disabled`).
  locked = await startFakeDeployment({ tokenError: "auth.account_disabled" });
  h = await launchApp();
});

let failed = false;
test.afterEach(() => {
  const info = test.info();
  if (info.status !== info.expectedStatus) failed = true;
});

test.afterAll(async () => {
  try {
    await h?.close(failed, test.info().outputPath("trace.zip"));
  } finally {
    await good?.close();
    await notCapybara?.close();
    await notAllowed?.close();
    await locked?.close();
  }
});

async function connect(address: string): Promise<void> {
  await small.locator("#address").fill(address);
  await small.locator("#address").press("Enter");
}

/** 在浏览器中登录 from the page shown: the authorize URL the stubbed browser got, and its state. */
async function startSignIn(from: Page, fake: FakeDeployment, button: string) {
  const opened = (await h.openedUrls()).length;
  await from.locator(button).click();
  await expect.poll(async () => (await h.openedUrls()).length).toBe(opened + 1);
  const url = new URL((await h.openedUrls())[opened] as string);
  expect(`${url.origin}${url.pathname}`).toBe(`${fake.base}/apps/authorize`);
  // The test plays the browser: the fake records the challenge for this state.
  await from.request.get(url.href);
  return url.searchParams.get("state") as string;
}

const callback = (fake: FakeDeployment, params: Record<string, string>) =>
  h.deepLink(`capybara://auth/callback?${new URLSearchParams({ ...params, iss: fake.base })}`);

const profileOf = (fake: FakeDeployment) => {
  const profile = h.profiles().find((p) => p.base === fake.base);
  expect(profile).toBeDefined();
  return profile as { id: string; base: string; signedIn: boolean };
};

test("first launch: the small window on connect, 480x600, not resizable", async () => {
  small = await h.app.firstWindow();
  await expect(small).toHaveURL(SMALL);
  await expect(small.locator("#address")).toBeVisible();
  const win = await h.app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows();
    const w = all[0];
    return {
      count: all.length,
      resizable: w?.isResizable(),
      maximizable: w?.isMaximizable(),
      size: w?.getContentSize(),
    };
  });
  expect(win).toEqual({ count: 1, resizable: false, maximizable: false, size: [480, 600] });
  expect(h.profiles()).toEqual([]);
});

test("a bad address: not_capybara inline, nothing saved", async () => {
  await connect(notCapybara.base);
  await expect(small.locator("#address-error")).toHaveText(
    message("onboarding.connect.error.not_capybara"),
  );
  await expect(small.locator("#address")).toBeVisible();
  expect(await h.windowUrls()).toEqual([SMALL]);
  expect(notCapybara.requests.some((r) => r.path === "/api/v1/meta")).toBe(true);
  expect(h.profiles()).toEqual([]);
});

test("found shows the name and host; a platform that does not allow the app: not_allowed", async () => {
  await connect(notAllowed.base);
  await expect(small.locator("h1")).toContainText("Fake Deployment");
  await expect(small.locator(".lp-host")).toContainText(new URL(notAllowed.base).host);
  const opened = (await h.openedUrls()).length;
  await small.locator("main .lp-btn").first().click();
  // Refused before the browser opens: the error box shows on the found page.
  await expect(small.locator(".lp-alert--box")).toHaveText(
    message("onboarding.signIn.error.not_allowed"),
  );
  expect(await h.openedUrls()).toHaveLength(opened);
  expect(notAllowed.authorize).toEqual([]);
  // 换一个地址 goes back to connect.
  await small.locator(".lp-link").last().click();
  await expect(small.locator("#address")).toBeVisible();
});

test("a token exchange the platform refuses: the account cannot be used", async () => {
  await connect(locked.base);
  await expect(small.locator("h1")).toContainText("Fake Deployment");
  const state = await startSignIn(small, locked, "main .lp-btn");
  await expect(small.locator(".lp-steps")).toBeVisible();
  await callback(locked, { code: locked.issueCode(state), state });
  await expect.poll(() => locked.refused).toEqual(["auth.account_disabled"]);
  await expect(small.locator(".lp-alert--box")).toBeVisible();
  expect(h.profiles()).toEqual([]);
  expect(await h.windowUrls()).toEqual([SMALL]);
  await small.locator(".lp-link").last().click();
  await expect(small.locator("#address")).toBeVisible();
});

test("connect, sign in in the browser, access_denied: cancelled; again: the main window", async () => {
  await connect(good.base);
  await expect(small.locator("h1")).toContainText("Fake Deployment");
  await expect(small.locator("img.lp-icon")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(small.locator(".lp-host")).toContainText(new URL(good.base).host);

  // 在浏览器中登录 -> waiting.
  const denied = await startSignIn(small, good, "main .lp-btn");
  await expect(small.locator(".lp-steps")).toBeVisible();
  // The person denied it in the browser: the callback carries `error=access_denied`.
  await callback(good, { error: "access_denied", state: denied });
  await expect(small.locator(".lp-alert--box")).toHaveText(
    message("onboarding.signIn.error.cancelled"),
  );
  await expect(small.locator(".lp-steps")).toHaveCount(0);
  expect(good.accepted).toBe(0);
  expect(h.profiles()).toEqual([]);

  // The error's own button signs in again; this time the callback is granted.
  const state = await startSignIn(small, good, "main .lp-btn");
  await expect(small.locator(".lp-steps")).toBeVisible();
  const next = h.app.waitForEvent("window");
  await callback(good, { code: good.issueCode(state), state });
  main = await next;
  await expect(main).toHaveURL(`${good.base}/`);
  await expect(main.locator("#auth")).toHaveText("signed-in:Fake Person");
  // The small window closed: only the main window is left.
  await expect.poll(() => h.windowUrls()).toEqual([`${good.base}/`]);
  expect(profileOf(good).signedIn).toBe(true);
});

test("an expired session (cookie removed, reload): the expired overlay, then back after sign-in", async () => {
  await main.goto(`${good.base}/protected`);
  await expect(main.locator("#auth")).toHaveText("protected:Fake Person");
  const profile = profileOf(good);
  // The session ends on the server side: the cookie is gone, the web redirects to /login.
  await h.app.evaluate(
    ({ session }, args) =>
      session.fromPartition(`persist:profile-${args.id}`).cookies.remove(args.base, "cap_at"),
    { id: profile.id, base: good.base },
  );
  const before = good.requests.length;
  // The app stops the /login navigation, so the reload never completes: do not wait on it.
  await main.evaluate(() => window.location.reload());
  const overlay = await h.windowOn(ERROR_PAGE);
  await expect(overlay.locator("h1")).toHaveText(/^(登录已过期|Your session has expired)$/);
  expect(good.requests.slice(before).map((r) => r.path)).not.toContain(
    "/login?returnTo=%2Fprotected",
  );
  expect(await h.overlayUrls()).toEqual([ERROR_PAGE]);

  const state = await startSignIn(overlay, good, "main .lp-btn");
  await callback(good, { code: good.issueCode(state), state });
  await expect.poll(h.overlayUrls).toEqual([]);
  await expect(main).toHaveURL(`${good.base}/protected`);
  await expect(main.locator("#auth")).toHaveText("protected:Fake Person");
});

test("the web's logout and /login: the signed-out small window", async () => {
  await main.goto(`${good.base}/`);
  await expect(main.locator("#auth")).toHaveText("signed-in:Fake Person");
  await main.locator("#logout").click();
  small = await h.windowOn(SMALL);
  await expect(small.locator("h1")).toHaveText(/^(已退出|Signed out of) Fake Deployment$/);
  await expect.poll(() => h.windowUrls()).toEqual([SMALL]);
  expect(good.logouts).toBe(1);
  expect(profileOf(good).signedIn).toBe(false);
});

test("a shell dialog opens as its own window; cancel keeps the profile", async () => {
  // 移除这个平台 is the last link of the signed-out page.
  await small.locator(".lp-links .lp-link").last().click();
  const dialog = await h.windowOn(DIALOG);
  await expect(dialog.locator(".dlg-host")).toHaveText(new URL(good.base).host);
  // It is a window of its own, not an overlay of the small window.
  expect(await h.windowUrls()).toEqual(expect.arrayContaining([SMALL, DIALOG]));
  expect(await h.overlayUrls()).toEqual([]);
  // The first button is cancel.
  await dialog.locator(".dlg-actions button").first().click();
  await expect.poll(() => h.windowUrls()).toEqual([SMALL]);
  expect(h.profiles().map((p) => p.base)).toEqual([good.base]);
  await expect(small.locator("h1")).toHaveText(/^(已退出|Signed out of) Fake Deployment$/);
});

test("the theme toggle in a local page writes cb-theme into the profile's partition", async () => {
  const profile = profileOf(good);
  const read = async () =>
    (await h.cookies(profile.id, good.base, "cb-theme")).map((c) => ({
      value: c.value,
      path: c.path,
      httpOnly: c.httpOnly,
    }));
  const shown = await small.locator("html").getAttribute("data-theme");
  const chosen = shown === "dark" ? "light" : "dark";
  await small.locator('.lp-theme button[aria-pressed="false"]').click();
  await expect(small.locator("html")).toHaveAttribute("data-theme", chosen);
  await expect.poll(read).toEqual([{ value: chosen, path: "/", httpOnly: false }]);
  // Not in the default session.
  expect(
    await h.app.evaluate(
      ({ session }, base) => session.defaultSession.cookies.get({ url: base, name: "cb-theme" }),
      good.base,
    ),
  ).toEqual([]);
});
