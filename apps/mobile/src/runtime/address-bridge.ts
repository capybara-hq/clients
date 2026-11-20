// The framed address page's channel to the runtime (N1). Capacitor iOS injects its bridge into
// the main frame only, so a local page framed over the runtime document has no plugin access, and
// on purpose neither platform's framed pages use one: the page asks, the runtime acts. Messages
// travel over the page's MessageChannel port (local-frames.ts, local-channel.ts), which only the
// frame the runtime created holds.
//
//   page -> runtime  address-discover {seq, input}   discover what the person typed
//   runtime -> page  address-result {seq, result}    the deployment found, or why not
//   page -> runtime  address-added {base}            use this deployment: the runtime adds it
//                                                    (only one it found itself) and opens it
//   page -> runtime  address-close                   back to what showed before
import { normalizeAddress } from "@capybara-hq/shell";
import { type FoundDeployment, resolveIcon } from "./address-model.ts";
import { type AddressErrorKind, discover, type HttpGetPort } from "./discovery.ts";

export type AddressResult = { found: FoundDeployment } | { error: AddressErrorKind; host: string };

export type AddressPageMessage =
  | { type: "address-discover"; seq: number; input: string }
  | { type: "address-added"; base: string }
  | { type: "address-close" };

export type AddressRuntimeMessage = { type: "address-result"; seq: number; result: AddressResult };

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

export function isAddressPageMessage(v: unknown): v is AddressPageMessage {
  const r = record(v);
  if (!r) return false;
  switch (r.type) {
    case "address-discover":
      return Number.isSafeInteger(r.seq) && typeof r.input === "string";
    case "address-added":
      return typeof r.base === "string";
    case "address-close":
      return true;
    default:
      return false;
  }
}

function isAddressResult(v: unknown): v is AddressResult {
  const r = record(v);
  if (!r) return false;
  const found = record(r.found);
  if (found) return typeof found.base === "string";
  return typeof r.error === "string" && typeof r.host === "string";
}

function isAddressRuntimeMessage(v: unknown): v is AddressRuntimeMessage {
  const r = record(v);
  return (
    r !== null &&
    r.type === "address-result" &&
    Number.isSafeInteger(r.seq) &&
    isAddressResult(r.result)
  );
}

function hostOf(input: string): string {
  const a = normalizeAddress(input);
  return a.ok ? new URL(a.origin).host : input.trim();
}

/**
 * Discovery as the runtime runs it for the page: a locked preset refuses any other address
 * without asking the network; otherwise the deployment's name and icon, or the error kind.
 */
export async function answerDiscover(
  input: string,
  deps: { httpGet: HttpGetPort; lockedBase: string | null; signal?: AbortSignal },
): Promise<AddressResult> {
  const host = hostOf(input);
  if (deps.lockedBase !== null) {
    const typed = normalizeAddress(input);
    if (!(typed.ok && typed.base === deps.lockedBase)) return { error: "locked", host };
  }
  const result = await discover(input, {
    httpGet: deps.httpGet,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if ("error" in result) return { error: result.error, host };
  return {
    found: {
      base: result.base,
      name: result.meta.name,
      iconUrl: resolveIcon(result.base, result.meta),
    },
  };
}

export interface AddressHost {
  /** A message from the framed address page (the caller checked its origin and window). */
  handle(message: AddressPageMessage): Promise<void>;
  /** The page was framed anew: forget what it found before. */
  reset(): void;
}

export function createAddressHost(deps: {
  httpGet: HttpGetPort;
  lockedBase(): string | null;
  /** Adds the deployment (the profile store returns the existing profile for a known base). */
  add(found: FoundDeployment): Promise<{ id: string }>;
  opened(profileId: string): void;
  closed(): void;
  post(message: AddressRuntimeMessage): void;
}): AddressHost {
  // Only a deployment the runtime discovered itself can be added, with the name and icon it saw.
  let found = new Map<string, FoundDeployment>();
  return {
    async handle(message) {
      switch (message.type) {
        case "address-discover": {
          const result = await answerDiscover(message.input, {
            httpGet: deps.httpGet,
            lockedBase: deps.lockedBase(),
          });
          if ("found" in result) found.set(result.found.base, result.found);
          deps.post({ type: "address-result", seq: message.seq, result });
          return;
        }
        case "address-added": {
          const deployment = found.get(message.base);
          if (!deployment) return;
          const profile = await deps.add(deployment);
          deps.opened(profile.id);
          return;
        }
        case "address-close":
          deps.closed();
      }
    },
    reset() {
      found = new Map();
    },
  };
}

export interface AddressClient {
  discover(input: string): Promise<AddressResult>;
  choose(base: string): void;
  close(): void;
  /** A message from the runtime, over the page's port (src/runtime/local-channel.ts). */
  receive(data: unknown): void;
}

/** The page's side; `post` sends over the page's port to the runtime. */
export function createAddressClient(deps: {
  post(message: AddressPageMessage): void;
}): AddressClient {
  let seq = 0;
  const pending = new Map<number, (result: AddressResult) => void>();
  return {
    discover(input) {
      const mine = ++seq;
      return new Promise((resolve) => {
        pending.set(mine, resolve);
        deps.post({ type: "address-discover", seq: mine, input });
      });
    },
    choose: (base) => deps.post({ type: "address-added", base }),
    close: () => deps.post({ type: "address-close" }),
    receive(data) {
      if (!isAddressRuntimeMessage(data)) return;
      const resolve = pending.get(data.seq);
      if (!resolve) return;
      pending.delete(data.seq);
      resolve(data.result);
    },
  };
}
