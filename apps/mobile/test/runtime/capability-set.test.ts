import { describe, expect, test, vi } from "vitest";
import { registerMobileCapabilities } from "../../src/runtime/capabilities/index.ts";
import type { HostPort } from "../../src/runtime/host-port.ts";
import { createRegistry } from "../../src/runtime/registry.ts";

const host: HostPort = {
  onCall: () => () => {},
  reply: async () => {},
  pushState: async () => {},
  event: async () => {},
};

describe("the capabilities the runtime offers a profile", () => {
  test("signIn, chrome, haptics, share, menu and openExternal, never device@1 or notify@1", () => {
    const profile = { id: "p1", origin: "https://a.example" };
    const old = { id: "p2", origin: "https://b.example" };
    const registry = createRegistry({ host, profiles: { list: () => [profile, old] } });
    registerMobileCapabilities(registry, {
      signIn: {
        capability: { functions: { start: async () => "signedIn" }, confirming: ["start"] },
        available: (p) => p.id !== old.id,
      },
      chrome: { functions: { setAppearance: async () => {}, ready: async () => {} } },
      haptics: {
        selectionChanged: vi.fn(async () => {}),
        impact: vi.fn(async () => {}),
        notification: vi.fn(async () => {}),
      },
      share: { share: vi.fn(async () => {}) },
      menu: { show: vi.fn(async () => null), cancel: vi.fn(() => {}) },
      openExternal: { open: vi.fn(async () => {}) },
      returnScheme: "capybara",
    });
    expect(registry.descriptors(profile).capabilities).toEqual({
      "signIn@1": ["start"],
      "chrome@1": ["setAppearance", "ready"],
      "haptics@1": ["impact"],
      "share@1": ["share"],
      "menu@1": ["show"],
      "openExternal@1": ["open"],
    });
    expect(registry.descriptors(profile).fields).toEqual({
      "openExternal@1": { returnScheme: "capybara" },
    });
    // A deployment too old for app sign-in is not offered signIn@1.
    expect(Object.keys(registry.descriptors(old).capabilities)).not.toContain("signIn@1");
  });
});
