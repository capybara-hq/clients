// When `device@1` is offered to a profile (spec §8, §9; plan Task 18): on macOS or Linux, unless
// the managed configuration turns 「连接本机」 off, and only to a deployment whose discovery says it
// takes local devices on a protocol range that holds the bundled program's protocol. Decided in
// main from the deployment's own `GET /api/v1/meta`, again at every load of a profile window; a
// change is announced so the page sees the capability appear or go.
import type { Meta, MetaError } from "@capybara-hq/shell";
import type { ManagedConfig } from "../managed.ts";
import type { Profile } from "../profiles.ts";

/**
 * The device protocol of the bundled `@capybara-hq/device` (its bundled plugin-sdk's
 * `DEVICE_PROTOCOL_VERSION`). The package does not export it at runtime without loading the whole
 * program, so it is restated here and pinned to the package by a test.
 */
export const BUNDLED_DEVICE_PROTOCOL = 3;

export function deviceOffered(o: {
  platform: string;
  managed: Pick<ManagedConfig, "connectThisMachine">;
  meta: Meta | MetaError;
}): boolean {
  if (o.platform !== "darwin" && o.platform !== "linux") return false;
  if (o.managed.connectThisMachine === false) return false;
  if ("error" in o.meta) return false;
  const { features, protocols } = o.meta;
  return (
    features.localDevices === true &&
    protocols.device.min <= BUNDLED_DEVICE_PROTOCOL &&
    BUNDLED_DEVICE_PROTOCOL <= protocols.device.max
  );
}

export interface DeviceAvailabilityDeps {
  platform: string;
  managed: Pick<ManagedConfig, "connectThisMachine">;
  /** `fetchMeta(base, net.fetch)`. */
  fetchMeta(base: string): Promise<Meta | MetaError>;
  /** The answer for a profile changed: tell its windows (`broadcastChange`). */
  onChange(profileId: string): void;
  log?: (message: string, err?: unknown) => void;
}

export function createDeviceAvailability(deps: DeviceAvailabilityDeps) {
  const offered = new Map<string, boolean>();
  const inFlight = new Map<string, Promise<void>>();
  const possible =
    (deps.platform === "darwin" || deps.platform === "linux") &&
    deps.managed.connectThisMachine !== false;

  async function decide(profile: Profile): Promise<void> {
    let meta: Meta | MetaError;
    try {
      meta = await deps.fetchMeta(profile.base);
    } catch (err) {
      deps.log?.("device discovery failed", err);
      meta = { error: "unreachable" };
    }
    const next = deviceOffered({ platform: deps.platform, managed: deps.managed, meta });
    const before = offered.get(profile.id) ?? false;
    offered.set(profile.id, next);
    if (next !== before) deps.onChange(profile.id);
  }

  return {
    /** Whether the profile is offered `device@1` now (false until discovery answered). */
    isAvailable(profile: Profile): boolean {
      return possible && offered.get(profile.id) === true;
    },

    /** Asks the deployment again; one request per profile at a time. */
    evaluate(profile: Profile): Promise<void> {
      if (!possible) return Promise.resolve();
      const running = inFlight.get(profile.id);
      if (running) return running;
      const p = decide(profile).finally(() => inFlight.delete(profile.id));
      inFlight.set(profile.id, p);
      return p;
    },

    forget(profileId: string): void {
      offered.delete(profileId);
    },
  };
}

export type DeviceAvailability = ReturnType<typeof createDeviceAvailability>;
