// `chrome@1` is the mobile layout spec's capability key (§9.2): native chrome follows the web's
// theme. `@capybara-hq/plugin-sdk` lists it in `SHELL_CAPABILITIES` but exports neither a key in
// `SHELL_CAPABILITY_KEYS` nor its type yet; both move to the SDK import (`ChromeCapabilityV1`,
// `SHELL_CAPABILITY_KEYS.chrome`) with the next SDK release, which carries `tokens` and
// `singleScheme` as well.
import type { Tokens } from "./appearance.ts";

export const CHROME_CAPABILITY_KEY = "chrome@1";

export interface ChromeAppearanceInput {
  scheme: "light" | "dark";
  /** The theme's `--cb-bg`: a hex or `rgb()` / `rgba()` color. */
  background: string;
  /** The computed main color tokens (desktop spec §6.10); all seven or none. */
  tokens?: Tokens;
  /** The platform's UI theme has one scheme only: no light / dark toggle anywhere. */
  singleScheme?: boolean;
}

export interface ChromeCapabilityV1 {
  setAppearance(input: ChromeAppearanceInput): Promise<void>;
}
