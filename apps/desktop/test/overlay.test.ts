import { describe, expect, test, vi } from "vitest";
import { createLocalPages } from "../src/main/local-pages.ts";
import { type OverlayParent, type OverlayView, showOverlay } from "../src/main/overlay.ts";
import type { PageState } from "../src/shared/local-page.ts";

const state = (): PageState => ({
  page: "expired",
  locale: "zh",
  appearance: { scheme: "dark" },
  controls: null,
  os: "macos",
  appName: "Capybara",
  version: "1.0.0",
});

function fakes() {
  let size = [1280, 800];
  const resize: (() => void)[] = [];
  let destroyed = false;
  const parent = {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentSize: () => size,
    on: vi.fn((_e: "resize", l: () => void) => resize.push(l)),
    removeListener: vi.fn((_e: "resize", l: () => void) => {
      resize.splice(resize.indexOf(l), 1);
    }),
    isDestroyed: () => destroyed,
  } satisfies OverlayParent;
  let closed = false;
  const view = {
    webContents: {
      id: 77,
      send: vi.fn(),
      loadURL: vi.fn(async (_url: string) => undefined),
      isDestroyed: () => closed,
      close: vi.fn(() => {
        closed = true;
      }),
      focus: vi.fn(),
    },
    setBounds: vi.fn(),
    setBackgroundColor: vi.fn(),
  } satisfies OverlayView;
  return {
    parent,
    view,
    resize: (w: number, h: number) => {
      size = [w, h];
      for (const l of [...resize]) l();
    },
    listeners: () => resize.length,
    destroy: () => {
      destroyed = true;
    },
  };
}

describe("the error overlay", () => {
  test("covers the window's content, follows resizes, and is registered as main-error", () => {
    const f = fakes();
    const localPages = createLocalPages();
    const harden = vi.fn();
    const o = showOverlay({ createView: () => f.view, localPages, harden }, f.parent, {
      profileId: "p1",
      state,
      background: "#0a0a0a",
    });
    expect(harden).toHaveBeenCalledWith(f.view.webContents);
    expect(f.view.setBackgroundColor).toHaveBeenCalledWith("#0a0a0a");
    expect(f.parent.contentView.addChildView).toHaveBeenCalledWith(f.view);
    expect(f.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 800 });
    expect(f.view.webContents.loadURL).toHaveBeenCalledWith("app://local/main-error.html");
    expect(f.view.webContents.focus).toHaveBeenCalled();
    expect(localPages.kindOf(f.view.webContents)).toBe("main-error");
    expect(localPages.entries()[0]?.profileId).toBe("p1");
    f.resize(900, 600);
    expect(f.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 900, height: 600 });
    expect(o.contents).toBe(f.view.webContents);
  });

  test("push sends this page only", () => {
    const f = fakes();
    const localPages = createLocalPages();
    const other = { id: 5, send: vi.fn() };
    localPages.register(other, { kind: "onboarding", state });
    const o = showOverlay({ createView: () => f.view, localPages }, f.parent, {
      profileId: "p1",
      state,
      background: "#000000",
    });
    o.push();
    expect(f.view.webContents.send).toHaveBeenCalledTimes(1);
    expect(other.send).not.toHaveBeenCalled();
  });

  test("remove: detached, unregistered, closed, the resize listener gone; once", () => {
    const f = fakes();
    const localPages = createLocalPages();
    const o = showOverlay({ createView: () => f.view, localPages }, f.parent, {
      profileId: "p1",
      state,
      background: "#000000",
    });
    o.remove();
    o.remove();
    expect(o.isRemoved()).toBe(true);
    expect(f.parent.contentView.removeChildView).toHaveBeenCalledTimes(1);
    expect(f.view.webContents.close).toHaveBeenCalledTimes(1);
    expect(localPages.kindOf(f.view.webContents)).toBeUndefined();
    expect(f.listeners()).toBe(0);
    // A push after removal sends nothing.
    o.push();
    expect(f.view.webContents.send).not.toHaveBeenCalled();
  });

  test("remove after the window was destroyed still closes the view", () => {
    const f = fakes();
    const o = showOverlay({ createView: () => f.view, localPages: createLocalPages() }, f.parent, {
      profileId: "p1",
      state,
      background: "#000000",
    });
    f.destroy();
    o.remove();
    expect(f.parent.contentView.removeChildView).not.toHaveBeenCalled();
    expect(f.view.webContents.close).toHaveBeenCalledTimes(1);
  });
});
