// The capabilities the mobile runtime offers every profile (mobile spec §5.2, global constraints):
// signIn@1 (unless the deployment is too old for app sign-in), chrome@1, haptics@1, share@1,
// menu@1 and openExternal@1, and on iOS nav@1 while the window has a strip (nav.ts). Never
// device@1 or notify@1. push@1 is registered by the runtime itself, only for a build that carries
// push (src/push/capability.ts).

import type { ProfileRef } from "../protocol.ts";
import type { CapabilityImpl, CapabilityRegistry } from "../registry.ts";
import { SIGN_IN_KEY } from "../sign-in.ts";
import { CHROME_CAPABILITY_KEY } from "./chrome.ts";
import { createHapticsCapability, HAPTICS_KEY, type HapticsPort } from "./haptics.ts";
import { createMenuCapability, MENU_KEY, type MenuHostPort } from "./menu.ts";
import { type Nav, registerNav } from "./nav.ts";
import {
  createOpenExternalCapability,
  OPEN_EXTERNAL_KEY,
  type OpenExternalPort,
} from "./open-external.ts";
import { createShareCapability, SHARE_KEY, type SharePort } from "./share.ts";

export interface MobileCapabilityPorts<P extends ProfileRef> {
  /** `createSignIn(...).capability`, offered while `available` (`SignInSupport.available`). */
  signIn: { capability: CapabilityImpl<P>; available(profile: P): boolean };
  /** `createChrome(...)`: it needs the loader and the appearance store, so the runtime builds it. */
  chrome: CapabilityImpl<P>;
  haptics: HapticsPort;
  share: SharePort;
  menu: MenuHostPort;
  openExternal: OpenExternalPort;
  /** The platform the runtime runs on: nav@1 exists only on iOS. */
  platform?: "ios" | "android";
  /** `createNav(...)`: offered on iOS while the window has a strip. */
  nav?: Nav<P>;
}

export function registerMobileCapabilities<P extends ProfileRef>(
  registry: CapabilityRegistry<P>,
  ports: MobileCapabilityPorts<P>,
): void {
  registry.register(SIGN_IN_KEY, ports.signIn.capability, {
    available: (profile) => ports.signIn.available(profile),
  });
  registry.register(CHROME_CAPABILITY_KEY, ports.chrome);
  registry.register(HAPTICS_KEY, createHapticsCapability(ports.haptics));
  registry.register(SHARE_KEY, createShareCapability(ports.share));
  registry.register(MENU_KEY, createMenuCapability(ports.menu));
  registry.register(OPEN_EXTERNAL_KEY, createOpenExternalCapability(ports.openExternal));
  if (ports.nav && ports.platform) registerNav(registry, ports.platform, ports.nav);
}
