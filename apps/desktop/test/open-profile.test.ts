import { describe, expect, test, vi } from "vitest";
import { createOpenProfile } from "../src/main/open-profile.ts";
import type { Profile } from "../src/main/profiles.ts";

const base: Profile = {
  id: "p1",
  base: "https://a.example.com",
  origin: "https://a.example.com",
  name: "A",
  signedIn: true,
  account: { name: "Ann", login: "ann" },
};

function setup(stored: Profile | undefined) {
  const deps = {
    getProfile: vi.fn((id: string) => (stored?.id === id ? stored : undefined)),
    setLastUsed: vi.fn(),
    showMain: vi.fn(),
    showSignedOut: vi.fn(),
    showFound: vi.fn(),
  };
  return { deps, open: createOpenProfile(deps) };
}

describe("opening a profile (menu, tray, notification click)", () => {
  test("signed in: its main window at the URL", () => {
    const { deps, open } = setup(base);
    open(base, "https://a.example.com/devices");
    expect(deps.showMain).toHaveBeenCalledWith(base, "https://a.example.com/devices");
    expect(deps.setLastUsed).toHaveBeenCalledWith("p1");
  });

  test("a stale signed-in copy of a signed-out profile: the signed-out page, no main window", () => {
    const { deps, open } = setup({ ...base, signedIn: false });
    // A notification click or the tray holding the copy from before the sign-out.
    open(base, "https://a.example.com/c/1");
    expect(deps.showMain).not.toHaveBeenCalled();
    expect(deps.showSignedOut).toHaveBeenCalledWith(expect.objectContaining({ signedIn: false }));
  });

  test("never signed in: the found page", () => {
    const { account: _a, ...managed } = base;
    const { deps, open } = setup({ ...managed, signedIn: false });
    open(base);
    expect(deps.showFound).toHaveBeenCalled();
    expect(deps.showMain).not.toHaveBeenCalled();
  });

  test("removed meanwhile: nothing", () => {
    const { deps, open } = setup(undefined);
    open(base);
    expect(deps.setLastUsed).not.toHaveBeenCalled();
    expect(deps.showMain).not.toHaveBeenCalled();
  });
});
