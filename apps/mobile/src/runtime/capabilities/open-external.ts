// `openExternal@1` (mobile app spec §5.2): open a URL in the system browser (UIApplication.open /
// ACTION_VIEW through the `CapybaraHost` plugin's `openExternal`). Not confirming: it leaves the
// app only for an https URL (or the profile's own origin), the same rule as `share@1`. Its data
// field `returnScheme` is the app's own scheme (the one in `<scheme>://auth/callback`), so the web
// can ask for a handoff that comes back to the app (shell external authorization spec §5).
import { SHELL_CAPABILITY_KEYS } from "@capybara-hq/plugin-sdk";
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

export const OPEN_EXTERNAL_KEY = SHELL_CAPABILITY_KEYS.openExternal;

export function createOpenExternalCapability(
  port: OpenExternalPort,
  opts: { returnScheme?: string } = {},
): CapabilityImpl {
  const { returnScheme } = opts;
  return {
    ...(returnScheme !== undefined ? { fields: () => ({ returnScheme }) } : {}),
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
