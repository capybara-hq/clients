// One native dialog at a time per profile (layout spec §9.4): a confirming call needs a user
// activation and takes the profile's slot until it settles; a second one meanwhile is `busy`.

export type DialogDecision = "ok" | "busy" | "no_activation";

export interface DialogGate {
  /** "ok" takes the profile's slot: the caller must `release` it when the call settles. */
  enter(profileId: string, activation: boolean): DialogDecision;
  release(profileId: string): void;
}

export function createDialogGate(): DialogGate {
  const busy = new Set<string>();
  return {
    enter(profileId, activation) {
      if (!activation) return "no_activation";
      if (busy.has(profileId)) return "busy";
      busy.add(profileId);
      return "ok";
    },
    release(profileId) {
      busy.delete(profileId);
    },
  };
}
