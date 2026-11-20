// End-to-end across restarts (desktop spec §6.3, §6.9): the same userData directory launched again
// opens a signed-in profile's main window and a signed-out profile's signed-out small window; the
// 「平台」 menu's sign-out (confirmed in the shell dialog) posts the logout and clears the session
// cookies; a deployment page has no local page bridge; an abandoned provisional partition is
// removed at start. Every wait is on a condition. Run: pnpm e2e
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  type FakeDeployment,
  startFakeDeployment,
} from "../../../packages/shell/test/fixtures/fake-deployment.ts";
import { type Harness, launchApp } from "./harness.ts";

const SMALL = "app://local/onboarding.html";
const DIALOG = "app://local/dialog.html";
const SIGNED_OUT = /^(已退出|Signed out of) Fake Deployment$/;
const ORPHAN = "profile-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let h: Harness;
let fake: FakeDeployment;
let userData: string;
let main: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fake = await startFakeDeployment();
  h = await launchApp();
  userData = h.userData;
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
    await fake?.close();
  }
});

const partitions = () => join(userData, "app", "Partitions");
const profileId = () => {
  const p = h.profiles().find((x) => x.base === fake.base);
  expect(p).toBeDefined();
  return (p as { id: string }).id;
};

/** Quits and launches the app again on the same userData directory. */
async function restart(): Promise<void> {
  await h.close(failed, test.info().outputPath("trace-before-restart.zip"), {
    keepUserData: true,
  });
  h = await launchApp({ userData });
}

test("restart with a signed-in profile: straight to its main window; no bridge there", async () => {
  const small = await h.windowOn(SMALL);
  await small.locator("#address").fill(fake.base);
  await small.locator("#address").press("Enter");
  await expect(small.locator("h1")).toContainText("Fake Deployment");
  await small.locator("main .lp-btn").click();
  await expect.poll(async () => (await h.openedUrls()).length).toBe(1);
  const url = new URL((await h.openedUrls())[0] as string);
  await small.request.get(url.href);
  const state = url.searchParams.get("state") as string;
  await h.deepLink(
    `capybara://auth/callback?${new URLSearchParams({ code: fake.issueCode(state), state, iss: fake.base })}`,
  );
  main = await h.windowOn(`${fake.base}/`);
  await expect(main.locator("#auth")).toHaveText("signed-in:Fake Person");
  const id = profileId();
  // The profile's partition lives where the start-up sweep expects it.
  await expect.poll(() => existsSync(join(partitions(), `profile-${id}`))).toBe(true);
  // A provisional partition left behind by a quit in the middle of a sign-in.
  mkdirSync(join(partitions(), ORPHAN), { recursive: true });
  writeFileSync(join(partitions(), ORPHAN, "Cookies"), "x");

  await restart();
  main = await h.windowOn(`${fake.base}/`);
  await expect(main.locator("#auth")).toHaveText("signed-in:Fake Person");
  await expect.poll(() => h.windowUrls()).toEqual([`${fake.base}/`]);
  expect(existsSync(join(partitions(), ORPHAN))).toBe(false);
  expect(existsSync(join(partitions(), `profile-${id}`))).toBe(true);
  // The deployment's page never sees the local pages' bridge.
  expect(
    await main.evaluate(() => typeof (window as { capybaraLocal?: unknown }).capybaraLocal),
  ).toBe("undefined");
});

test("the 「平台」 menu's sign-out: confirmed, the logout posted, the session cookies gone", async () => {
  const id = profileId();
  expect(await h.cookies(id, fake.base, "cap_at")).toHaveLength(1);
  const logouts = fake.logouts;
  await h.app.evaluate(({ Menu }) => {
    // The 「平台」 menu by its label (either language), not by position.
    const platform = Menu.getApplicationMenu()?.items.find((i) =>
      ["Platform", "平台"].includes(i.label),
    )?.submenu;
    const item = platform?.items.find((i) => /^(Sign Out of |退出登录 )/.test(i.label));
    if (!item) throw new Error("no sign-out item");
    item.click();
  });
  const dialog = await h.windowOn(DIALOG);
  // A run in the background never gets OS focus (macOS gives it to the frontmost app), and the
  // confirming button needs the dialog focused: the dialog window reports focus as the OS would
  // when the person clicks it (the 500 ms lockout from that moment stays real).
  await h.app.evaluate(({ BrowserWindow }) => {
    const d = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.getURL() === "app://local/dialog.html",
    );
    if (!d) throw new Error("no dialog window");
    d.isFocused = () => true;
    d.emit("focus");
  });
  // The confirming button takes no answer for 500 ms after the dialog shows or gains focus: click
  // until the dialog answers (it closes).
  await expect
    .poll(async () => {
      if (!dialog.isClosed()) {
        await dialog
          .locator(".dlg-actions button")
          .last()
          .click({ timeout: 1000 })
          .catch(() => undefined);
      }
      return dialog.isClosed();
    })
    .toBe(true);
  await expect.poll(() => fake.logouts).toBe(logouts + 1);
  const small = await h.windowOn(SMALL);
  await expect(small.locator("h1")).toHaveText(SIGNED_OUT);
  await expect.poll(() => h.windowUrls()).toEqual([SMALL]);
  await expect.poll(async () => (await h.cookies(id, fake.base, "cap_at")).length).toBe(0);
  expect(await h.cookies(id, fake.base, "cap_rt")).toHaveLength(0);
});

test("restart with a signed-out profile: the signed-out small window", async () => {
  await restart();
  const small = await h.windowOn(SMALL);
  await expect(small.locator("h1")).toHaveText(SIGNED_OUT);
  await expect.poll(() => h.windowUrls()).toEqual([SMALL]);
  expect(h.profiles().find((p) => p.base === fake.base)?.signedIn).toBe(false);
});
