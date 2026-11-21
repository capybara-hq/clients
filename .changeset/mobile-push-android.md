---
"@capybara-hq/mobile": minor
---

Push notifications on Android: the `CapybaraPush` module behind `push@1` for a build whose brand
carries FCM or JPush: the notification permission on Android 13+ (asked in context), the FCM
token under `push-fcm` where Google Play services work, else the JPush registration id under
`push-jpush` (JPush starts only after the person turned notifications on through it), the
`capybara-default` notification channel, foreground pushes handed to the runtime and taps (the
app's own banners, FCM, JPush and its vendor channels) opening their profile on their path.
`CapybaraHost` gains the registration DELETE in the profile's page, the current URL and an `open`
path. brand.properties switches each channel on (`pushFcm`, `jpushAppKey`): only then are its SDK,
its code, its components and POST_NOTIFICATIONS in the build, so the official build has none of
them. A JPush build removes the SDK's optional permissions (location, phone state, package list,
storage) and holds JPush's collection off until the person turns notifications on through it.
