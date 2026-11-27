import { describe, expect, test, vi } from "vitest";
import {
  connectOpenLinks,
  createOpenLinkRouter,
  OPEN_LINK_MAX,
  openLinkTarget,
} from "../../src/runtime/open-link.ts";

const profiles = [
  { id: "p1", origin: "https://a.example" },
  { id: "p2", origin: "https://b.example" },
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

  test("native's appUrlOpen events reach the router until stopped", async () => {
    let listener: ((e: unknown) => void) | undefined;
    const remove = vi.fn(async () => {});
    const plugin = {
      addListener: vi.fn(async (_name: "appUrlOpen", l: (e: unknown) => void) => {
        listener = l;
        return { remove };
      }),
    };
    const route = vi.fn(async (_link: string) => {});
    const stop = connectOpenLinks(plugin, { route });
    expect(plugin.addListener).toHaveBeenCalledWith("appUrlOpen", expect.any(Function));
    listener?.({ url: link("https://a.example/") });
    listener?.({ url: 5 });
    listener?.(null);
    expect(route).toHaveBeenCalledExactlyOnceWith(link("https://a.example/"));
    stop();
    listener?.({ url: link("https://a.example/") });
    expect(route).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(remove).toHaveBeenCalled());
  });
});
