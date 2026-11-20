# in-window-sign-in.json

The shared vectors for blocking sign-in inside a profile WebView: `[{ method, url, base, blocked }]`.
The TypeScript guard (`isInWindowSignIn`, `signInBlockRules`), the Swift port (iOS rules and the
navigation policy) and the Kotlin port (`shouldInterceptRequest`) all pass this one file.

- `iosBlocksAnyMethod: true`: iOS content-blocker rules know no method, so they block this entry
  even though `blocked` is false.
- A double-encoded `%25xx` is a deliberate non-goal on all three platforms: the server never decodes
  twice, so no vector expects it to be blocked and no port should decode twice.

## Compiling the iOS rules with real WebKit (macOS)

`signInBlockRules` output must compile in WebKit's content-blocker compiler: it turns every
url-filter into automata, and a rule with nested groups or many optional parts can make the compile
never finish. vitest cannot catch that, so check it by hand after changing the rules:

```bash
node --experimental-strip-types packages/shell/scripts/dump-rules.ts > /tmp/rules.json
swift packages/shell/scripts/compile-rules.swift /tmp/rules.json   # OK <base> per list, exit 1 on a rejection
```

(`dump-rules.ts` lists the bases: plain, a path prefix, a port, CJK, a space.)
