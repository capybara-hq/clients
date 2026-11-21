// The capabilities the mobile runtime offers every profile (mobile spec §5.2, global constraints):
// chrome@1, haptics@1, share@1, menu@1 and openExternal@1. Never device@1 or notify@1. signIn@1
// (Task 17), nav@1 and push@1 register beside these when they land.

import type { ProfileRef } from "../protocol.ts";
import type { CapabilityImpl, CapabilityRegistry } from "../registry.ts";
import { CHROME_CAPABILITY_KEY } from "./chrome.ts";
import { createHapticsCapability, HAPTICS_KEY, type HapticsPort } from "./haptics.ts";
import { createMenuCapability, MENU_KEY, type MenuHostPort } from "./menu.ts";
import {
  createOpenExternalCapability,
  OPEN_EXTERNAL_KEY,
  type OpenExternalPort,
} from "./open-external.ts";
import { createShareCapability, SHARE_KEY, type SharePort } from "./share.ts";

export interface MobileCapabilityPorts<P extends ProfileRef> {
  /** `createChrome(...)`: it needs the loader and the appearance store, so the runtime builds it. */
  chrome: CapabilityImpl<P>;
  haptics: HapticsPort;
  share: SharePort;
  menu: MenuHostPort;
  openExternal: OpenExternalPort;
}

export function registerMobileCapabilities<P extends ProfileRef>(
  registry: CapabilityRegistry<P>,
  ports: MobileCapabilityPorts<P>,
): void {
  registry.register(CHROME_CAPABILITY_KEY, ports.chrome);
  registry.register(HAPTICS_KEY, createHapticsCapability(ports.haptics));
  registry.register(SHARE_KEY, createShareCapability(ports.share));
  registry.register(MENU_KEY, createMenuCapability(ports.menu));
  registry.register(OPEN_EXTERNAL_KEY, createOpenExternalCapability(ports.openExternal));
}
