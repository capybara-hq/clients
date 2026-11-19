import { expect, test } from "vitest";
import { setupUpdates, type UpdaterLike } from "../src/main/updates.ts";

function fakeUpdater() {
  const listeners: Record<string, (arg: never) => void> = {};
  const feeds: unknown[] = [];
  let checks = 0;
  const updater: UpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    setFeedURL: (feed) => {
      feeds.push(feed);
    },
    checkForUpdates: async () => {
      checks += 1;
    },
    on: ((event: string, listener: (arg: never) => void) => {
      listeners[event] = listener;
    }) as UpdaterLike["on"],
  };
  return { updater, listeners, feeds, checks: () => checks };
}

test("does nothing when managed autoUpdate is false", async () => {
  const f = fakeUpdater();
  const handle = setupUpdates({ autoUpdater: f.updater, managed: { autoUpdate: false } });
  await handle.check();
  expect(handle.enabled).toBe(false);
  expect(f.feeds).toEqual([]);
  expect(f.checks()).toBe(0);
  expect(Object.keys(f.listeners)).toEqual([]);
});

test("uses the brand's GitHub feed by default", async () => {
  const f = fakeUpdater();
  const handle = setupUpdates({ autoUpdater: f.updater, managed: {} });
  await handle.check();
  expect(f.feeds).toEqual([{ provider: "github", owner: "capybara-hq", repo: "clients" }]);
  expect(f.checks()).toBe(1);
});

test("uses the managed updateFeed as a generic provider", () => {
  const f = fakeUpdater();
  const handle = setupUpdates({
    autoUpdater: f.updater,
    managed: { updateFeed: "https://updates.example.com/capybara/" },
  });
  expect(handle.feed).toEqual({
    provider: "generic",
    url: "https://updates.example.com/capybara/",
  });
  expect(f.feeds).toEqual([handle.feed]);
});

test("an invalid managed feed turns updates off rather than falling back to GitHub", () => {
  const f = fakeUpdater();
  const handle = setupUpdates({ autoUpdater: f.updater, managed: { updateFeed: "ftp://x" } });
  expect(handle.enabled).toBe(false);
  expect(f.feeds).toEqual([]);
});

test("runs afterUpdate when an update is downloaded, and survives its failure", async () => {
  const f = fakeUpdater();
  const seen: string[] = [];
  const errors: string[] = [];
  setupUpdates({
    autoUpdater: f.updater,
    managed: {},
    logger: { info: () => {}, error: (m) => errors.push(m) },
    afterUpdate: async (info) => {
      seen.push(info.version);
      throw new Error("boom");
    },
  });
  f.listeners["update-downloaded"]?.({ version: "1.2.3" } as never);
  await Promise.resolve();
  await Promise.resolve();
  expect(seen).toEqual(["1.2.3"]);
  expect(errors.some((e) => e.includes("boom"))).toBe(true);
});

test("a failed check is logged, not thrown", async () => {
  const f = fakeUpdater();
  f.updater.checkForUpdates = async () => {
    throw new Error("offline");
  };
  const errors: string[] = [];
  const handle = setupUpdates({
    autoUpdater: f.updater,
    managed: {},
    logger: { info: () => {}, error: (m) => errors.push(m) },
  });
  await expect(handle.check()).resolves.toBeUndefined();
  expect(errors).toEqual(["update check failed: offline"]);
});
