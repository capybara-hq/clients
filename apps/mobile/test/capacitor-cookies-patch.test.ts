import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Android single-store mode keeps a deployment's session in the default WebView profile. Unpatched,
// Capacitor's CapacitorCookies removes that profile's session cookies on every Activity start and
// destroy even with `enabled: false` (measured: DefaultProfileCookiesTest). The pnpm patch
// (patches/@capacitor__android@*.patch) makes both calls depend on `isEnabled()`.
test("the installed Capacitor Android only wipes session cookies when CapacitorCookies is on", async () => {
  const source = await readFile(
    fileURLToPath(
      new URL(
        "../node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/CapacitorCookies.java",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const calls = source.split("\n").filter((line) => line.includes("removeSessionCookies()"));
  expect(calls).toHaveLength(2);
  for (const line of calls)
    expect(line.trim()).toBe("if (isEnabled()) this.cookieManager.removeSessionCookies();");
});
