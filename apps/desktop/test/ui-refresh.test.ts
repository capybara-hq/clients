import { describe, expect, test, vi } from "vitest";
import { createUiRefresh } from "../src/main/ui-refresh.ts";

describe("createUiRefresh", () => {
  test("a state change rebuilds the menus and never touches the Dock icon", () => {
    const render = vi.fn();
    const updateDock = vi.fn(async () => undefined);
    const ui = createUiRefresh({ render, updateDock });
    ui.stateChanged();
    ui.stateChanged();
    expect(render).toHaveBeenCalledTimes(2);
    expect(updateDock).not.toHaveBeenCalled();
  });

  test("a profile change rebuilds the menus and re-evaluates the Dock icon", () => {
    const render = vi.fn();
    const updateDock = vi.fn(async () => undefined);
    createUiRefresh({ render, updateDock }).profilesChanged();
    expect(render).toHaveBeenCalledTimes(1);
    expect(updateDock).toHaveBeenCalledTimes(1);
  });

  test("a failing Dock update is logged, not thrown", async () => {
    const log = vi.fn();
    const ui = createUiRefresh({
      render: vi.fn(),
      updateDock: async () => {
        throw new Error("boom");
      },
      log,
    });
    expect(() => ui.profilesChanged()).not.toThrow();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
  });
});
