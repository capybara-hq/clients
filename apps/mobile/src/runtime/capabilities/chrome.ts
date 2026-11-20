// `chrome@1` (layout spec §9.2, mobile spec §5.2, §6.3): the native background and status bar
// follow the page's theme, and `ready()` drops the launch splash. Neither is confirming: no
// dialog, no activation. A valid appearance is set natively and kept per profile; an unchanged
// one is not written again (the design reports on every theme change and on load).
import {
  type AppearanceStore,
  type ChromeAppearance,
  type NativeLook,
  nativeLook,
  validAppearanceInput,
} from "../appearance.ts";
import type { ProfileRef } from "../protocol.ts";
import type { CapabilityImpl } from "../registry.ts";

export const CHROME_CAPABILITY_KEY = "chrome@1";

export interface ChromeDeps {
  appearance: AppearanceStore;
  native: { setAppearance(profileId: string, look: NativeLook): Promise<void> };
  /** The web of this profile painted: the loader drops the splash when it is the one shown. */
  ready(profileId: string): void;
}

const failed = () => Object.assign(new Error("failed"), { code: "failed" as const });

export function createChrome<P extends ProfileRef>(deps: ChromeDeps): CapabilityImpl<P> {
  const last = new Map<string, string>();
  return {
    functions: {
      async setAppearance(ctx, input) {
        const appearance: ChromeAppearance | null = validAppearanceInput(input);
        if (!appearance) throw failed();
        const id = ctx.profile.id;
        await deps.native.setAppearance(id, nativeLook(appearance));
        const text = JSON.stringify(appearance);
        if (last.get(id) === text) return;
        last.set(id, text);
        await deps.appearance.save(id, appearance);
      },
      async ready(ctx) {
        deps.ready(ctx.profile.id);
      },
    },
  };
}
