// The iOS side of push (core spec §9, mobile spec §5.2): the APNs device token, the payload a push
// carries and what the app does with a push it receives. The runtime decides (src/push/connect.ts):
// a remote push that arrives in the foreground is never shown by the OS here, it goes to the
// runtime as `foreground`, and the runtime asks for a banner (`present`) unless the push's page is
// on screen; that banner is the only thing shown in the foreground. A tap on either goes to the
// runtime as `tap`, held until its listener attaches (a tap that launched the app).
//
// Nothing here logs a token or a payload.

import Foundation
import UserNotifications

/// The provider key of a registration made by this build (the `push-apns` plugin).
enum PushProvider {
    static let apns = "push-apns"
}

enum PushToken {
    /// The APNs device token as APNs and the `push-apns` plugin take it: lowercase hex.
    static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }
}

/// The permission names of `push@1` (`PushPermission` in @capybara-hq/plugin-sdk).
enum PushPermission {
    static func from(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "prompt"
        @unknown default: return "denied"
        }
    }
}

enum PushPayload {
    /// Marks a banner the runtime asked for (`present`); its runtime data rides under `dataKey`.
    static let presentedKey = "capybaraPresented"
    static let dataKey = "capybaraData"

    /// The runtime's data from a remote push's user info: `origin`, `path`, `threadId` (APNs
    /// `aps.thread-id`) and the alert's `title` and `body`. Strings only; anything else is left out
    /// (the runtime validates the routing fields again: parsePushPayload).
    static func data(from userInfo: [AnyHashable: Any]) -> [String: Any] {
        var data: [String: Any] = [:]
        if let origin = userInfo["origin"] as? String { data["origin"] = origin }
        if let path = userInfo["path"] as? String { data["path"] = path }
        let aps = userInfo["aps"] as? [String: Any]
        if let thread = aps?["thread-id"] as? String { data["threadId"] = thread }
        switch aps?["alert"] {
        case let body as String:
            data["body"] = body
        case let alert as [String: Any]:
            if let title = alert["title"] as? String { data["title"] = title }
            if let body = alert["body"] as? String { data["body"] = body }
        default:
            break
        }
        return data
    }

    /// The user info of a banner the runtime asked for: its data, strings only (a plist).
    static func presentedUserInfo(_ data: [String: Any]) -> [AnyHashable: Any] {
        [presentedKey: true, dataKey: data.compactMapValues { $0 as? String }]
    }

    /// The runtime's data of a banner it asked for; nil for a remote push.
    static func presented(from userInfo: [AnyHashable: Any]) -> [String: Any]? {
        guard userInfo[presentedKey] as? Bool == true, let data = userInfo[dataKey] as? [String: Any] else {
            return nil
        }
        return data.compactMapValues { $0 as? String }
    }

    /// What a tap reports: the banner's runtime data, else the remote push's.
    static func tapData(from userInfo: [AnyHashable: Any]) -> [String: Any] {
        presented(from: userInfo) ?? data(from: userInfo)
    }
}

/// Where the center's events go: the `CapybaraPush` plugin (PushBridge.swift).
protocol PushSink: AnyObject {
    /// `retain`: kept by Capacitor until the first listener of `event` consumes it.
    func push(event: String, data: [String: Any], retain: Bool)
}

enum PushError: Error {
    case registrationFailed
}

/// The app's push state: the token, the waits for it, and the received pushes. Call it on the main
/// thread (the delegate entry points hop there).
final class PushCenter: NSObject {
    static let shared = PushCenter()

    /// Whether the OS shows a notification in the foreground; by default only the runtime's banner.
    private let decide: ([AnyHashable: Any]) -> Bool

    weak var sink: PushSink? {
        didSet { flushHeld() }
    }

    /// Taps that came before the sink: a tap that launched the app.
    private var held: [[String: Any]] = []
    private var token: String?
    private var waiting: [(id: UUID, done: (Result<String, Error>) -> Void)] = []

    init(decide: @escaping ([AnyHashable: Any]) -> Bool = { PushPayload.presented(from: $0) != nil }) {
        self.decide = decide
    }

    // MARK: The token

    /// The current token, or registers with APNs and waits; waits that overlap share one
    /// registration. Returns the wait's id for `expire` (nil when answered at once).
    @discardableResult
    func token(register: () -> Void, done: @escaping (Result<String, Error>) -> Void) -> UUID? {
        if let token {
            done(.success(token))
            return nil
        }
        let id = UUID()
        waiting.append((id, done))
        if waiting.count == 1 { register() }
        return id
    }

    /// A wait ran out of time: it fails and leaves, so a later `token` registers again instead of
    /// queueing behind a registration APNs never answered.
    func expire(_ id: UUID) {
        guard let index = waiting.firstIndex(where: { $0.id == id }) else { return }
        let wait = waiting.remove(at: index)
        wait.done(.failure(PushError.registrationFailed))
    }

    /// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
    func didRegister(_ deviceToken: Data) {
        let next = PushToken.hex(deviceToken)
        let previous = token
        token = next
        let waits = waiting
        waiting = []
        for wait in waits { wait.done(.success(next)) }
        if let previous, previous != next {
            sink?.push(event: "token", data: ["provider": PushProvider.apns, "token": next], retain: false)
        }
    }

    /// `application(_:didFailToRegisterForRemoteNotificationsWithError:)`.
    func didFail() {
        let waits = waiting
        waiting = []
        for wait in waits { wait.done(.failure(PushError.registrationFailed)) }
    }

    // MARK: Received pushes

    /// `willPresent`: a remote push goes to the runtime; the OS shows only what `decide` allows.
    func presentationOptions(for userInfo: [AnyHashable: Any]) -> UNNotificationPresentationOptions {
        if PushPayload.presented(from: userInfo) == nil {
            sink?.push(event: "foreground", data: PushPayload.data(from: userInfo), retain: false)
        }
        return decide(userInfo) ? [.banner, .sound] : []
    }

    /// `didReceive`: the person tapped a push or the runtime's banner.
    func tapped(_ userInfo: [AnyHashable: Any]) {
        let data = PushPayload.tapData(from: userInfo)
        guard let sink else { return held.append(data) }
        sink.push(event: "tap", data: data, retain: true)
    }

    private func flushHeld() {
        guard let sink, !held.isEmpty else { return }
        let taps = held
        held = []
        for data in taps { sink.push(event: "tap", data: data, retain: true) }
    }
}

// Both the app's own delegate (set at launch, so a launch tap is never missed) and Capacitor's
// NotificationRouter (which becomes the center's delegate once the bridge exists and routes to its
// handlers) end here.
extension PushCenter: UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let userInfo = notification.request.content.userInfo
        DispatchQueue.main.async { completionHandler(self.presentationOptions(for: userInfo)) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        DispatchQueue.main.async {
            if response.actionIdentifier == UNNotificationDefaultActionIdentifier { self.tapped(userInfo) }
            completionHandler()
        }
    }
}
