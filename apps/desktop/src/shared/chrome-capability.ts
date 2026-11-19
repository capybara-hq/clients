// `chrome@1` is the mobile layout spec's capability key (§9.2): native chrome follows the web's
// theme. `@capybara-hq/plugin-sdk` lists it in `SHELL_CAPABILITIES` but exports neither a key in
// `SHELL_CAPABILITY_KEYS` nor its type yet; both move to the SDK import when it does.

export const CHROME_CAPABILITY_KEY = "chrome@1";

export interface ChromeCapabilityV1 {
  setAppearance(input: { scheme: "light" | "dark"; background: string }): Promise<void>;
}
