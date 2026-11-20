import { describe, expect, test } from "vitest";
import { createDialogGate } from "../../src/runtime/dialog-gate.ts";

describe("the dialog gate", () => {
  test("needs an activation", () => {
    const gate = createDialogGate();
    expect(gate.enter("p1", false)).toBe("no_activation");
    // A refused call takes no slot.
    expect(gate.enter("p1", true)).toBe("ok");
  });

  test("one dialog per profile until released", () => {
    const gate = createDialogGate();
    expect(gate.enter("p1", true)).toBe("ok");
    expect(gate.enter("p1", true)).toBe("busy");
    expect(gate.enter("p2", true)).toBe("ok");
    gate.release("p1");
    expect(gate.enter("p1", true)).toBe("ok");
  });
});
