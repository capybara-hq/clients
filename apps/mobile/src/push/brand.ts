// What a build carries for push (core spec §9.1, Task K4): the brand's `push` field, the app id
// and the channels this platform's binary carries. The official brand has no `push` field, so it
// yields no build and `push@1` is never offered.

import type { BrandPushConfig } from "../../brand.ts";

/** The brand's `push` field (`apps/mobile/brand.ts`). */
export type BrandPushField = BrandPushConfig;

/** The push side of a build: what `push@1` registers with and `offersPush` matches. */
export interface BrandPush extends BrandPushField {
  appId: string;
  /** The provider keys this platform's binary carries, as the deployment's meta names them. */
  providers: readonly string[];
}

/** The provider key of each channel: the name of the plugin that delivers through it. */
export const PUSH_PROVIDERS = {
  apns: "push-apns",
  fcm: "push-fcm",
  aggregator: "push-jpush",
} as const;

/**
 * The channels a brand carries: on one platform (APNs on iOS, FCM and the aggregator on Android),
 * or without a platform every channel of the brand (what the deployment needs set up).
 */
export function carriedProviders(
  push: BrandPushField | undefined,
  platform?: "ios" | "android",
): string[] {
  if (!push) return [];
  const ios = platform !== "android";
  const android = platform !== "ios";
  return [
    ...(ios && push.apns ? [PUSH_PROVIDERS.apns] : []),
    ...(android && push.fcm ? [PUSH_PROVIDERS.fcm] : []),
    ...(android && push.aggregator ? [PUSH_PROVIDERS.aggregator] : []),
  ];
}

/** The build's push side, or null when it carries no channel on this platform. */
export function brandPush(
  brand: { appId: string; push?: BrandPushField },
  platform: "ios" | "android",
): BrandPush | null {
  const providers = carriedProviders(brand.push, platform);
  if (providers.length === 0) return null;
  return { ...brand.push, appId: brand.appId, providers };
}
