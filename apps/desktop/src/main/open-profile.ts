// Every way into a profile (spec §6.3): the 「平台」 menu, the tray, a notification click, a deep
// link, start-up. Signed in: its main window (at `url`); signed out: the small window's signed-out
// page; never signed in (a managed profile): its found page. Callers may hold an old copy of the
// profile (a notification shown before a sign-out): the stored one decides. A main window is
// never opened for a profile that is not signed in (it would only meet the deployment's /login).
import type { Profile } from "./profiles.ts";

export interface OpenProfileDeps {
  /** The profile as stored now; undefined once removed. */
  getProfile(id: string): Profile | undefined;
  setLastUsed(id: string): void;
  /** windows.showProfile */
  showMain(profile: Profile, url?: string): void;
  /** onboarding.showSignedOut */
  showSignedOut(profile: Profile): void;
  /** onboarding.showFound */
  showFound(profile: Profile): void;
}

export function createOpenProfile(deps: OpenProfileDeps) {
  return (profile: Pick<Profile, "id">, url?: string): void => {
    const stored = deps.getProfile(profile.id);
    if (!stored) return;
    deps.setLastUsed(stored.id);
    if (stored.signedIn) deps.showMain(stored, url);
    else if (stored.account) deps.showSignedOut(stored);
    else deps.showFound(stored);
  };
}
