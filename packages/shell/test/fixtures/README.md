# in-window-sign-in.json

The shared vectors for blocking sign-in inside a profile WebView: `[{ method, url, base, blocked }]`.
The TypeScript guard (`isInWindowSignIn`, `signInBlockRules`), the Swift port (iOS rules and the
navigation policy) and the Kotlin port (`shouldInterceptRequest`) all pass this one file.

- `iosBlocksAnyMethod: true`: iOS content-blocker rules know no method, so they block this entry
  even though `blocked` is false.
- A double-encoded `%25xx` is a deliberate non-goal on all three platforms: the server never decodes
  twice, so no vector expects it to be blocked and no port should decode twice.
