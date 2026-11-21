import { describe, expect, test } from "vitest";
import { fetchMeta } from "../src/meta.ts";
import {
  offersPush,
  parsePushPayload,
  pickAndroidProvider,
  profileForPush,
  shouldPresentForeground,
} from "../src/push.ts";

const build = { appId: "com.example.app", providers: ["push-apns"] as const };

describe("offersPush", () => {
  test("true when the build's app id is listed with a provider the build carries", () => {
    const meta = { features: { push: [{ appId: "com.example.app", providers: ["push-apns"] }] } };
    expect(offersPush(meta, build)).toBe(true);
  });

  test("false for another app id, a provider the build lacks, or no push feature", () => {
    expect(
      offersPush({ features: { push: [{ appId: "com.other", providers: ["push-apns"] }] } }, build),
    ).toBe(false);
    expect(
      offersPush(
        { features: { push: [{ appId: "com.example.app", providers: ["push-fcm"] }] } },
        build,
      ),
    ).toBe(false);
    expect(offersPush({ features: { push: [] } }, build)).toBe(false);
    expect(offersPush({ features: {} }, build)).toBe(false);
    expect(offersPush({}, build)).toBe(false);
  });

  test("a build that carries no provider is never offered push", () => {
    const meta = { features: { push: [{ appId: "com.example.app", providers: ["push-apns"] }] } };
    expect(offersPush(meta, { appId: "com.example.app", providers: [] })).toBe(false);
  });
});

describe("pickAndroidProvider", () => {
  const both = { fcm: "push-fcm", aggregator: "push-jpush" };
  test("FCM with Google Play services, the aggregator without", () => {
    expect(pickAndroidProvider({ googlePlayServices: true }, both)).toBe("push-fcm");
    expect(pickAndroidProvider({ googlePlayServices: false }, both)).toBe("push-jpush");
  });

  test("the aggregator when FCM is not carried, null when neither works", () => {
    expect(pickAndroidProvider({ googlePlayServices: true }, { aggregator: "push-jpush" })).toBe(
      "push-jpush",
    );
    expect(pickAndroidProvider({ googlePlayServices: false }, { fcm: "push-fcm" })).toBeNull();
    expect(pickAndroidProvider({ googlePlayServices: true }, {})).toBeNull();
  });
});

describe("shouldPresentForeground", () => {
  const push = { origin: "https://a.example", path: "/chat/c1?org=o1" };

  test("false for the same pathname with another query", () => {
    expect(
      shouldPresentForeground(push, {
        origin: "https://a.example",
        url: "https://a.example/chat/c1?org=o2#end",
      }),
    ).toBe(false);
  });

  test("true for another path, another origin or no screen", () => {
    expect(
      shouldPresentForeground(push, {
        origin: "https://a.example",
        url: "https://a.example/chat/c2?org=o1",
      }),
    ).toBe(true);
    expect(
      shouldPresentForeground(push, {
        origin: "https://b.example",
        url: "https://b.example/chat/c1?org=o1",
      }),
    ).toBe(true);
    expect(shouldPresentForeground(push, null)).toBe(true);
  });

  test("true when the page is somewhere off its profile origin", () => {
    expect(
      shouldPresentForeground(push, {
        origin: "https://a.example",
        url: "https://idp.example/chat/c1",
      }),
    ).toBe(true);
    expect(shouldPresentForeground(push, { origin: "https://a.example", url: "not a url" })).toBe(
      true,
    );
  });
});

describe("profileForPush", () => {
  const profiles = [
    { id: "p1", origin: "https://a.example" },
    { id: "p2", origin: "https://b.example:8443" },
  ];

  test("matches the exact origin", () => {
    expect(profileForPush("https://a.example", profiles)).toBe("p1");
    expect(profileForPush("https://b.example:8443", profiles)).toBe("p2");
  });

  test("never a look-alike, another scheme or another port", () => {
    expect(profileForPush("https://a.example.evil", profiles)).toBeNull();
    expect(profileForPush("http://a.example", profiles)).toBeNull();
    expect(profileForPush("https://b.example", profiles)).toBeNull();
    expect(profileForPush("https://a.example/", profiles)).toBeNull();
  });
});

describe("parsePushPayload", () => {
  const good = { origin: "https://a.example", path: "/chat/c1?org=o1", threadId: "c1" };

  test("accepts an origin, an in-app path and a thread id", () => {
    expect(parsePushPayload({ ...good, title: "Agent" })).toEqual(good);
  });

  test("refuses a path that does not start with a single /", () => {
    for (const path of ["chat/c1", "//evil.example/x", "https://evil.example/x", "/\\evil", ""]) {
      expect(parsePushPayload({ ...good, path })).toBeNull();
    }
  });

  test("refuses an origin with a path, a trailing slash or credentials", () => {
    for (const origin of [
      "https://a.example/base",
      "https://a.example/",
      "https://u:p@a.example",
      "a.example",
      "javascript:alert(1)",
    ]) {
      expect(parsePushPayload({ ...good, origin })).toBeNull();
    }
  });

  test("refuses missing or malformed fields and an oversized path", () => {
    expect(parsePushPayload({ origin: good.origin, path: good.path })).toBeNull();
    expect(parsePushPayload({ ...good, threadId: 7 })).toBeNull();
    expect(parsePushPayload({ ...good, threadId: "" })).toBeNull();
    expect(parsePushPayload({ ...good, path: `/${"a".repeat(512)}` })).toBeNull();
  });
});

describe("meta features.push", () => {
  const body = {
    name: "Acme",
    icon: null,
    protocols: { device: { min: 3, max: 3 } },
    features: { localDevices: true, appSignIn: true },
  };
  const answer = (v: unknown) => async () => new Response(JSON.stringify(v), { status: 200 });

  test("is read from the meta", async () => {
    const push = [{ appId: "com.example.app", providers: ["push-apns", "push-fcm"] }];
    const meta = await fetchMeta(
      "https://a.example",
      answer({ ...body, features: { ...body.features, push } }),
    );
    expect("error" in meta ? null : meta.features.push).toEqual(push);
  });

  test("is left out when absent or malformed", async () => {
    for (const push of [undefined, "x", [{ appId: 1, providers: [] }], [{ appId: "a" }]]) {
      const meta = await fetchMeta(
        "https://a.example",
        answer({ ...body, features: { ...body.features, push } }),
      );
      expect("error" in meta).toBe(false);
      if (!("error" in meta)) expect(meta.features.push).toBeUndefined();
    }
  });
});
