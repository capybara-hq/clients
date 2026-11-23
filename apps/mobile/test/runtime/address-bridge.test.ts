import { describe, expect, test, vi } from "vitest";
import {
  type AddressPageMessage,
  type AddressRuntimeMessage,
  answerDiscover,
  createAddressClient,
  createAddressHost,
  isAddressPageMessage,
} from "../../src/runtime/address-bridge.ts";
import type { FoundDeployment } from "../../src/runtime/address-model.ts";
import type { HttpGetPort, HttpGetResult } from "../../src/runtime/discovery.ts";

const META = {
  name: "Acme",
  icon: "/api/v1/meta/icon.png?v=1",
  icons: { app: "/api/v1/meta/icon.png?v=1", maskable: null, favicon: null },
  features: { appSignIn: true },
};
const ok = (meta: unknown): HttpGetResult => ({ status: 200, body: JSON.stringify(meta) });

function fakeGet(answers: Record<string, HttpGetResult>): HttpGetPort & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async get(url) {
      urls.push(url);
      const a = answers[url];
      if (!a) throw new Error("ECONNREFUSED");
      return a;
    },
  };
}

const ACME = "https://acme.example.com";
const ACME_META = `${ACME}/api/v1/meta`;
const ACME_FOUND: FoundDeployment = {
  base: ACME,
  name: "Acme",
  iconUrl: `${ACME}/api/v1/meta/icon.png?v=1`,
};

describe("answerDiscover (the runtime's discovery for the framed address page)", () => {
  test("found: the name and the icon resolved against the base", async () => {
    const result = await answerDiscover("acme.example.com", {
      httpGet: fakeGet({ [ACME_META]: ok(META) }),
      lockedBase: null,
    });
    expect(result).toEqual({ found: ACME_FOUND });
  });

  test("a failure carries the kind and the host", async () => {
    const result = await answerDiscover("acme.example.com", {
      httpGet: fakeGet({}),
      lockedBase: null,
    });
    expect(result).toEqual({ error: "unreachable", host: "acme.example.com" });
  });

  test("locked: another address is refused without asking the network", async () => {
    const httpGet = fakeGet({ [ACME_META]: ok(META) });
    const result = await answerDiscover("other.example.com", { httpGet, lockedBase: ACME });
    expect(result).toEqual({ error: "locked", host: "other.example.com" });
    expect(httpGet.urls).toEqual([]);
  });

  test("locked: the preset itself is accepted", async () => {
    const result = await answerDiscover(`${ACME}/`, {
      httpGet: fakeGet({ [ACME_META]: ok(META) }),
      lockedBase: ACME,
    });
    expect(result).toEqual({ found: ACME_FOUND });
  });
});

describe("the runtime side of the address page protocol", () => {
  function setup(lockedBase: string | null = null) {
    const posted: AddressRuntimeMessage[] = [];
    const add = vi.fn(async (found: FoundDeployment) => ({ id: `id:${found.base}` }));
    const opened = vi.fn((_id: string) => {});
    const closed = vi.fn(() => {});
    const host = createAddressHost({
      httpGet: fakeGet({ [ACME_META]: ok(META) }),
      lockedBase: () => lockedBase,
      add,
      opened,
      closed,
      post: (m) => posted.push(m),
    });
    return { host, posted, add, opened, closed };
  }

  test("address-discover runs discovery and answers address-result with the same seq", async () => {
    const { host, posted } = setup();
    await host.handle({ type: "address-discover", seq: 7, input: "acme.example.com" });
    expect(posted).toEqual([{ type: "address-result", seq: 7, result: { found: ACME_FOUND } }]);
  });

  test("address-added adds the discovered deployment with its name and icon, then opens it", async () => {
    const { host, add, opened } = setup();
    await host.handle({ type: "address-discover", seq: 1, input: "acme.example.com" });
    await host.handle({ type: "address-added", base: ACME });
    expect(add).toHaveBeenCalledExactlyOnceWith(ACME_FOUND);
    expect(opened).toHaveBeenCalledExactlyOnceWith(`id:${ACME}`);
  });

  test("address-added for a base the runtime never found adds nothing", async () => {
    const { host, add, opened } = setup();
    await host.handle({ type: "address-added", base: ACME });
    await host.handle({ type: "address-discover", seq: 1, input: "down.example.com" });
    await host.handle({ type: "address-added", base: "https://down.example.com" });
    expect(add).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });

  test("reset forgets what was found (a new framing starts clean)", async () => {
    const { host, add } = setup();
    await host.handle({ type: "address-discover", seq: 1, input: "acme.example.com" });
    host.reset();
    await host.handle({ type: "address-added", base: ACME });
    expect(add).not.toHaveBeenCalled();
  });

  test("a discovery still running when the page is framed anew is dropped (M3)", async () => {
    let release: (r: HttpGetResult) => void = () => {};
    const slow = new Promise<HttpGetResult>((r) => (release = r));
    const posted: AddressRuntimeMessage[] = [];
    const add = vi.fn(async (found: FoundDeployment) => ({ id: found.base }));
    const host = createAddressHost({
      httpGet: { get: () => slow },
      lockedBase: () => null,
      add,
      opened: () => {},
      closed: () => {},
      post: (m) => posted.push(m),
    });
    const old = host.handle({ type: "address-discover", seq: 1, input: "acme.example.com" });
    host.reset();
    release(ok(META));
    await old;
    expect(posted).toEqual([]);
    await host.handle({ type: "address-added", base: ACME });
    expect(add).not.toHaveBeenCalled();
  });

  test("a locked preset is enforced by the runtime too", async () => {
    const { host, posted } = setup("https://other.example.com");
    await host.handle({ type: "address-discover", seq: 2, input: "acme.example.com" });
    expect(posted).toEqual([
      { type: "address-result", seq: 2, result: { error: "locked", host: "acme.example.com" } },
    ]);
  });

  test("address-close closes", async () => {
    const { host, closed } = setup();
    await host.handle({ type: "address-close" });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("only well-formed page messages count", () => {
    const good: AddressPageMessage[] = [
      { type: "address-discover", seq: 1, input: "x" },
      { type: "address-added", base: ACME },
      { type: "address-close" },
    ];
    for (const m of good) expect(isAddressPageMessage(m)).toBe(true);
    for (const bad of [
      null,
      "address-close",
      { type: "address-discover", seq: "1", input: "x" },
      { type: "address-discover", seq: 1 },
      { type: "address-added", profileId: "p1" },
      { type: "address-result", seq: 1, result: {} },
      { type: "httpGet", url: ACME },
    ]) {
      expect(isAddressPageMessage(bad)).toBe(false);
    }
  });
});

describe("the page side of the address page protocol", () => {
  function setup() {
    const sent: AddressPageMessage[] = [];
    const client = createAddressClient({ post: (m) => sent.push(m) });
    return { sent, client };
  }

  test("discover posts address-discover and resolves with the matching address-result", async () => {
    const { sent, client } = setup();
    const first = client.discover("one.example.com");
    const second = client.discover("acme.example.com");
    expect(sent).toEqual([
      { type: "address-discover", seq: 1, input: "one.example.com" },
      { type: "address-discover", seq: 2, input: "acme.example.com" },
    ]);
    client.receive({ type: "address-result", seq: 2, result: { found: ACME_FOUND } });
    client.receive({
      type: "address-result",
      seq: 1,
      result: { error: "unreachable", host: "one" },
    });
    expect(await second).toEqual({ found: ACME_FOUND });
    expect(await first).toEqual({ error: "unreachable", host: "one" });
  });

  test("a malformed or unknown answer is ignored", async () => {
    const { client } = setup();
    const pending = client.discover("acme.example.com");
    client.receive({ type: "address-result", seq: 1 });
    client.receive({ type: "address-result", seq: 9, result: { found: ACME_FOUND } });
    client.receive({ type: "address-result", seq: "1", result: { found: ACME_FOUND } });
    const settled = await Promise.race([pending.then(() => "settled"), Promise.resolve("pending")]);
    expect(settled).toBe("pending");
    client.receive({ type: "address-result", seq: 1, result: { error: "locked", host: "h" } });
    expect(await pending).toEqual({ error: "locked", host: "h" });
  });

  test("choose posts address-added with the base; close posts address-close", () => {
    const { sent, client } = setup();
    client.choose(ACME);
    client.close();
    expect(sent).toEqual([{ type: "address-added", base: ACME }, { type: "address-close" }]);
  });
});
