// The push module's ways in and out (mobile spec §5.2, §5.3).
//
// `CapybaraPush` is a Capacitor plugin on the bridge of the app's local pages: only the runtime
// (src/push/plugin.ts) calls it, never a deployment's page. A profile page reaches push only as
// `push@1`, through the shell's gated message handler (ShellMessageHandler: main frame, exact
// profile origin), which forwards the call to the runtime, which calls this plugin. It is the
// native side of `PushNative` (src/push/native.ts): permission, the APNs token, banners the
// runtime asks for, and the `foreground`, `tap` and `token` events.
//
// Also here: the profile WebView's side of push that `CapybaraHost` exposes (ShellPlugin.swift):
// the registration DELETE run in the profile's page, and the checks on a push's in-app path.

import Capacitor
import Foundation
import UIKit
import UserNotifications
import WebKit

@objc(PushPlugin)
public class PushPlugin: CAPPlugin, CAPBridgedPlugin, PushSink {
    public let identifier = "PushPlugin"
    public let jsName = "CapybaraPush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "permission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "token", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "googlePlayServices", returnType: CAPPluginReturnPromise),
    ]

    /// How long `token` waits for APNs to answer a registration.
    static let tokenDeadline: TimeInterval = 30
    static let maxTitle = 256
    static let maxBody = 1024

    override public func load() {
        DispatchQueue.main.async {
            let center = PushCenter.shared
            // Capacitor's NotificationRouter is the notification center's delegate once the bridge
            // exists; it hands remote and local notifications to these handlers.
            self.bridge?.notificationRouter.pushNotificationHandler = center
            self.bridge?.notificationRouter.localNotificationHandler = center
            center.sink = self
        }
    }

    func push(event: String, data: [String: Any], retain: Bool) {
        notifyListeners(event, data: data, retainUntilConsumed: retain)
    }

    @objc func permission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            call.resolve(["permission": PushPermission.from(settings.authorizationStatus)])
        }
    }

    /// The OS prompt (only shown while the permission is undetermined), then the permission.
    @objc func requestPermission(_ call: CAPPluginCall) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in
            center.getNotificationSettings { settings in
                call.resolve(["permission": PushPermission.from(settings.authorizationStatus)])
            }
        }
    }

    /// `{ token }` for `push-apns`; rejects for any other channel or when APNs gives none.
    @objc func token(_ call: CAPPluginCall) {
        guard call.getString("provider") == PushProvider.apns else {
            return call.reject("this build registers with push-apns only")
        }
        DispatchQueue.main.async {
            var finished = false
            let finish: (Result<String, Error>) -> Void = { result in
                if finished { return }
                finished = true
                switch result {
                case .success(let token): call.resolve(["token": token])
                case .failure: call.reject("APNs gave no device token")
                }
            }
            let center = PushCenter.shared
            let wait = center.token(register: { UIApplication.shared.registerForRemoteNotifications() },
                                    done: finish)
            if let wait {
                DispatchQueue.main.asyncAfter(deadline: .now() + PushPlugin.tokenDeadline) { center.expire(wait) }
            }
        }
    }

    /// A banner for a foreground push the runtime decided to show; its tap reports `data`.
    @objc func present(_ call: CAPPluginCall) {
        guard let title = call.getString("title"), let body = call.getString("body"),
              let data = call.getObject("data")
        else {
            return call.reject("present needs title, body and data")
        }
        let content = UNMutableNotificationContent()
        content.title = String(title.prefix(PushPlugin.maxTitle))
        content.body = String(body.prefix(PushPlugin.maxBody))
        content.sound = .default
        if let thread = data["threadId"] as? String { content.threadIdentifier = thread }
        content.userInfo = PushPayload.presentedUserInfo(data)
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if error != nil { call.reject("the banner could not be shown") } else { call.resolve() }
        }
    }

    /// Android only; an iPhone never has Google Play services.
    @objc func googlePlayServices(_ call: CAPPluginCall) {
        call.resolve(["available": false])
    }
}

extension PushCenter: NotificationHandlerProtocol {
    func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        let userInfo = notification.request.content.userInfo
        if Thread.isMainThread { return presentationOptions(for: userInfo) }
        return DispatchQueue.main.sync { presentationOptions(for: userInfo) }
    }

    func didReceive(response: UNNotificationResponse) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        let userInfo = response.notification.request.content.userInfo
        DispatchQueue.main.async { self.tapped(userInfo) }
    }
}

// MARK: The profile WebView's side

/// The URL `pushDeleteRegistration` may DELETE: exactly
/// `<base>/api/v1/me/push-registrations/<id>` as the runtime builds it (Android: PushUrls).
enum PushRegistrationURL {
    static let path = "/api/v1/me/push-registrations/"
    private static let idPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,128}$")

    static func accept(_ raw: String, base: String) -> Bool {
        let prefix = base + path
        guard raw.hasPrefix(prefix) else { return false }
        let id = String(raw.dropFirst(prefix.count))
        let range = NSRange(id.startIndex..., in: id)
        return idPattern.firstMatch(in: id, options: [.anchored], range: range)?.range == range
    }
}

/// A tapped push's in-app path on a profile (`OpenProfileRequest.path`): one leading `/`, no
/// backslash, at most 512 characters, and `origin + path` stays on `origin`.
enum ProfileOpenPath {
    static let maxLength = 512

    static func url(origin: String, path: String) -> URL? {
        guard (1...maxLength).contains(path.count), path.hasPrefix("/"), !path.hasPrefix("//"),
              !path.contains("\\"), let profile = Origin(string: origin),
              let url = URL(string: origin + path), let scheme = url.scheme, let host = url.host,
              Origin(scheme: scheme, host: host, port: url.port ?? 0) == profile
        else { return nil }
        return url
    }
}

extension ProfileWebView {
    /// Loads `origin + path` (a tapped push), or the base when there is no path or it does not
    /// resolve on the profile origin.
    func loadEntry(path: String?) {
        if let path, let url = ProfileOpenPath.url(origin: profileOrigin.serialized, path: path) {
            load(URLRequest(url: url))
        } else {
            loadBase()
        }
    }

    /// The top document's URL while it is on the profile origin.
    var currentProfileURL: String? {
        currentProfileOrigin == nil ? nil : url?.absoluteString
    }

    /// DELETEs a push registration from the top document (its session cookie), like the sign-in
    /// exchange: nil (refused) unless `target` is the profile's registration URL; `{ ok: false,
    /// status: 0 }` while the top document is off the profile origin; else `{ ok, status }` once
    /// (the script or the deadline). The same contract as Android.
    func deleteRegistration(url target: String, done: @escaping ([String: Any]?) -> Void) {
        guard PushRegistrationURL.accept(target, base: base) else { return done(nil) }
        let failed: [String: Any] = ["ok": false, "status": 0]
        guard currentProfileOrigin != nil else { return done(failed) }
        var finished = false
        let finish: ([String: Any]) -> Void = { result in
            if finished { return }
            finished = true
            done(result)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + ExchangeScript.deadline) { finish(failed) }
        callAsyncJavaScript(PushDeleteScript.source,
                            arguments: ["url": target, "origin": profileOrigin.serialized],
                            in: nil, in: .defaultClient) { result in
            guard case .success(let value) = result, let r = value as? [String: Any],
                  let ok = r["ok"] as? Bool
            else { return finish(failed) }
            finish(["ok": ok, "status": (r["status"] as? NSNumber)?.intValue ?? 0])
        }
    }
}

/// A fixed function body for `callAsyncJavaScript`; its only inputs are its arguments.
enum PushDeleteScript {
    static let source = """
    if (location.origin !== origin) return { ok: false, status: 0 };
    const init = {
      method: "DELETE",
      headers: { "X-Capybara-Csrf": "1" },
      credentials: "include",
      redirect: "error",
      cache: "no-store",
    };
    if (typeof AbortSignal.timeout === "function") init.signal = AbortSignal.timeout(30000);
    try {
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, status: 0 };
    }
    """
}
