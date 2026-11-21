// The native side of push in the runtime (core spec §9.4, §9.5): a push that arrives in the
// foreground shows as a banner unless its page is on screen; a tapped push opens its profile (exact
// origin) on its path; a removed profile's registration is deleted on its deployment before the
// shell forgets it. Small and injectable: a later shared deep-link router can absorb `tap`.
import { parsePushPayload, profileForPush, shouldPresentForeground } from "@capybara-hq/shell";
import type { PushNative } from "./native.ts";
import type { RegistrationStore } from "./store.ts";

/** The registrations route under a deployment's base. */
export const REGISTRATIONS_PATH = "/api/v1/me/push-registrations";

/** How long profile removal waits for the DELETE before it forgets the registration anyway. */
export const REMOVAL_DELETE_DEADLINE_MS = 5_000;

function timer(ms: number): { done: Promise<void>; cancel(): void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { done, cancel: () => clearTimeout(handle) };
}

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
      // Ruling R21: a push for no visible profile leads nowhere, so it shows no banner.
      if (profileForPush(push.origin, deps.profiles()) === null) return;
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
 * offline, signed out) or does not answer within `REMOVAL_DELETE_DEADLINE_MS` never keeps the
 * registration here, nor holds up the removal; the deployment drops it after 60 days.
 * Known limitation: a profile removed without a live WebView (not opened in this process) has no
 * page to send the DELETE from, so its row on the deployment stays until the 60-day rule
 * removes it.
 * Register this before the listener that closes the profile's WebView.
 */
export function forgetOnRemoval(deps: {
  store: RegistrationStore;
  deleteFromPage(profileId: string, url: string): Promise<void>;
  /** The removal's deadline (tests inject one); `REMOVAL_DELETE_DEADLINE_MS` by default. */
  deadline?: () => { done: Promise<void>; cancel(): void };
  onRemoved(listener: (p: { id: string; base: string }) => void | Promise<void>): () => void;
}): () => void {
  return deps.onRemoved(async (p) => {
    const registration = deps.store.get(p.id);
    if (!registration) return;
    const url = `${p.base}${REGISTRATIONS_PATH}/${encodeURIComponent(registration.id)}`;
    const deadline = (deps.deadline ?? (() => timer(REMOVAL_DELETE_DEADLINE_MS)))();
    try {
      await Promise.race([deps.deleteFromPage(p.id, url), deadline.done]);
    } catch {
      // Cleared below all the same.
    } finally {
      deadline.cancel();
    }
    await deps.store.clear(p.id);
  });
}
