// `openExternal@1` (mobile app spec §5.2): open a URL in the system browser (UIApplication.open /
// ACTION_VIEW through the `CapybaraHost` plugin's `openExternal`). Not confirming: it leaves the
// app only for an https URL (or the profile's own origin), the same rule as `share@1`.
import type { CapabilityImpl } from "../registry.ts";
import { fail, resolveWebUrl } from "./limits.ts";

export interface OpenExternalPort {
  open(url: string): Promise<void>;
}

/** An `OpenExternalPort` over the `CapybaraHost` plugin. */
export function openExternalPortFrom(plugin: {
  openExternal(options: { url: string }): Promise<void>;
}): OpenExternalPort {
  return { open: (url) => plugin.openExternal({ url }) };
}

export const OPEN_EXTERNAL_KEY = "openExternal@1";

export function createOpenExternalCapability(port: OpenExternalPort): CapabilityImpl {
  return {
    functions: {
      async open(ctx, url) {
        const resolved = resolveWebUrl(ctx.profile, url);
        if (resolved === null) return fail();
        try {
          await port.open(resolved);
        } catch {
          return fail();
        }
        return undefined;
      },
    },
  };
}
