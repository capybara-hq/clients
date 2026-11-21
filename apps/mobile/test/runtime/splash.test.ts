import { describe, expect, test, vi } from "vitest";
import { createSplash, SPLASH_FALLBACK_MS } from "../../src/runtime/splash.ts";

function fakeScheduler() {
  const tasks: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    tasks,
    schedule: vi.fn((fn: () => void, ms: number) => {
      const task = { fn, ms, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    }),
    run() {
      for (const t of tasks.splice(0)) if (!t.cancelled) t.fn();
    },
  };
}

describe("createSplash", () => {
  test("ready() hides once", () => {
    const hide = vi.fn();
    const s = fakeScheduler();
    const splash = createSplash({ hide, schedule: s.schedule });
    splash.ready();
    splash.ready();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  test("loaded() hides after 3000 ms on the scheduler", () => {
    const hide = vi.fn();
    const s = fakeScheduler();
    const splash = createSplash({ hide, schedule: s.schedule });
    splash.loaded();
    expect(SPLASH_FALLBACK_MS).toBe(3000);
    expect(s.schedule).toHaveBeenCalledWith(expect.any(Function), 3000);
    expect(hide).not.toHaveBeenCalled();
    s.run();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  test("a second loaded() does not schedule again", () => {
    const s = fakeScheduler();
    const splash = createSplash({ hide: vi.fn(), schedule: s.schedule });
    splash.loaded();
    splash.loaded();
    expect(s.schedule).toHaveBeenCalledTimes(1);
  });

  test("failed() hides at once and cancels the fallback", () => {
    const hide = vi.fn();
    const s = fakeScheduler();
    const splash = createSplash({ hide, schedule: s.schedule });
    splash.loaded();
    splash.failed();
    expect(hide).toHaveBeenCalledTimes(1);
    s.run();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  test("a later ready() does nothing", () => {
    const hide = vi.fn();
    const s = fakeScheduler();
    const splash = createSplash({ hide, schedule: s.schedule });
    splash.loaded();
    s.run();
    splash.ready();
    splash.failed();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  test("ready() before the fallback fires cancels it", () => {
    const hide = vi.fn();
    const s = fakeScheduler();
    const splash = createSplash({ hide, schedule: s.schedule });
    splash.loaded();
    splash.ready();
    expect(s.tasks[0]?.cancelled).toBe(true);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  test("a throwing hide still counts as hidden", () => {
    const hide = vi.fn(() => {
      throw new Error("plugin gone");
    });
    const splash = createSplash({ hide, schedule: fakeScheduler().schedule });
    splash.ready();
    splash.ready();
    expect(hide).toHaveBeenCalledTimes(1);
  });
});
