// `push@1` (core spec §9.3, decisions 2, 4, 6): the web asks the shell for the OS permission and
// this install's token, posts it to its deployment itself, and tells the shell the registration id
// it got back. Offered to a profile only when its deployment's meta lists the build's app id with
// a channel the build carries (`offersPush`), so the official build (no brand `push`) never has it.
//
// `register` is not confirming: the OS prompt is the consent, and a user activation is needed only
// when that prompt would show (`prompt`); with `granted` it hands back the current token, so the web
// re-posts it on each start. `unregister` forgets only this profile's registration: one OS token
// serves every profile of the install, so the OS registration is left alone.
import {
  PUSH_LIMITS,
  type PushPlatform,
  type PushRegistration,
  type PushStatus,
  SHELL_CAPABILITY_KEYS,
} from "@capybara-hq/plugin-sdk";
import { offersPush, type PushApp, pickAndroidProvider } from "@capybara-hq/shell";
import type { ProfileRef } from "../runtime/protocol.ts";
import type { CapabilityImpl } from "../runtime/registry.ts";
import { type BrandPush, PUSH_PROVIDERS } from "./brand.ts";
import type { PushNative } from "./native.ts";
import type { RegistrationStore } from "./store.ts";

export const PUSH_KEY = SHELL_CAPABILITY_KEYS.push;

/** A deployment's registration id: it goes into a URL path on removal, so it is kept strict. */
const REGISTRATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const refuse = (code: "failed" | "cancelled" | "no_activation" = "failed"): never => {
  throw Object.freeze({ code });
};

/** SHA-256 of `text`, hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A profile as the offers read it: its id and the deployment it points at. */
export type OfferProfile = ProfileRef & { base: string };

/**
 * What each profile's deployment offers for push, from its meta (`features.push`). The runtime
 * sets it when a profile's meta is read and refreshes the registry, so `push@1` comes and goes.
 * An entry holds only for the deployment it was read from: a profile re-pointed to another base
 * or origin is offered nothing until its new meta is read; a removed profile's entry is forgotten.
 */
export interface PushOffers {
  /** null (a too-old or unreadable meta) drops the entry. */
  set(profile: OfferProfile, meta: { features?: { push?: readonly PushApp[] } } | null): void;
  forget(profileId: string): void;
  /** The deployment's channels for the build's app id; empty when unknown. */
  providers(profile: OfferProfile): string[];
  /** The registry's `available` for `push@1`. */
  available(profile: OfferProfile): boolean;
}

export function createPushOffers(build: {
  appId: string;
  providers: readonly string[];
}): PushOffers {
  const apps = new Map<string, { origin: string; base: string; push: readonly PushApp[] }>();
  const appsOf = (profile: OfferProfile) => {
    const entry = apps.get(profile.id);
    return entry && entry.origin === profile.origin && entry.base === profile.base
      ? entry.push
      : undefined;
  };
  return {
    set(profile, meta) {
      const push = meta?.features?.push;
      if (push) apps.set(profile.id, { origin: profile.origin, base: profile.base, push });
      else apps.delete(profile.id);
    },
    forget(profileId) {
      apps.delete(profileId);
    },
    providers(profile) {
      const listed = appsOf(profile) ?? [];
      return [
        ...new Set(listed.filter((a) => a.appId === build.appId).flatMap((a) => a.providers)),
      ];
    },
    available(profile) {
      const push = appsOf(profile);
      return push !== undefined && offersPush({ features: { push } }, build);
    },
  };
}

export interface PushCapabilityDeps<P extends OfferProfile> {
  native: PushNative;
  store: RegistrationStore;
  build: BrandPush;
  platform: PushPlatform;
  /** The channels the profile's deployment covers for the build's app id (`PushOffers.providers`). */
  offered(profile: P): readonly string[];
  hash?: (text: string) => Promise<string>;
}

export function createPushCapability<P extends OfferProfile>(
  deps: PushCapabilityDeps<P>,
): CapabilityImpl<P> {
  const hash = deps.hash ?? sha256Hex;
  // Profile id -> the token `register` last handed that profile's page, until `registered`.
  const pending = new Map<string, { provider: string; tokenHash: string }>();

  /** The channel to register with: carried by the build and covered by the deployment. */
  async function provider(profile: P): Promise<string | null> {
    const offered = deps.offered(profile);
    const usable = (p: string) => deps.build.providers.includes(p) && offered.includes(p);
    if (deps.platform === "ios") return usable(PUSH_PROVIDERS.apns) ? PUSH_PROVIDERS.apns : null;
    const googlePlayServices = await deps.native.googlePlayServices().catch(() => false);
    return pickAndroidProvider(
      { googlePlayServices },
      {
        ...(usable(PUSH_PROVIDERS.fcm) ? { fcm: PUSH_PROVIDERS.fcm } : {}),
        ...(usable(PUSH_PROVIDERS.aggregator) ? { aggregator: PUSH_PROVIDERS.aggregator } : {}),
      },
    );
  }

  async function tokenFor(channel: string): Promise<string | null> {
    try {
      const token = await deps.native.token(channel);
      return typeof token === "string" && token.length > 0 && token.length <= PUSH_LIMITS.tokenChars
        ? token
        : null;
    } catch {
      return null;
    }
  }

  return {
    functions: {
      async status(ctx): Promise<PushStatus> {
        const permission = await deps.native.permission();
        const stored = deps.store.get(ctx.profile.id);
        let tokenChanged = false;
        if (stored && permission === "granted") {
          const token = await tokenFor(stored.provider);
          tokenChanged = token !== null && (await hash(token)) !== stored.tokenHash;
        }
        return { permission, registrationId: stored?.id ?? null, tokenChanged };
      },

      async register(ctx): Promise<PushRegistration> {
        let permission = await deps.native.permission();
        if (permission === "denied") refuse("cancelled");
        if (permission === "prompt") {
          if (!ctx.activation) refuse("no_activation");
          permission = await deps.native.requestPermission();
        }
        if (permission !== "granted") refuse("cancelled");
        const channel = await provider(ctx.profile);
        if (channel === null) return refuse();
        const token = await tokenFor(channel);
        if (token === null) return refuse();
        pending.set(ctx.profile.id, { provider: channel, tokenHash: await hash(token) });
        return { platform: deps.platform, appId: deps.build.appId, provider: channel, token };
      },

      /**
       * Must follow `register` in the same runtime document: the token it handed out is kept
       * only in memory (`pending`), so a `registered` after an app restart, or without a
       * `register` first, fails and the web registers again.
       */
      async registered(ctx, id) {
        if (typeof id !== "string" || !REGISTRATION_ID.test(id)) return refuse();
        const registration = pending.get(ctx.profile.id);
        if (!registration) return refuse();
        await deps.store.set(ctx.profile.id, { id, ...registration });
        pending.delete(ctx.profile.id);
      },

      async unregister(ctx) {
        pending.delete(ctx.profile.id);
        await deps.store.clear(ctx.profile.id);
      },
    },
  };
}
