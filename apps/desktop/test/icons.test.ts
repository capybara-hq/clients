import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const dir = new URL("../build/icons/", import.meta.url);

function header(name: string) {
  const b = readFileSync(new URL(name, dir));
  return {
    signature: [...b.subarray(0, 8)],
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
    colorType: b[25],
  };
}

describe("the generated icons", () => {
  test.each([
    ["icon.png", 1024],
    ["trayTemplate.png", 16],
    ["trayTemplate@2x.png", 32],
  ])("%s is a %i px RGBA PNG", (name, size) => {
    expect(header(name)).toEqual({
      signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      width: size,
      height: size,
      colorType: 6,
    });
  });
});

test("icon.icns is a macOS icon file", () => {
  const b = readFileSync(new URL("icon.icns", dir));
  expect(b.subarray(0, 4).toString("ascii")).toBe("icns");
  expect(b.readUInt32BE(4)).toBe(b.length);
});
