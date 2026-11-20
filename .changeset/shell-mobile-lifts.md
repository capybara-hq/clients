---
"@capybara-hq/shell": minor
"@capybara-hq/desktop": patch
---

The shell package now holds the sign-in guard (`isInWindowSignIn`, `signInBlockRules`), the
validators (`sameOriginUrl`, `isBackgroundColor`, `isRecord`) and the Shell environment installer
(`installShellEnvironment` with a `kind`), plus a Web Crypto PKCE (`createPkceWeb`), a `Buffer`-free
`fetchMeta` and the mobile catalog keys. The desktop app imports them from there; its behavior is
unchanged.
