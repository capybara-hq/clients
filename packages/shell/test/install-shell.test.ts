import { describe, expect, test, vi } from "vitest";
import { installShellEnvironment, type ShellBridge, type ShellInit } from "../src/install-shell.ts";

const mobile: ShellInit & { kind: "mobile" } = {
  kind: "mobile",
  origin: "https://capybara.example.com",
  platform: "ios",
  shellVersion: "1.2.3",
  insets: { top: 0, right: 0, bottom: 83, left: 0 },
  capabilities: { "haptics@1": ["impact"], "share@1": ["share"] },
};

function bridge(): ShellBridge & {
  fire(s: Parameters<Parameters<ShellBridge["onChange"]>[0]>[0]): void;
} {
  let changed: Parameters<ShellBridge["onChange"]>[0] | undefined;
  return {
    call: vi.fn(async () => ({ ok: true, value: 1 }) as const),
    onChange(l) {
      changed = l;
    },
    subscribe: vi.fn(() => () => {}),
    fire(s) {
      changed?.(s);
    },
  };
}

describe("installShellEnvironment for mobile", () => {
  test("defines a frozen, unreplaceable global with kind mobile and no controls", () => {
    const target: Record<string, unknown> = {};
    installShellEnvironment(mobile, bridge(), target);
    const shell = target.capybaraShell as Record<string, unknown>;
    expect(shell.version).toBe(1);
    expect(shell.kind).toBe("mobile");
    expect(shell.platform).toBe("ios");
    expect(shell.shellVersion).toBe("1.2.3");
    expect("controls" in shell).toBe(false);
    expect(Object.isFrozen(shell)).toBe(true);
    expect(Object.keys(shell.capabilities as object)).toEqual(["haptics@1", "share@1"]);
    expect(() => {
      target.capybaraShell = {};
    }).toThrow();
  });

  test("a change updates the insets and emits, and stays controls-free", () => {
    const target: Record<string, unknown> = {};
    const b = bridge();
    installShellEnvironment(mobile, b, target);
    const shell = target.capybaraShell as {
      insets: { bottom: number };
      controls?: unknown;
      on(e: "change", l: () => void): () => void;
    };
    const listener = vi.fn();
    shell.on("change", listener);
    b.fire({ insets: { top: 0, right: 0, bottom: 0, left: 0 }, capabilities: {} });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(shell.insets.bottom).toBe(0);
    expect("controls" in shell).toBe(false);
  });
});

describe("installShellEnvironment for desktop", () => {
  test("keeps controls", () => {
    const target: Record<string, unknown> = {};
    installShellEnvironment(
      {
        ...mobile,
        kind: "desktop",
        platform: "macos",
        controls: { x: 0, y: 0, width: 80, height: 28 },
      },
      bridge(),
      target,
    );
    const shell = target.capybaraShell as { kind: string; controls: unknown };
    expect(shell.kind).toBe("desktop");
    expect(shell.controls).toEqual({ x: 0, y: 0, width: 80, height: 28 });
  });
});

describe("capability data fields", () => {
  const withNav: ShellInit & { kind: "mobile" } = {
    ...mobile,
    capabilities: { "nav@1": ["set"] },
    events: { "nav@1": ["onSelect"] },
    fields: { "nav@1": { side: "right" }, "gone@1": { x: 1 } },
  };

  test("set on the offered capability's frozen object, beside its functions and events", () => {
    const target: Record<string, unknown> = {};
    installShellEnvironment(withNav, bridge(), target);
    const caps = (target.capybaraShell as { capabilities: Record<string, Record<string, unknown>> })
      .capabilities;
    expect(caps["nav@1"]?.side).toBe("right");
    expect(typeof caps["nav@1"]?.set).toBe("function");
    expect(typeof caps["nav@1"]?.onSelect).toBe("function");
    expect(Object.isFrozen(caps["nav@1"])).toBe(true);
    // A key that is not offered gets no object from its fields alone.
    expect(caps["gone@1"]).toBeUndefined();
  });

  test("a change replaces the values; a field never shadows a function or event", () => {
    const target: Record<string, unknown> = {};
    const b = bridge();
    installShellEnvironment(withNav, b, target);
    const shell = target.capybaraShell as {
      capabilities: Record<string, Record<string, unknown>>;
    };
    b.fire({
      ...withNav,
      fields: { "nav@1": { side: "left", set: "x", onSelect: 2 } },
    });
    expect(shell.capabilities["nav@1"]?.side).toBe("left");
    expect(typeof shell.capabilities["nav@1"]?.set).toBe("function");
    expect(typeof shell.capabilities["nav@1"]?.onSelect).toBe("function");
  });

  test("non-primitive values are dropped", () => {
    const target: Record<string, unknown> = {};
    const fields = { "nav@1": { side: { evil: true }, fn: () => 1 } } as unknown as NonNullable<
      ShellInit["fields"]
    >;
    installShellEnvironment({ ...withNav, fields }, bridge(), target);
    const caps = (target.capybaraShell as { capabilities: Record<string, Record<string, unknown>> })
      .capabilities;
    expect(caps["nav@1"]).not.toHaveProperty("side");
    expect(caps["nav@1"]).not.toHaveProperty("fn");
  });
});
