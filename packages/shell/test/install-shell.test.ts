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
