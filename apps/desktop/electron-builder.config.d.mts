import type { Configuration } from "electron-builder";

export function createConfig(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): Configuration;
declare const config: Configuration;
export default config;
