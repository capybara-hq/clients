// End-to-end smoke of the desktop app against a fake deployment (no network, no real sign-in, no
// OS protocol handler, no system browser). See e2e/README.md for what this covers and what stays
// manual. Run: pnpm e2e
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  type FakeDeployment,
  startFakeDeployment,
} from "../../../packages/shell/test/fixtures/fake-deployment.ts";

// What the page's world sees (installed by the preload); only the parts the spec reads.
interface PageShell {
  insets: Record<string, number>;
  controls: Record<string, number> | null;
  capabilities: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
}
const appDir = fileURLToPath(new URL("..", import.meta.url));

let app: ElectronApplication;
let userData: string;
let fake: FakeDeployment;
let peer: FakeDeployment;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  peer = await startFakeDeployment();
  fake = await startFakeDeployment({ peer: peer.base });
  userData = mkdtempSync(join(tmpdir(), "capybara-e2e-"));
  // Electron started as Node would not open windows: ELECTRON_RUN_AS_NODE stays out.
  const env = Object.fromEntries(
    Object.entries({ ...process.env, CAPYBARA_E2E_USER_DATA: userData }).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  app = await electron.launch({ args: [appDir], cwd: appDir, env });
  // `use.trace` records nothing for `_electron.launch`: trace the app's context here and keep the
  // trace only when a test failed (afterAll).
  await app.context().tracing.start({ screenshots: true, snapshots: true });
  // The system browser must not open: capture what the app would have opened.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __opened?: string[] }).__opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
});

let failed = false;
test.afterEach(() => {
  const info = test.info();
  if (info.status !== info.expectedStatus) failed = true;
});

test.afterAll(async () => {
  await app?.context().tracing.stop(failed ? { path: test.info().outputPath("trace.zip") } : {});
  await app?.close();
  await fake?.close();
  await peer?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

const openedUrls = () => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []);

interface ShellReport {
  type: string;
  kind?: string;
  platform?: string;
  version?: number;
  capabilities: string[];
}

const shellReport = async (p: Page): Promise<ShellReport> =>
  JSON.parse((await p.locator("#shell").textContent()) ?? "{}") as ShellReport;

test("the address page: app://address origin, discovery through meta, open", async () => {
  page = await app.firstWindow();
  await expect(page).toHaveURL("app://address/index.html");

  // Carried check (a): the address page's frame origin, as main sees it.
  const origins = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.webContents.mainFrame.origin),
  );
  expect(origins).toEqual(["app://address"]);

  await page.locator("#address").fill(fake.base);
  await page.locator("#continue").click();
  // The IPC answered, so main accepted the sender frame (senderFrame.origin is app://address).
  await expect(page.locator("#found")).toBeVisible();
  await expect(page.locator("#name")).toHaveText("Fake Deployment");
  await expect(page.locator("#icon")).toHaveAttribute("src", /^data:image\/png;base64,/);

  const next = app.waitForEvent("window");
  await page.locator("#open").click();
  page = await next;
  await expect(page).toHaveURL(`${fake.base}/`);
  expect(fake.requests.some((r) => r.path === "/api/v1/meta")).toBe(true);
});

test("the deployment page sees capybaraShell with its capabilities", async () => {
  // Carried check (b): executeInMainWorld installed the object on the origin's top frame.
  await expect(page.locator("#auth")).toHaveText("signed-out");
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
  expect(await openedUrls()).toEqual([]);
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
  await page.locator("#signin").click();
  await expect.poll(openedUrls).toHaveLength(1);
  const url = new URL((await openedUrls())[0] as string);
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

  // The exchange succeeded: the window reloads and the server saw the cookie.
  await expect(page.locator("#auth")).toHaveText("signed-in:Fake Person");
  expect(fake.accepted).toBe(1);
  expect(fake.refused).toEqual([]);

  const profiles = JSON.parse(readFileSync(join(userData, "profiles.json"), "utf8")) as {
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
  // log. The count must still be 1. It does not prove anything about a replay that is delayed.
  await page.evaluate(() => fetch("/sentinel").then((r) => r.text()));
  const seen = fake.requests.map((r) => r.path);
  expect(seen.lastIndexOf("/sentinel")).toBeGreaterThan(-1);
  expect(seen.filter((p) => p === "/api/v1/app-auth/token")).toHaveLength(1);
  await page.reload();
  await expect(page.locator("#auth")).toHaveText("signed-in:Fake Person");
  expect(fake.accepted).toBe(1);
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
