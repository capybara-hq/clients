// `haptics@1` (mobile app spec §5.2): a haptic impact through `@capacitor/haptics`. The plugin is
// called from the local runtime only; Capacitor's bridge never exists in a profile WebView.
import { ImpactStyle, NotificationType } from "@capacitor/haptics";
import type { CapabilityImpl } from "../registry.ts";
import { fail } from "./limits.ts";

/** The part of `@capacitor/haptics`' `Haptics` the capability uses. */
export interface HapticsPort {
  selectionChanged(): Promise<void>;
  impact(options: { style: ImpactStyle }): Promise<void>;
  notification(options: { type: NotificationType }): Promise<void>;
}

export const HAPTICS_KEY = "haptics@1";

export function createHapticsCapability(port: HapticsPort): CapabilityImpl {
  return {
    functions: {
      async impact(_ctx, kind) {
        switch (kind) {
          case "selection":
            return port.selectionChanged();
          case "light":
            return port.impact({ style: ImpactStyle.Light });
          case "success":
            return port.notification({ type: NotificationType.Success });
          case "warning":
            return port.notification({ type: NotificationType.Warning });
          default:
            return fail();
        }
      },
    },
  };
}
