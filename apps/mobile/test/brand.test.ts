import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { type Brand, brand, validateBrand } from "../brand.ts";
import { applyBrand, renderProperties, renderXcconfig } from "../scripts/apply-brand.ts";
import { carriedProviders } from "../src/push/brand.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFile(`${appRoot}${rel}`, "utf8");

const forkBrand: Brand = {
  ...brand,
  appId: "com.example.work",
  push: {
    apns: { environment: "production" },
    fcm: { googleServicesFile: "android/app/google-services.json" },
    aggregator: { appKey: "0123456789abcdef01234567" },
  },
};

describe("validateBrand", () => {
  const bad = (patch: Partial<Brand>) => validateBrand({ ...brand, ...patch });

  test("accepts the official brand", () => {
    expect(validateBrand(brand)).toEqual([]);
  });

  test.each<[string, Partial<Brand>, RegExp]>([
    ["an app id that is not reverse DNS", { appId: "capybara" }, /appId/],
    ["an app id with an underscore", { appId: "com.cap_ybara.app" }, /appId/],
    ["an app id with a hyphen (Android refuses it)", { appId: "com.cap-ybara.app" }, /appId/],
    ["an app id segment starting with a digit", { appId: "com.example.1app" }, /appId/],
    ["a product name with a comment marker", { productName: "A // B" }, /productName/],
    ["a product name with an expansion", { productName: "A $(X)" }, /productName/],
    ["an icon with another name", { icon: "assets/logo.png" }, /icon/],
    [
      "a splash with another name",
      { splash: { ...brand.splash, image: "s.png" } },
      /splash\.image/,
    ],
    ["a reserved scheme", { scheme: "https" }, /scheme/],
    ["an upper-case scheme", { scheme: "Cap" }, /scheme/],
    ["a non-https preset", { presetUrl: "http://x.example" }, /presetUrl/],
    ["a lock without a preset", { lockToPreset: true, presetUrl: null }, /lockToPreset/],
    [
      "splash colours outside #rrggbb",
      { splash: { ...brand.splash, background: { light: "white", dark: "#0A0A0" } } },
      /splash\.background\.light/,
    ],
  ])("flags %s", (_name, patch, message) => {
    expect(bad(patch).join("\n")).toMatch(message);
  });

  test.each<[string, NonNullable<Brand["push"]>, RegExp]>([
    ["a push field with no channel", {}, /push needs at least one channel/],
    [
      "an APNs environment outside the two",
      { apns: { environment: "staging" as "sandbox" } },
      /push\.apns\.environment/,
    ],
    [
      "a google-services.json elsewhere",
      { fcm: { googleServicesFile: "google-services.json" } },
      /push\.fcm\.googleServicesFile/,
    ],
    ["an empty JPush app key", { aggregator: { appKey: "" } }, /push\.aggregator\.appKey/],
    ["a JPush app key with a newline", { aggregator: { appKey: "ab\ncd" } }, /appKey/],
  ])("flags %s", (_name, push, message) => {
    expect(validateBrand({ ...brand, push }).join("\n")).toMatch(message);
  });

  test("accepts a fork brand with every push channel", () => {
    expect(validateBrand(forkBrand)).toEqual([]);
  });

  test("accepts an https preset with a lock", () => {
    expect(bad({ presetUrl: "https://capybara.example", lockToPreset: true })).toEqual([]);
  });
});

describe("the brand's push channels", () => {
  test("the official brand carries none and writes no push setting", () => {
    expect(brand.push).toBeUndefined();
    expect(carriedProviders(brand.push)).toEqual([]);
    const xcconfig = renderXcconfig(brand);
    expect(xcconfig).not.toContain("BRAND_APS_ENVIRONMENT");
    expect(xcconfig).not.toContain("CODE_SIGN_ENTITLEMENTS");
    const properties = renderProperties(brand);
    expect(properties).not.toContain("pushFcm");
    expect(properties).not.toContain("jpushAppKey");
  });

  test("a fork brand with all three carries each and writes each setting", () => {
    expect(carriedProviders(forkBrand.push)).toEqual(["push-apns", "push-fcm", "push-jpush"]);
    expect(carriedProviders(forkBrand.push, "ios")).toEqual(["push-apns"]);
    expect(carriedProviders(forkBrand.push, "android")).toEqual(["push-fcm", "push-jpush"]);
    const xcconfig = renderXcconfig(forkBrand);
    expect(xcconfig).toContain("BRAND_APS_ENVIRONMENT = production\n");
    expect(xcconfig).toContain("CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*] = Push.entitlements\n");
    const properties = renderProperties(forkBrand);
    expect(properties).toContain("pushFcm=true\n");
    expect(properties).toContain("jpushAppKey=0123456789abcdef01234567\n");
  });

  test("a sandbox APNs build signs with the development environment", () => {
    const b = { ...brand, push: { apns: { environment: "sandbox" as const } } };
    expect(renderXcconfig(b)).toContain("BRAND_APS_ENVIRONMENT = development\n");
    expect(renderProperties(b)).not.toMatch(/pushFcm|jpushAppKey/);
  });
});

describe("applyBrand --check", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function copy(): Promise<string> {
    dir = await mkdtemp(`${tmpdir()}/brand-`);
    const root = `${dir}/`;
    for (const file of [
      "ios/App/Brand.xcconfig",
      "android/brand.properties",
      "brand-assets.sha256",
      "assets/icon.png",
      "assets/splash.png",
      "ios/App/App.xcodeproj/project.pbxproj",
      "ios/App/App/Info.plist",
      "android/app/src/main/AndroidManifest.xml",
      "android/app/build.gradle",
      "ios/App/Push.entitlements",
    ]) {
      await cp(`${appRoot}${file}`, `${root}${file}`, { recursive: true });
    }
    return root;
  }

  test("is clean for the committed files", async () => {
    expect(await applyBrand({ check: true })).toEqual({ drift: [] });
  });

  test("names Brand.xcconfig when it carries another id", async () => {
    const root = await copy();
    const text = await readFile(`${root}ios/App/Brand.xcconfig`, "utf8");
    await writeFile(`${root}ios/App/Brand.xcconfig`, text.replace(brand.appId, "com.other.app"));
    const { drift } = await applyBrand({ check: true, root });
    expect(drift).toEqual(["ios/App/Brand.xcconfig"]);
  });

  test("names brand.properties when the scheme differs", async () => {
    const root = await copy();
    await writeFile(`${root}android/brand.properties`, "applicationId=x.y\nscheme=z\n");
    expect((await applyBrand({ check: true, root })).drift).toEqual(["android/brand.properties"]);
  });

  test("names brand-assets.sha256 when the icon changed without regenerating", async () => {
    const root = await copy();
    await cp(`${root}assets/splash.png`, `${root}assets/icon.png`);
    expect((await applyBrand({ check: true, root })).drift).toEqual(["brand-assets.sha256"]);
  });

  const edit = async (root: string, file: string, from: string | RegExp, to: string) => {
    const text = await readFile(`${root}${file}`, "utf8");
    expect(text).toMatch(from);
    await writeFile(`${root}${file}`, text.replace(from, to));
  };

  test.each<[string, string, string | RegExp, string]>([
    [
      "a literal bundle id in the App target",
      "ios/App/App.xcodeproj/project.pbxproj",
      '"$(BRAND_APP_ID)"',
      "com.capybarahq.mobile",
    ],
    ["a literal display name", "ios/App/App/Info.plist", "$(BRAND_NAME)", "Capybara"],
    ["a literal URL scheme", "ios/App/App/Info.plist", "$(BRAND_SCHEME)", "capybara"],
    [
      "a literal manifest scheme",
      "android/app/src/main/AndroidManifest.xml",
      `android:scheme="\${brandScheme}"`,
      'android:scheme="capybara"',
    ],
    [
      "a literal scheme in the open links' filter",
      "android/app/src/main/AndroidManifest.xml",
      /android:scheme="\$\{brandScheme\}" android:host="open"/,
      'android:scheme="capybara" android:host="open"',
    ],
    [
      "a literal application id",
      "android/app/build.gradle",
      /applicationId brandProperties\.getProperty\("applicationId"\)/,
      'applicationId "com.capybarahq.mobile"',
    ],
    [
      "a literal app name",
      "android/app/build.gradle",
      /resValue "string", "app_name", brandProperties\.getProperty\("appName"\)/,
      'resValue "string", "app_name", "Capybara"',
    ],
  ])("names the native file with %s", async (_name, file, from, to) => {
    const root = await copy();
    await edit(root, file, from, to);
    expect((await applyBrand({ check: true, root })).drift).toEqual([file]);
  });

  test("names Push.entitlements when the entitlement no longer comes from the brand", async () => {
    const root = await copy();
    await edit(root, "ios/App/Push.entitlements", "$(BRAND_APS_ENVIRONMENT)", "production");
    expect((await applyBrand({ check: true, root })).drift).toEqual(["ios/App/Push.entitlements"]);
  });

  test("names Brand.xcconfig when its APNs environment disagrees with the brand", async () => {
    const root = await copy();
    await writeFile(`${root}ios/App/Brand.xcconfig`, renderXcconfig(forkBrand));
    await writeFile(`${root}android/brand.properties`, renderProperties(forkBrand));
    expect((await applyBrand({ check: true, root, brand: forkBrand })).drift).toEqual([]);
    await edit(root, "ios/App/Brand.xcconfig", "= production", "= development");
    expect((await applyBrand({ check: true, root, brand: forkBrand })).drift).toEqual([
      "ios/App/Brand.xcconfig",
    ]);
  });

  test("names both generated files when the brand gains push and they were not regenerated", async () => {
    const root = await copy();
    expect((await applyBrand({ check: true, root, brand: forkBrand })).drift).toEqual([
      "ios/App/Brand.xcconfig",
      "android/brand.properties",
    ]);
  });

  test("names build.gradle when it no longer reads a push switch", async () => {
    const root = await copy();
    await edit(
      root,
      "android/app/build.gradle",
      /brandProperties\.getProperty\("jpushAppKey", ""\)/,
      '""',
    );
    expect((await applyBrand({ check: true, root })).drift).toEqual(["android/app/build.gradle"]);
  });

  test("writes nothing in check mode", async () => {
    const root = await copy();
    await writeFile(`${root}brand-assets.sha256`, "stale\n");
    await applyBrand({ check: true, root });
    expect(await readFile(`${root}brand-assets.sha256`, "utf8")).toBe("stale\n");
  });

  test("the generated files match the brand's values", async () => {
    expect(await read("ios/App/Brand.xcconfig")).toContain(`BRAND_APP_ID = ${brand.appId}`);
    expect(await read("android/brand.properties")).toContain(`applicationId=${brand.appId}`);
  });
});
