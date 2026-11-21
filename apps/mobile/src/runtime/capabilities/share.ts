// `share@1` (mobile app spec §5.2): the system share sheet through `@capacitor/share`. Confirming:
// the sheet is a native dialog, one at a time per profile, and needs a user activation.
import { SHELL_CAPABILITY_KEYS, type ShareInputV1 } from "@capybara-hq/plugin-sdk";
import type { CapabilityImpl } from "../registry.ts";
import { fail, isRecord, MOBILE_SHELL_LIMITS, onlyKeys, resolveWebUrl } from "./limits.ts";

export type ShareOptions = ShareInputV1;

/** The part of `@capacitor/share`'s `Share` the capability uses. */
export interface SharePort {
  share(options: ShareOptions): Promise<unknown>;
}

export const SHARE_KEY = SHELL_CAPABILITY_KEYS.share;

function text(v: unknown, max: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) return fail();
  return v;
}

export function createShareCapability(port: SharePort): CapabilityImpl {
  return {
    confirming: ["share"],
    functions: {
      async share(ctx, input) {
        if (!isRecord(input) || !onlyKeys(input, ["title", "text", "url"])) return fail();
        const options: ShareOptions = {};
        if (input.title !== undefined)
          options.title = text(input.title, MOBILE_SHELL_LIMITS.shareTitle);
        if (input.text !== undefined)
          options.text = text(input.text, MOBILE_SHELL_LIMITS.shareText);
        if (input.url !== undefined) {
          const url = resolveWebUrl(ctx.profile, input.url);
          if (url === null) return fail();
          options.url = url;
        }
        if (Object.keys(options).length === 0) return fail();
        try {
          await port.share(options);
        } catch (err) {
          // Dismissing the sheet is an answer, not an error ("resolves whether shared or dismissed").
          if (err instanceof Error && /cancel/i.test(err.message)) return undefined;
          return fail();
        }
        return undefined;
      },
    },
  };
}
