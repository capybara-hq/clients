// The native side of push in the runtime (core spec §9.4, §9.5): a push that arrives in the
// foreground shows as a banner unless its page is on screen; a tapped push opens its profile (exact
// origin) on its path; a removed profile's registration is deleted on its deployment before the
// shell forgets it. Small and injectable: a later shared deep-link router can absorb `tap`.
import { parsePushPayload, profileForPush, shouldPresentForeground } from "@capybara-hq/shell";
import type { PushNative } from "./native.ts";
import type { RegistrationStore } from "./store.ts";

/** The registrations route under a deployment's base. */
export const REGISTRATIONS_PATH = "/api/v1/me/push-registrations";

export interface PushRouterDeps {
  native: Pick<PushNative, "present">;
  /** The profiles a push may open (the lock gates' visible list). */
  profiles(): readonly { id: string; origin: string }[];
  /** The profile on screen: its origin and its WebView's current URL; null when none. */
  screen(): Promise<{ origin: string; url: string } | null>;
  /** Makes the profile current and loads `origin + path` in it. */
  open(profileId: string, path: string): Promise<void>;
}

export interface PushRouter {
  foreground(data: Record<string, unknown>): Promise<void>;
  tap(data: Record<string, unknown>): Promise<void>;
}

export function createPushRouter(deps: PushRouterDeps): PushRouter {
  return {
    async foreground(data) {
      const push = parsePushPayload(data);
      const { title, body } = data;
      if (!push || typeof title !== "string" || typeof body !== "string") return;
      const screen = await deps.screen().catch(() => null);
      if (!shouldPresentForeground(push, screen)) return;
      await deps.native.present({ title, body, data }).catch(() => {});
    },
    async tap(data) {
      const push = parsePushPayload(data);
      if (!push) return;
      // An unknown origin opens nothing: the OS already brought the app forward.
      const profileId = profileForPush(push.origin, deps.profiles());
      if (profileId === null) return;
      await deps.open(profileId, push.path);
    },
  };
}

/** Forwards native's foreground pushes and taps to the router; returns how to stop. */
export function connectPush(
  native: Pick<PushNative, "onForeground" | "onTap">,
  router: PushRouter,
): () => void {
  const stops = [
    native.onForeground((data) => void router.foreground(data).catch(() => {})),
    native.onTap((data) => void router.tap(data).catch(() => {})),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

/**
 * Profile removal (decision 6): `DELETE <base>/api/v1/me/push-registrations/<id>` from the
 * profile's page (its session cookie), then the shell forgets the id. A DELETE that fails (no page,
 * offline, signed out) never keeps the registration here; the deployment drops it after 60 days.
 * Register this before the listener that closes the profile's WebView.
 */
export function forgetOnRemoval(deps: {
  store: RegistrationStore;
  deleteFromPage(profileId: string, url: string): Promise<void>;
  onRemoved(listener: (p: { id: string; base: string }) => void | Promise<void>): () => void;
}): () => void {
  return deps.onRemoved(async (p) => {
    const registration = deps.store.get(p.id);
    if (!registration) return;
    const url = `${p.base}${REGISTRATIONS_PATH}/${encodeURIComponent(registration.id)}`;
    try {
      await deps.deleteFromPage(p.id, url);
    } catch {
      // Cleared below all the same.
    }
    await deps.store.clear(p.id);
  });
}
