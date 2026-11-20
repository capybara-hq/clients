// End-to-end smoke of the desktop app against a fake deployment (no network, no real sign-in, no
// OS protocol handler, no system browser). See e2e/README.md for what this covers and what stays
// manual. Run: pnpm e2e
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import {
  type FakeDeployment,
  startFakeDeployment,
} from "../../../packages/shell/test/fixtures/fake-deployment.ts";
import { type Harness, launchApp } from "./harness.ts";

// What the page's world sees (installed by the preload); only the parts the spec reads.
interface PageShell {
  insets: Record<string, number>;
  controls: Record<string, number> | null;
  capabilities: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
}
let app: ElectronApplication;
let userData: string;
let fake: FakeDeployment;
let peer: FakeDeployment;
let page: Page;

test.describe.configure({ mode: "serial" });

let harness: Harness;

test.beforeAll(async () => {
  peer = await startFakeDeployment();
  fake = await startFakeDeployment({ peer: peer.base });
  harness = await launchApp();
  app = harness.app;
  userData = harness.userData;
});

let failed = false;
test.afterEach(() => {
  const info = test.info();
  if (info.status !== info.expectedStatus) failed = true;
});

test.afterAll(async () => {
  try {
    await harness?.close(failed, test.info().outputPath("trace.zip"));
  } finally {
    await fake?.close();
    await peer?.close();
  }
});

const openedUrls = () => harness.openedUrls();

interface ShellReport {
  type: string;
  kind?: string;
  platform?: string;
  version?: number;
  capabilities: string[];
}

/** The theme chosen in the small window before the first sign-in. */
let chosenTheme = "";

const shellReport = async (p: Page): Promise<ShellReport> =>
  JSON.parse((await p.locator("#shell").textContent()) ?? "{}") as ShellReport;

test("the small window: connect, found, sign-in in the browser, the main window", async () => {
  page = await app.firstWindow();
  await expect(page).toHaveURL("app://local/onboarding.html");

  // Carried check (a): the small window's frame origin, as main sees it.
  const origins = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.webContents.mainFrame.origin),
  );
  expect(origins).toEqual(["app://local"]);

  await page.locator("#address").fill(fake.base);
  await page.locator("#address").press("Enter");
  // The action answered, so main accepted the sender frame (app://local, registered).
  await expect(page.locator("h1")).toContainText("Fake Deployment");
  await expect(page.locator("img.lp-icon")).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(fake.requests.some((r) => r.path === "/api/v1/meta")).toBe(true);

  // The theme toggle of the small window (spec §6.10): before any profile it is the app's choice,
  // which seeds the new profile's cb-theme cookie (checked after the sign-in below).
  const shown = await page.locator("html").getAttribute("data-theme");
  chosenTheme = shown === "dark" ? "light" : "dark";
  await page.locator('.lp-theme button[aria-pressed="false"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", chosenTheme);

  // 在浏览器中登录: the authorize URL goes to the system browser (captured), the page waits.
  await page.locator("main .lp-btn").click();
  await expect.poll(openedUrls).toHaveLength(1);
  await expect(page.locator(".lp-steps")).toBeVisible();
  const url = new URL((await openedUrls())[0] as string);
  expect(`${url.origin}${url.pathname}`).toBe(`${fake.base}/apps/authorize`);
  const signInState = url.searchParams.get("state") as string;
  // The test plays the browser and the callback deep link.
  await page.request.get(url.href);
  const code = fake.issueCode(signInState);
  const link = `capybara://auth/callback?${new URLSearchParams({ code, state: signInState, iss: fake.base })}`;
  const next = app.waitForEvent("window");
  await app.evaluate(({ app: electronApp }, u) => {
    electronApp.emit("open-url", { preventDefault() {} }, u);
  }, link);
  page = await next;
  await expect(page).toHaveURL(`${fake.base}/`);
  await expect(page.locator("#auth")).toHaveText("signed-in:Fake Person");
  // The small window closed once the profile was saved.
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
      ),
    )
    .toEqual([`${fake.base}/`]);
});

test("the theme chosen in the small window is the profile partition's cb-theme", async () => {
  const profiles = JSON.parse(readFileSync(join(userData, "app", "profiles.json"), "utf8")) as {
    profiles: { id: string; base: string }[];
  };
  const profile = profiles.profiles.find((p) => p.base === fake.base);
  expect(profile).toBeDefined();
  const cookies = await app.evaluate(
    ({ session }, args) =>
      session.fromPartition(args.partition).cookies.get({ url: args.base, name: "cb-theme" }),
    { partition: `persist:profile-${profile?.id}`, base: fake.base },
  );
  expect(cookies.map((c) => ({ value: c.value, path: c.path, httpOnly: c.httpOnly }))).toEqual([
    { value: chosenTheme, path: "/", httpOnly: false },
  ]);
  expect(cookies[0]?.sameSite).toBe("lax");
});

test("the deployment page sees capybaraShell with its capabilities", async () => {
  // Carried check (b): executeInMainWorld installed the object on the origin's top frame.
  await expect(page.locator("#auth")).toHaveText("signed-in:Fake Person");
  const report = await shellReport(page);
  expect(report).toMatchObject({ type: "object", kind: "desktop", platform: "macos", version: 1 });
  expect(report.capabilities).toEqual(
    expect.arrayContaining(["signIn@1", "notify@1", "openExternal@1", "chrome@1"]),
  );
  // device@1 is offered where the code says: macOS or Linux, the fake's meta says localDevices
  // and a protocol range holding the bundled one (3). Discovery runs after the load and is
  // announced with `change`, so the page's report gains it without a reload.
  const deviceExpected = process.platform === "darwin" || process.platform === "linux";
  await expect
    .poll(async () => (await shellReport(page)).capabilities.includes("device@1"))
    .toBe(deviceExpected);
  expect(
    await page.evaluate(
      () => typeof (window as unknown as { capybaraShell: PageShell }).capybaraShell,
    ),
  ).toBe("object");
  // The window's own state, as the page reads it (the geometry values are announced, not measured).
  const state = await page.evaluate(() => ({
    insets: { ...(window as unknown as { capybaraShell: PageShell }).capybaraShell.insets },
    controls: (window as unknown as { capybaraShell: PageShell }).capybaraShell.controls && {
      ...(window as unknown as { capybaraShell: PageShell }).capybaraShell.controls,
    },
  }));
  expect(state).toEqual({
    insets: { top: 28, right: 0, bottom: 0, left: 0 },
    controls: { x: 0, y: 0, width: 80, height: 28 },
  });
});

test("the iframes (same origin and /plugin-ui) do not see capybaraShell", async () => {
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  expect(frames.map((f) => new URL(f.url()).pathname).sort()).toEqual([
    "/frame",
    "/plugin-ui/x/frame",
  ]);
  for (const frame of frames) {
    await expect(frame.locator("#frame-shell")).toHaveText("undefined");
  }
});

test("a call without a user activation is refused", async () => {
  const opened = (await openedUrls()).length;
  // Playwright's evaluate carries a user gesture; wait on the condition until the transient
  // activation has expired, then call.
  const code = await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () => {
        const active = (navigator as unknown as { userActivation: { isActive: boolean } })
          .userActivation.isActive;
        if (!active) resolve();
        else if (Date.now() > deadline) reject(new Error("the user activation did not expire"));
        else setTimeout(check, 50);
      };
      check();
    });
    return (window as unknown as { capybaraShell: PageShell }).capybaraShell.capabilities[
      "signIn@1"
    ]
      ?.start?.()
      .then(
        () => "resolved",
        (e: { code?: string }) => e.code ?? "error",
      );
  });
  expect(code).toBe("no_activation");
  expect(await openedUrls()).toHaveLength(opened);
});

test("the in-window password login route is blocked", async () => {
  await page.locator("#login").click();
  await expect(page.locator("#login-result")).toHaveText("blocked");
  expect(fake.loginHits).toBe(0);
});

test("the desktop user agent goes to the profile's origin only", async () => {
  const ua = await page.evaluate(() => fetch("/ua").then((r) => r.text()));
  expect(ua).toMatch(/^Capybara Desktop\/\S+ \(.+\)$/);
  const pageRequests = fake.requests.filter((r) => r.path === "/");
  expect(pageRequests.length).toBeGreaterThan(0);
  for (const r of pageRequests) expect(r.userAgent).toMatch(/^Capybara Desktop\//);
});

let state = "";

test("signIn: user activation opens the authorize URL in the system browser", async () => {
  // The small window's sign-in opened the first one.
  await page.locator("#signin").click();
  await expect.poll(openedUrls).toHaveLength(2);
  const url = new URL((await openedUrls())[1] as string);
  expect(`${url.origin}${url.pathname}`).toBe(`${fake.base}/apps/authorize`);
  const q = Object.fromEntries(url.searchParams);
  expect(q).toMatchObject({
    client: "desktop",
    redirect_uri: "capybara://auth/callback",
    code_challenge_method: "S256",
  });
  expect(q.state).toBeTruthy();
  expect(q.code_challenge).toBeTruthy();
  state = q.state as string;
  // The test plays the browser: the fake records the same query when it is "visited".
  await page.request.get(url.href);
  expect(fake.authorize.at(-1)?.query.state).toBe(state);
});

test("the callback deep link exchanges the code; the cookie lands in the profile partition", async () => {
  const code = fake.issueCode(state);
  const link = `capybara://auth/callback?${new URLSearchParams({ code, state, iss: fake.base })}`;
  // Same router as the OS-delivered link: macOS `open-url` on app.
  await app.evaluate(({ app: electronApp }, url) => {
    electronApp.emit("open-url", { preventDefault() {} }, url);
  }, link);

  // The exchange succeeded (the second, after the small window's): the window reloads and the
  // server saw the cookie.
  await expect.poll(() => fake.accepted).toBe(2);
  await expect(page.locator("#auth")).toHaveText("signed-in:Fake Person");
  expect(fake.refused).toEqual([]);

  const profiles = JSON.parse(readFileSync(join(userData, "app", "profiles.json"), "utf8")) as {
    profiles: { id: string; base: string }[];
  };
  const profile = profiles.profiles.find((p) => p.base === fake.base);
  expect(profile).toBeDefined();
  const cookies = await app.evaluate(
    ({ session }, args) => session.fromPartition(args.partition).cookies.get({ url: args.base }),
    { partition: `persist:profile-${profile?.id}`, base: fake.base },
  );
  expect(cookies.map((c) => c.name)).toContain("cap_at");
  // Not in the default session.
  const stray = await app.evaluate(
    ({ session }, base) => session.defaultSession.cookies.get({ url: base }),
    fake.base,
  );
  expect(stray).toEqual([]);

  // After the reload the shell is still there and the user agent was the app's on the exchange.
  expect((await shellReport(page)).type).toBe("object");
  const exchange = fake.requests.find((r) => r.path === "/api/v1/app-auth/token");
  expect(exchange?.userAgent).toMatch(/^Capybara Desktop\//);
});

test("a replayed callback does nothing", async () => {
  const link = `capybara://auth/callback?${new URLSearchParams({ code: "x", state, iss: fake.base })}`;
  await app.evaluate(({ app: electronApp }, url) => {
    electronApp.emit("open-url", { preventDefault() {} }, url);
  }, link);
  // What this proves: after the replay, a sentinel request goes through the app's own session to
  // the fake. The replay was emitted synchronously before it (the router looks the state up
  // synchronously and a miss sends nothing), and the fake records requests in arrival order, so
  // once the sentinel has been answered any token call the replay caused would already be in the
  // log. The count must still be 2 (the small window's and the page's sign-in). It does not prove
  // anything about a replay that is delayed.
  await page.evaluate(() => fetch("/sentinel").then((r) => r.text()));
  const seen = fake.requests.map((r) => r.path);
  expect(seen.lastIndexOf("/sentinel")).toBeGreaterThan(-1);
  expect(seen.filter((p) => p === "/api/v1/app-auth/token")).toHaveLength(2);
  await page.reload();
  await expect(page.locator("#auth")).toHaveText("signed-in:Fake Person");
  expect(fake.accepted).toBe(2);
});

test("a contextBridge subscription returns a working unsubscribe", async () => {
  test.skip(process.platform !== "darwin" && process.platform !== "linux", "no device@1");
  const result = await page.evaluate(() => {
    const device = (window as unknown as { capybaraShell: PageShell }).capybaraShell.capabilities[
      "device@1"
    ] as unknown as {
      onStatus(listener: (status: unknown) => void): () => void;
    };
    const off = device.onStatus(() => {});
    const type = typeof off;
    off();
    off();
    return type;
  });
  expect(result).toBe("function");
});

test("device@1.requestCeiling refuses the old shape and an empty request across the bridge", async () => {
  test.skip(process.platform !== "darwin" && process.platform !== "linux", "no device@1");
  const codes = await page.evaluate(async () => {
    const device = (window as unknown as { capybaraShell: PageShell }).capybaraShell.capabilities[
      "device@1"
    ] as unknown as { requestCeiling(input: unknown): Promise<unknown> };
    const code = (input: unknown) =>
      device.requestCeiling(input).then(
        () => "resolved",
        (e: unknown) => (e as { code?: unknown } | null)?.code,
      );
    return [
      await code({ fullAccess: true, projectReach: "os-user" }),
      await code({}),
      await code({ network: "open", fullAccess: true }),
    ];
  });
  // The call crosses the bridge and is refused; the unit tests prove the shape check refuses
  // these before any device command runs.
  expect(codes).toEqual(["failed", "failed", "failed"]);
});

test("a redirect hop to another origin gets Chromium's user agent and no shell", async () => {
  await page.locator("#hop").click();
  await expect(page).toHaveURL(`${peer.base}/ua`);
  await expect.poll(() => peer.requests.some((r) => r.path === "/ua")).toBe(true);
  const hop = peer.requests.find((r) => r.path === "/ua");
  expect(hop?.userAgent).not.toMatch(/Capybara Desktop/);
  expect(hop?.userAgent).toMatch(/Chrome\//);
  // Off the profile's origin: the Shell environment is not installed.
  expect(
    await page.evaluate(
      () => typeof (window as unknown as { capybaraShell: PageShell }).capybaraShell,
    ),
  ).toBe("undefined");
});

/** The window on `url`, polled (a re-shown small window raises no `window` event). */
async function windowOn(url: string): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(() => {
      found = app.windows().find((w) => !w.isClosed() && w.url() === url);
      return found !== undefined;
    })
    .toBe(true);
  return found as Page;
}

/** Only the small window is open, and the profile is saved signed out. */
async function expectSignedOut(): Promise<Page> {
  const small = await windowOn("app://local/onboarding.html");
  await expect(small.locator("h1")).toHaveText(/^(已退出|Signed out of) Fake Deployment$/);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
      ),
    )
    .toEqual(["app://local/onboarding.html"]);
  const profiles = JSON.parse(readFileSync(join(userData, "app", "profiles.json"), "utf8")) as {
    profiles: { base: string; signedIn: boolean }[];
  };
  expect(profiles.profiles.find((p) => p.base === fake.base)?.signedIn).toBe(false);
  return small;
}

test("the web's own sign-out ends in the small window's signed-out page", async () => {
  // Back on the deployment (the previous test hopped to the peer).
  await page.goto(`${fake.base}/`);
  await expect(page.locator("#auth")).toHaveText("signed-in:Fake Person");
  // The web's 「退出登录」: POST /api/v1/auth/logout (seen on the partition), then /login.
  await page.locator("#logout").click();
  page = await expectSignedOut();
  expect(fake.logouts).toBe(1);
});

/** The URLs of the overlays (WebContentsViews) over the open windows. */
const overlayUrls = () =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().flatMap((w) =>
      w.contentView.children.map((v) => (v as Electron.WebContentsView).webContents.getURL()),
    ),
  );

/** Signs in again from the page shown (`page`), playing the browser and the callback link. */
async function signInFromPage(from: Page): Promise<void> {
  const opened = (await openedUrls()).length;
  await from.locator("main .lp-btn").click();
  await expect.poll(openedUrls).toHaveLength(opened + 1);
  const url = new URL((await openedUrls())[opened] as string);
  await from.request.get(url.href);
  const signInState = url.searchParams.get("state") as string;
  const code = fake.issueCode(signInState);
  const link = `capybara://auth/callback?${new URLSearchParams({ code, state: signInState, iss: fake.base })}`;
  await app.evaluate(({ app: electronApp }, u) => {
    electronApp.emit("open-url", { preventDefault() {} }, u);
  }, link);
}

test("the same when the logout completes after the /login navigation", async () => {
  // Sign in again from the signed-out page.
  await signInFromPage(page);
  page = await windowOn(`${fake.base}/`);
  await expect(page.locator("#auth")).toHaveText("signed-in:Fake Person");

  // The logout's body (its completion on the partition) is held: the page's fetch resolves on the
  // headers and navigates to /login first. That /login is stopped (it never reaches the server)
  // and the expired page covers the window until the completion ends the sign-out.
  fake.holdLogoutBody = true;
  const before = fake.requests.length;
  await page.locator("#logout").click();
  try {
    await expect.poll(overlayUrls).toEqual(["app://local/main-error.html"]);
  } finally {
    fake.releaseLogout();
  }
  page = await expectSignedOut();
  expect(fake.logouts).toBe(2);
  expect(fake.requests.slice(before).map((r) => r.path)).not.toContain("/login");
});

test("an expired session: the expired page, then back to the page after signing in again", async () => {
  await signInFromPage(page);
  page = await windowOn(`${fake.base}/`);
  await expect(page.locator("#auth")).toHaveText("signed-in:Fake Person");

  // The web's session guard sends the window to /login: stopped, replaced by the local page.
  const before = fake.requests.length;
  await page.evaluate(() => {
    window.location.href = "/login?returnTo=%2Fua";
  });
  const overlay = await windowOn("app://local/main-error.html");
  await expect(overlay.locator("h1")).toHaveText(/^(登录已过期|Your session has expired)$/);
  expect(fake.requests.slice(before).map((r) => r.path)).not.toContain("/login?returnTo=%2Fua");

  await signInFromPage(overlay);
  await expect.poll(overlayUrls).toEqual([]);
  await expect(page).toHaveURL(`${fake.base}/ua`);
});

test("an unreachable platform: the unreachable page, 重试, back when it answers", async () => {
  fake.down = true;
  try {
    await page.goto(`${fake.base}/`);
    const overlay = await windowOn("app://local/main-error.html");
    await expect(overlay.locator("h1")).toHaveText(
      /^(平台暂时连不上|Can’t reach the platform right now)$/,
    );
    // Still down: 重试 probes and the page stays.
    const probes = () => fake.requests.filter((r) => r.path === "/api/v1/meta").length;
    const seen = probes();
    await overlay.locator("main .lp-btn").click();
    await expect.poll(probes).toBeGreaterThan(seen);
    await expect(overlay.locator("main .lp-btn")).toBeEnabled();
    expect(await overlayUrls()).toEqual(["app://local/main-error.html"]);
    fake.down = false;
    await overlay.locator("main .lp-btn").click();
  } finally {
    fake.down = false;
  }
  await expect.poll(overlayUrls).toEqual([]);
  await expect(page.locator("#auth")).toHaveText("signed-in:Fake Person");
});

test("a client navigation to /login (history.pushState) shows the expired page too", async () => {
  await expect(page.locator("#auth")).toHaveText("signed-in:Fake Person");
  // A router's replace/push: no request, only did-navigate-in-page.
  await page.evaluate(() => {
    history.pushState(null, "", "/login?returnTo=%2Fua");
  });
  const overlay = await windowOn("app://local/main-error.html");
  await expect(overlay.locator("h1")).toHaveText(/^(登录已过期|Your session has expired)$/);
  await signInFromPage(overlay);
  await expect.poll(overlayUrls).toEqual([]);
  await expect(page).toHaveURL(`${fake.base}/ua`);
});
