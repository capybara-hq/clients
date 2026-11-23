import { describe, expect, test, vi } from "vitest";
import { createConfirmGate } from "../src/main/ipc.ts";
import type { Profile } from "../src/main/profiles.ts";
import { createProfileRemoval, type ProfileRemovalDeps } from "../src/main/remove-profile.ts";
import type { ShellDialogOptions } from "../src/main/shell-dialog.ts";

const p1: Profile = {
  id: "p1",
  signedIn: true,
  base: "https://a.example.com/team",
  origin: "https://a.example.com",
  name: "Example",
};

// Answers by meaning, mapped through the options the dialog was given, so a drift between the
// index the code passes and the one it compares to fails here.
type Answer = "confirm" | "cancel";

function setup(over: Partial<ProfileRemovalDeps> = {}, answers: Answer[] = ["confirm"]) {
  const order: string[] = [];
  const boxes: { parent: unknown; options: ShellDialogOptions }[] = [];
  const parent = { id: "window" };
  const gate = createConfirmGate();
  const deps: ProfileRemovalDeps = {
    getProfile: (id) => (id === p1.id ? p1 : undefined),
    isRemovable: () => true,
    gate,
    dialogParent: () => parent,
    showDialog: async (box, options) => {
      boxes.push({ parent: box, options });
      order.push("confirm");
      const a = answers.shift() ?? "cancel";
      return { response: a === "confirm" ? (options.confirmId ?? -1) : options.cancelId };
    },
    locale: "zh",
    closeProfileWindows: vi.fn(() => {
      order.push("close windows");
    }),
    removeProfile: vi.fn(async () => {
      order.push("remove");
    }),
    onRemoved: vi.fn(() => {
      order.push("refresh");
    }),
    log: vi.fn(),
    ...over,
  };
  return { removal: createProfileRemoval(deps), deps, order, boxes, parent, gate };
}

describe("removing a platform (spec 6.3)", () => {
  test("asks, closes the windows before removing, then refreshes", async () => {
    const { removal, deps, order } = setup();
    await removal.remove("p1");
    expect(order).toEqual(["confirm", "close windows", "remove", "refresh"]);
    expect(deps.closeProfileWindows).toHaveBeenCalledWith("p1");
    expect(deps.removeProfile).toHaveBeenCalledWith("p1");
  });

  test("the confirmation names the platform and its host, attached to a live window", async () => {
    const { removal, boxes, parent } = setup();
    await removal.remove("p1");
    expect(boxes[0]?.parent).toBe(parent);
    expect(boxes[0]?.options).toEqual({
      title: "要移除 Example（a.example.com）吗？",
      detail: expect.stringContaining("本地数据"),
      buttons: ["取消", "移除"],
      defaultId: 0,
      cancelId: 0,
      confirmId: 1,
      tone: "danger",
      platform: { name: "Example", host: "a.example.com" },
      profileId: "p1",
    });
  });

  test("a platform without a name is named by its host; English from the catalog", async () => {
    const unnamed = { ...p1, name: "a.example.com" };
    const { removal, boxes } = setup({ getProfile: () => unnamed, locale: "en" });
    await removal.remove("p1");
    expect(boxes[0]?.options.title).toBe("Remove a.example.com?");
    expect(boxes[0]?.options.buttons).toEqual(["Cancel", "Remove"]);
  });

  test("cancel (the default button) does nothing", async () => {
    const { removal, deps, order } = setup({}, ["cancel"]);
    await removal.remove("p1");
    expect(order).toEqual(["confirm"]);
    expect(deps.closeProfileWindows).not.toHaveBeenCalled();
    expect(deps.removeProfile).not.toHaveBeenCalled();
    expect(deps.onRemoved).not.toHaveBeenCalled();
  });

  test("a managed profile under lockDeployments is never removed", async () => {
    const { removal, order } = setup({ isRemovable: () => false });
    await removal.remove("p1");
    expect(order).toEqual([]);
  });

  test("an unknown profile does nothing", async () => {
    const { removal, order } = setup();
    await removal.remove("nope");
    expect(order).toEqual([]);
  });

  test("one dialog at a time per platform: a second removal while one asks is dropped", async () => {
    let confirm: () => void = () => {};
    const { removal, deps, gate } = setup({
      showDialog: (_parent, options) =>
        new Promise((resolve) => {
          confirm = () => resolve({ response: options.confirmId ?? -1 });
        }),
    });
    const first = removal.remove("p1");
    await removal.remove("p1");
    // Another confirming call for the same platform is refused while this one is open.
    expect(gate.isConfirmingCallAllowed("p1", true)).toBe("busy");
    confirm();
    await first;
    expect(deps.removeProfile).toHaveBeenCalledTimes(1);
    // The slot is released afterwards.
    expect(gate.isConfirmingCallAllowed("p1", true)).toBe("ok");
  });

  test("a failed removal still releases the slot and refreshes", async () => {
    const { removal, deps, gate } = setup({
      removeProfile: async () => {
        throw new Error("disk full");
      },
    });
    await removal.remove("p1");
    expect(deps.log).toHaveBeenCalledWith("the platform could not be removed", expect.any(Error));
    expect(deps.onRemoved).toHaveBeenCalledTimes(1);
    expect(gate.isConfirmingCallAllowed("p1", true)).toBe("ok");
  });
});

describe("the removal dialog's language (spec 12)", () => {
  test("the profile's own language, not the app's", async () => {
    const { removal, boxes } = setup({
      locale: (profileId) => (profileId === "p1" ? "en" : "zh"),
    });
    await removal.remove("p1");
    expect(boxes[0]?.options.buttons).toEqual(["Cancel", "Remove"]);
  });
});
