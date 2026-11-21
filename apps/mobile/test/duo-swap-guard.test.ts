// The DuoSwap test aid (ios/App/App/Shell/DuoSwap.swift) uses a private SpringBoard SPI and private
// entitlements. They must stay in Debug simulator builds: no Release configuration names an
// entitlements file, the only one is the App target's Debug config limited to the simulator SDK,
// the Swift file is compiled only under DEBUG on the simulator, and nothing outside DEBUG names it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ios = join(import.meta.dirname, "..", "ios");
const pbxproj = readFileSync(join(ios, "App/App.xcodeproj/project.pbxproj"), "utf8");

/** Each XCBuildConfiguration block: its name and settings text. */
function configurations(text: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /isa = XCBuildConfiguration;([\s\S]*?)\n\t\t\tname = (\w+);/g;
  for (const m of text.matchAll(re)) out.push({ name: m[2] ?? "", body: m[1] ?? "" });
  return out;
}

function swiftFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "DerivedData" ? [] : swiftFiles(path);
    return e.name.endsWith(".swift") ? [path] : [];
  });
}

/** The lines of a Swift file that sit outside every `#if DEBUG …` block. */
function outsideDebug(text: string): string[] {
  const stack: boolean[] = [];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("#if")) stack.push(/\bDEBUG\b/.test(t));
    else if (t.startsWith("#endif")) stack.pop();
    else if (t.startsWith("#else") || t.startsWith("#elseif")) {
      if (stack.length > 0) stack[stack.length - 1] = false;
    } else if (!stack.includes(true)) out.push(line);
  }
  return out;
}

describe("DuoSwap stays in Debug simulator builds", () => {
  test("no Release configuration names an entitlements file", () => {
    const releases = configurations(pbxproj).filter((c) => c.name === "Release");
    expect(releases.length).toBeGreaterThan(0);
    for (const c of releases) expect(c.body).not.toContain("CODE_SIGN_ENTITLEMENTS");
  });

  test("the only entitlements setting is Debug and limited to the simulator SDK", () => {
    const lines = pbxproj.split("\n").filter((l) => l.includes("CODE_SIGN_ENTITLEMENTS"));
    expect(lines.map((l) => l.trim())).toEqual([
      '"CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]" = DebugSimulator.entitlements;',
    ]);
    const owners = configurations(pbxproj).filter((c) => c.body.includes("CODE_SIGN_ENTITLEMENTS"));
    expect(owners.map((c) => c.name)).toEqual(["Debug"]);
  });

  test("DuoSwap.swift compiles only under DEBUG on the simulator", () => {
    const text = readFileSync(join(ios, "App/App/Shell/DuoSwap.swift"), "utf8");
    const code = text.split("\n").find((l) => l.trim() !== "" && !l.trim().startsWith("//"));
    expect(code?.trim()).toBe("#if DEBUG && targetEnvironment(simulator)");
    expect(text.trimEnd().endsWith("#endif")).toBe(true);
  });

  test("nothing outside #if DEBUG names DuoSwap", () => {
    for (const file of swiftFiles(join(ios, "App/App"))) {
      if (file.endsWith("DuoSwap.swift")) continue;
      const hits = outsideDebug(readFileSync(file, "utf8")).filter((l) => l.includes("DuoSwap"));
      expect(hits, file).toEqual([]);
    }
  });
});
