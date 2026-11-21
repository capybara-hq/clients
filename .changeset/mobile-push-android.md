---
"@capybara-hq/mobile": minor
---

Push notifications on Android: the `CapybaraPush` module behind `push@1` for a build whose brand
carries FCM or JPush: the POST_NOTIFICATIONS permission on Android 13+ (asked in context), the FCM
token under `push-fcm` where Google Play services work, else the JPush registration id under
`push-jpush` (JPush starts only after the person turned notifications on through it), the
`capybara-default` notification channel, foreground pushes handed to the runtime and taps (the
app's own banners, FCM, JPush and its vendor channels) opening their profile on their path.
`CapybaraHost` gains the registration DELETE in the profile's page, the current URL and an `open`
path. brand.properties switches the channels on (`pushFcm`, `jpushAppKey`); without them every push
component stays disabled and the JPush SDK's optional permissions are removed from every build.
