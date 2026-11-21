// The in-WebView sign-in block (mobile spec §4.3, decision 7): a profile WebView never signs in
// inside itself. iOS cannot intercept `fetch`, so native compiles these rules (the shell's
// `signInBlockRules` for the profile's base) into a `WKContentRuleList` and adds it to the profile
// WebView before its first load; the navigation policy cancels the same routes as well. Android
// runs the Kotlin port of `isInWindowSignIn` in `shouldInterceptRequest` and needs no rules.
import { signInBlockRules } from "@capybara-hq/shell";

/**
 * The encoded rule list for `base`, as `WKContentRuleListStore.compileContentRuleList` takes it.
 * Throws for a base that yields no rules: native then opens nothing (fail closed).
 */
export function blockRulesFor(base: string): string {
  const rules = signInBlockRules(base);
  if (rules.length === 0) throw new Error("no sign-in block rules for this base");
  return JSON.stringify(rules);
}

/**
 * M9: a removed profile's compiled rule list is deleted with its store (iOS keeps lists in
 * `WKContentRuleListStore.default()` across launches; Android has none and resolves).
 */
export function removeBlockRulesOnRemoval(
  store: { onRemoved(listener: (p: { id: string }) => void | Promise<void>): () => void },
  native: { removeBlockRules(options: { profileId: string }): Promise<void> },
): () => void {
  return store.onRemoved(async (p) => {
    try {
      await native.removeBlockRules({ profileId: p.id });
    } catch {
      // A list left behind blocks only the sign-in routes of a profile that no longer loads.
    }
  });
}
