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
  test("chrome, haptics, share, menu and openExternal, never device@1 or notify@1", () => {
    const profile = { id: "p1", origin: "https://a.example" };
    const registry = createRegistry({ host, profiles: { list: () => [profile] } });
    registerMobileCapabilities(registry, {
      chrome: { functions: { setAppearance: async () => {}, ready: async () => {} } },
      haptics: {
        selectionChanged: vi.fn(async () => {}),
        impact: vi.fn(async () => {}),
        notification: vi.fn(async () => {}),
      },
      share: { share: vi.fn(async () => {}) },
      menu: { show: vi.fn(async () => null), cancel: vi.fn(() => {}) },
      openExternal: { open: vi.fn(async () => {}) },
    });
    expect(registry.descriptors(profile).capabilities).toEqual({
      "chrome@1": ["setAppearance", "ready"],
      "haptics@1": ["impact"],
      "share@1": ["share"],
      "menu@1": ["show"],
      "openExternal@1": ["open"],
    });
  });
});
