import { describe, expect, test } from "vitest";
import { initialBounds, type Rect, trackBounds } from "../src/main/window-bounds.ts";

const primary = { workArea: { x: 0, y: 25, width: 1920, height: 1055 }, primary: true };
const second = { workArea: { x: 1920, y: 0, width: 1280, height: 1024 } };

describe("initialBounds", () => {
  test("centers 1280x800 on the primary work area when nothing is saved", () => {
    expect(initialBounds(undefined, [second, primary])).toEqual({
      x: 320,
      y: 153,
      width: 1280,
      height: 800,
    });
  });

  test("keeps a saved rectangle that is visible on any display", () => {
    const saved = { x: 2000, y: 100, width: 900, height: 700 };
    expect(initialBounds(saved, [primary, second])).toEqual(saved);
  });

  test("replaces a rectangle on a display that is gone", () => {
    const saved = { x: 2000, y: 100, width: 900, height: 700 };
    expect(initialBounds(saved, [primary]).x).toBe(320);
  });

  test("a sliver under 100x100 does not count as visible", () => {
    expect(initialBounds({ x: 1850, y: 100, width: 900, height: 700 }, [primary]).width).toBe(1280);
    expect(initialBounds({ x: 1820, y: 100, width: 900, height: 700 }, [primary]).x).toBe(1820);
    expect(initialBounds({ x: 100, y: 1000, width: 900, height: 700 }, [primary]).width).toBe(1280);
  });

  test("shrinks the default to a small work area", () => {
    const small = { workArea: { x: 0, y: 0, width: 1024, height: 700 }, primary: true };
    expect(initialBounds(undefined, [small])).toEqual({ x: 0, y: 0, width: 1024, height: 700 });
  });
});

function fakeWindow() {
  const listeners = new Map<string, () => void>();
  let bounds: Rect = { x: 0, y: 0, width: 800, height: 600 };
  const state = { maximized: false };
  return {
    win: {
      getBounds: () => bounds,
      isMaximized: () => state.maximized,
      on: (e: string, l: () => void) => listeners.set(e, l),
    },
    emit: (e: string) => listeners.get(e)?.(),
    setBounds: (b: Rect) => {
      bounds = b;
    },
    state,
  };
}

function fakeScheduler() {
  const tasks = new Map<number, () => void>();
  let n = 0;
  return {
    scheduler: {
      set: (fn: () => void) => {
        tasks.set(++n, fn);
        return n;
      },
      clear: (h: unknown) => {
        tasks.delete(h as number);
      },
    },
    runAll: () => {
      for (const [k, f] of [...tasks]) {
        tasks.delete(k);
        f();
      }
    },
    size: () => tasks.size,
  };
}

describe("trackBounds", () => {
  test("debounces resize and move into one save", () => {
    const f = fakeWindow();
    const s = fakeScheduler();
    const saved: Rect[] = [];
    trackBounds(f.win, (b) => saved.push(b), s.scheduler);
    f.emit("resize");
    f.emit("move");
    f.emit("resize");
    expect(s.size()).toBe(1);
    f.setBounds({ x: 5, y: 6, width: 700, height: 500 });
    s.runAll();
    expect(saved).toEqual([{ x: 5, y: 6, width: 700, height: 500 }]);
  });

  test("close saves immediately and cancels the pending save", () => {
    const f = fakeWindow();
    const s = fakeScheduler();
    const saved: Rect[] = [];
    trackBounds(f.win, (b) => saved.push(b), s.scheduler);
    f.emit("move");
    f.emit("close");
    expect(saved).toHaveLength(1);
    expect(s.size()).toBe(0);
  });

  test("a maximized window is not saved", () => {
    const f = fakeWindow();
    const s = fakeScheduler();
    const saved: Rect[] = [];
    trackBounds(f.win, (b) => saved.push(b), s.scheduler);
    f.state.maximized = true;
    f.emit("resize");
    s.runAll();
    f.emit("close");
    expect(saved).toEqual([]);
  });
});
