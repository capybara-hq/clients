import { expect, test, vi } from "vitest";
import {
  CHECK_INTERVAL_MS,
  intervalScheduler,
  setupUpdates,
  type UpdaterLike,
  updateNotice,
} from "../src/main/updates.ts";

function fakeUpdater() {
  const listeners: Record<string, (arg: never) => void> = {};
  const feeds: unknown[] = [];
  let checks = 0;
  let installs = 0;
  const updater: UpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    setFeedURL: (feed) => {
      feeds.push(feed);
    },
    checkForUpdates: async () => {
      checks += 1;
    },
    quitAndInstall: () => {
      installs += 1;
    },
    on: ((event: string, listener: (arg: never) => void) => {
      listeners[event] = listener;
    }) as UpdaterLike["on"],
  };
  return { updater, listeners, feeds, checks: () => checks, installs: () => installs };
}

/** A manual scheduler: `tick()` runs every scheduled callback once. */
function fakeScheduler() {
  const jobs = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = next++;
      jobs.set(id, { fn, ms });
      return () => {
        jobs.delete(id);
      };
    },
    tick: () => {
      for (const job of [...jobs.values()]) job.fn();
    },
    intervals: () => [...jobs.values()].map((j) => j.ms),
  };
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
  const handle = setupUpdates({
    autoUpdater: f.updater,
    managed: {},
    schedule: fakeScheduler().schedule,
  });
  await handle.check();
  expect(f.feeds).toEqual([{ provider: "github", owner: "capybara-hq", repo: "clients" }]);
  expect(f.checks()).toBe(1);
});

test("uses the managed updateFeed as a generic provider", () => {
  const f = fakeUpdater();
  const handle = setupUpdates({
    autoUpdater: f.updater,
    managed: { updateFeed: "https://updates.example.com/capybara/" },
    schedule: fakeScheduler().schedule,
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

test("checks again every 6 hours until disposed", async () => {
  const f = fakeUpdater();
  const clock = fakeScheduler();
  const handle = setupUpdates({ autoUpdater: f.updater, managed: {}, schedule: clock.schedule });
  expect(clock.intervals()).toEqual([CHECK_INTERVAL_MS]);
  expect(CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  expect(f.checks()).toBe(0);
  clock.tick();
  clock.tick();
  await Promise.resolve();
  expect(f.checks()).toBe(2);
  handle.dispose();
  expect(clock.intervals()).toEqual([]);
  clock.tick();
  expect(f.checks()).toBe(2);
});

test("with updates off nothing is scheduled", () => {
  const clock = fakeScheduler();
  const off = setupUpdates({
    autoUpdater: fakeUpdater().updater,
    managed: { autoUpdate: false },
    schedule: clock.schedule,
  });
  setupUpdates({
    autoUpdater: fakeUpdater().updater,
    managed: { updateFeed: "ftp://x" },
    schedule: clock.schedule,
  });
  expect(clock.intervals()).toEqual([]);
  expect(() => off.dispose()).not.toThrow();
});

test("a downloaded update is announced once per version; restart installs it", () => {
  const f = fakeUpdater();
  const announced: string[] = [];
  const handle = setupUpdates({
    autoUpdater: f.updater,
    managed: {},
    schedule: fakeScheduler().schedule,
    onDownloaded: (info) => announced.push(info.version),
  });
  f.listeners["update-downloaded"]?.({ version: "1.2.3" } as never);
  // A later check finds the same download again: no second announcement.
  f.listeners["update-downloaded"]?.({ version: "1.2.3" } as never);
  expect(announced).toEqual(["1.2.3"]);
  f.listeners["update-downloaded"]?.({ version: "1.2.4" } as never);
  expect(announced).toEqual(["1.2.3", "1.2.4"]);
  expect(f.installs()).toBe(0);
  handle.restart();
  expect(f.installs()).toBe(1);
});

test("a failing announcement is logged, not thrown", () => {
  const f = fakeUpdater();
  const errors: string[] = [];
  setupUpdates({
    autoUpdater: f.updater,
    managed: {},
    schedule: fakeScheduler().schedule,
    logger: { info: () => {}, error: (m) => errors.push(m) },
    onDownloaded: () => {
      throw new Error("no notifications");
    },
  });
  expect(() => f.listeners["update-downloaded"]?.({ version: "2.0.0" } as never)).not.toThrow();
  expect(errors.some((e) => e.includes("no notifications"))).toBe(true);
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
    schedule: fakeScheduler().schedule,
    logger: { info: () => {}, error: (m) => errors.push(m) },
  });
  await expect(handle.check()).resolves.toBeUndefined();
  expect(errors).toEqual(["update check failed: offline"]);
});

test("the default scheduler unrefs its interval and clears it", () => {
  const unref = vi.fn();
  const cleared: unknown[] = [];
  const timer = { unref };
  const schedule = intervalScheduler({
    setInterval: (_fn: () => void, ms: number) => {
      expect(ms).toBe(CHECK_INTERVAL_MS);
      return timer;
    },
    clearInterval: (t: unknown) => {
      cleared.push(t);
    },
  });
  const cancel = schedule(() => {}, CHECK_INTERVAL_MS);
  expect(unref).toHaveBeenCalledTimes(1);
  cancel();
  expect(cleared).toEqual([timer]);
});

test("the update notice: one localized notification whose click restarts into the update", () => {
  const shown: { options: { title: string; body: string }; click?: () => void }[] = [];
  class FakeNotification {
    static isSupported = () => true;
    entry: (typeof shown)[number];
    constructor(options: { title: string; body: string }) {
      this.entry = { options };
      shown.push(this.entry);
    }
    on(event: string, listener: () => void) {
      if (event === "click") this.entry.click = listener;
    }
    show() {}
  }
  const restart = vi.fn();
  const zh = updateNotice({ Notification: FakeNotification, locale: "zh", restart });
  zh({ version: "1.2.3" });
  expect(shown[0]?.options).toEqual({
    title: "Capybara 有新版本",
    body: "1.2.3 已下载，退出时安装。点按此处立即重新启动并更新。",
  });
  expect(restart).not.toHaveBeenCalled();
  shown[0]?.click?.();
  expect(restart).toHaveBeenCalledTimes(1);
  updateNotice({ Notification: FakeNotification, locale: "en", restart })({ version: "2.0.0" });
  expect(shown[1]?.options.title).toBe("A new version of Capybara is ready");
  expect(shown[1]?.options.body).toContain("2.0.0");
});

test("without notification support the notice shows nothing", () => {
  const ctor = vi.fn();
  class Unsupported {
    static isSupported = () => false;
    constructor() {
      ctor();
    }
    on() {}
    show() {}
  }
  updateNotice({ Notification: Unsupported, locale: "en", restart: vi.fn() })({ version: "1" });
  expect(ctor).not.toHaveBeenCalled();
});
