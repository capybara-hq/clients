// The lock gates between the profile store, the managed policy and the loader (mobile spec §4.3,
// Decision 8: "while locked, other profiles are hidden and never loaded"). The composition root
// (src/local/runtime.ts) only wires these; everything that decides what may be listed, switched
// to, added, kept on screen or kept alive natively lives here, under test.
import type { FoundDeployment } from "./address-model.ts";
import type { Loader, LoaderProfile } from "./loader.ts";
import type { ManagedPolicy } from "./managed.ts";
import type { Profile, ProfileStore } from "./profiles.ts";

export interface ProfileAccessDeps {
  store: ProfileStore;
  policy: Pick<ManagedPolicy, "visible" | "canAdd" | "policy" | "settled">;
  loader: Pick<Loader, "open" | "shown" | "close">;
  /** Shows the address page (nothing visible is left to show). */
  showAddress(): void;
}

export interface ProfileAccess {
  /** The profiles the switcher, the error page, the loader and the registry may use. */
  list(): Profile[];
  /** The profile to open after a switch, or null (hidden, unknown, or the person cancelled). */
  switchTo(id: string): Promise<LoaderProfile | null>;
  /** Adds a found deployment; refused under a lock for anything but the preset. */
  add(found: FoundDeployment): Promise<Profile>;
  /**
   * After a policy change (enforced or not): every hidden profile's WebView is torn down; a shown
   * profile that is no longer visible leaves the screen for the current visible profile, else
   * the address page. Under a lock with nothing shown, the preset's profile opens.
   */
  reconcile(): Promise<void>;
  /**
   * The first profile to show once the start route answered and every change received during
   * start is applied: the route's profile while visible, else the current visible one; null
   * means the address page. Already on screen (a change opened it): returned, not reopened.
   */
  start(
    route: "address" | { profileId: string },
  ): Promise<{ profile: Profile; open: boolean } | null>;
}

export function createProfileAccess(deps: ProfileAccessDeps): ProfileAccess {
  const { store, policy, loader } = deps;
  const visible = () => policy.visible();
  const isVisible = (id: string) => visible().some((p) => p.id === id);
  const currentVisible = () => {
    const shown = visible();
    const current = store.current();
    return (current && shown.find((p) => p.id === current.id)) ?? shown[0] ?? null;
  };

  // A removed profile's WebView goes before its store's deletion is scheduled (the listeners run
  // first), so the store is no longer in use when it is deleted.
  store.onRemoved((p) => loader.close(p.id));

  return {
    list: visible,

    async switchTo(id) {
      if (!isVisible(id)) return null;
      return (await store.setCurrent(id)) === "switched" ? store.current() : null;
    },

    async add(found) {
      // The lock may have arrived after discovery answered.
      if (!policy.canAdd(found.base)) throw new Error("locked to the preset");
      return store.add(found);
    },

    async reconcile() {
      const shownBefore = loader.shown();
      const allowed = new Set(visible().map((p) => p.id));
      for (const p of store.list()) {
        if (!allowed.has(p.id)) await loader.close(p.id);
      }
      const hiddenShown = shownBefore !== null && !allowed.has(shownBefore);
      const lockedIdle = shownBefore === null && policy.policy().locked;
      if (!hiddenShown && !lockedIdle) return;
      const next = currentVisible();
      if (next) await loader.open(next);
      else if (hiddenShown) deps.showAddress();
    },

    async start(route) {
      await policy.settled();
      const shown = loader.shown();
      const onScreen = shown !== null ? visible().find((p) => p.id === shown) : undefined;
      if (onScreen) return { profile: onScreen, open: false };
      const fromRoute =
        route === "address" ? undefined : visible().find((p) => p.id === route.profileId);
      const profile = fromRoute ?? (route === "address" ? null : currentVisible());
      return profile ? { profile, open: true } : null;
    },
  };
}
