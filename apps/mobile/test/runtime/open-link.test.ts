import { describe, expect, test, vi } from "vitest";
import {
  connectOpenLinks,
  createOpenLinkRouter,
  OPEN_LINK_MAX,
  openLinkTarget,
} from "../../src/runtime/open-link.ts";

const profiles = [
  { id: "p1", origin: "https://a.example", base: "https://a.example" },
  { id: "p2", origin: "https://b.example", base: "https://b.example" },
  // Two deployments on one origin under different path prefixes.
  { id: "p3", origin: "https://c.example", base: "https://c.example" },
  { id: "p4", origin: "https://c.example", base: "https://c.example/team" },
];

const link = (url: string, scheme = "capybara") =>
  `${scheme}://open?url=${encodeURIComponent(url)}`;

function router() {
  const open = vi.fn(async (_id: string, _path: string) => {});
  return { open, r: createOpenLinkRouter({ scheme: "capybara", profiles: () => profiles, open }) };
}

describe("open links", () => {
  test("open link loads the page on the matching profile", async () => {
    const { open, r } = router();
    await r.route(link("https://b.example/connectors?connected=c1#top"));
    expect(open).toHaveBeenCalledExactlyOnceWith("p2", "/connectors?connected=c1#top");
  });

  test("on a shared origin the longest base the page is within wins", async () => {
    const { open, r } = router();
    await r.route(link("https://c.example/team/connectors?connected=c1"));
    await r.route(link("https://c.example/teams"));
    await r.route(link("https://c.example/team"));
    expect(open.mock.calls).toEqual([
      ["p4", "/team/connectors?connected=c1"],
      ["p3", "/teams"],
      ["p4", "/team"],
    ]);
  });

  test("open link for an unknown origin is ignored", async () => {
    const { open, r } = router();
    for (const url of [
      "https://evil.example/connectors",
      // Another scheme or port is another origin.
      "http://a.example/",
      "https://a.example:8443/",
    ]) {
      await r.route(link(url));
    }
    expect(open).not.toHaveBeenCalled();
  });

  test("non-http(s) URLs, other link kinds and other schemes are ignored", () => {
    for (const raw of [
      link("javascript:alert(1)"),
      link("file:///etc/passwd"),
      link("https://user:pw@a.example/"),
      link("https://a.example//evil.example/x"),
      link("https://a.example/x", "other"),
      "capybara://connect?url=https%3A%2F%2Fa.example",
      "capybara://auth/callback?code=c&state=s&iss=https%3A%2F%2Fa.example",
      "capybara://open",
      "nonsense",
      link(`https://a.example/${"x".repeat(OPEN_LINK_MAX)}`),
    ]) {
      expect(openLinkTarget(raw, "capybara", profiles)).toBeNull();
    }
  });

  function fakePlugin(kept: string[]) {
    let listener: ((e: unknown) => void) | undefined;
    const remove = vi.fn(async () => {});
    return {
      remove,
      announce: () => listener?.({}),
      plugin: {
        addListener: vi.fn(async (_name: "appUrlOpen", l: (e: unknown) => void) => {
          listener = l;
          return { remove };
        }),
        // Native keeps only the last link: taking answers it once.
        takeAppUrl: vi.fn(async () => {
          const url = kept.pop();
          kept.length = 0;
          return url === undefined ? {} : { url };
        }),
      },
    };
  }

  test("only the last link kept before listening opens, once", async () => {
    // Two links piled up before the runtime listened; native kept the last one only.
    const kept = [link("https://a.example/first"), link("https://b.example/last")];
    const f = fakePlugin(kept);
    const route = vi.fn(async (_link: string) => {});
    connectOpenLinks(f.plugin, { route });
    await vi.waitFor(() => expect(f.plugin.takeAppUrl).toHaveBeenCalled());
    await vi.waitFor(() => expect(route).toHaveBeenCalled());
    expect(route).toHaveBeenCalledExactlyOnceWith(link("https://b.example/last"));
  });

  test("each announcement takes the kept link until stopped", async () => {
    const kept: string[] = [];
    const f = fakePlugin(kept);
    const route = vi.fn(async (_link: string) => {});
    const stop = connectOpenLinks(f.plugin, { route });
    await vi.waitFor(() => expect(f.plugin.takeAppUrl).toHaveBeenCalledTimes(1));
    expect(route).not.toHaveBeenCalled();
    kept.push(link("https://a.example/x"));
    f.announce();
    await vi.waitFor(() =>
      expect(route).toHaveBeenCalledExactlyOnceWith(link("https://a.example/x")),
    );
    stop();
    kept.push(link("https://a.example/y"));
    f.announce();
    await vi.waitFor(() => expect(f.remove).toHaveBeenCalled());
    expect(route).toHaveBeenCalledTimes(1);
  });
});
