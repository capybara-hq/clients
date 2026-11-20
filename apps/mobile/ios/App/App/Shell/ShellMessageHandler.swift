// The one native endpoint of a profile WebView: `window.webkit.messageHandlers.capybaraShell`.
// WebKit exposes it to every frame and origin in the WebView, so every message is checked here:
// the frame (main frame, exact profile origin: OriginGate), then the payload's shape. Anything
// else is dropped with a "denied" reply, so the page's promise settles and learns nothing.

import Foundation
import os
import WebKit

/// A post the gate let through, in the shape `PagePost` (src/runtime/protocol.ts) describes.
enum ShellPost {
    case hello(docId: String)
    /// The document's one outstanding pull for pushes (PushQueue).
    case listen(docId: String)
    case call(docId: String, callId: String, key: String, fn: String, args: [Any], activation: Bool)

    static let maxBytes = 65536

    /// Nil unless `body` has exactly the expected types and sizes (the patterns match protocol.ts).
    static func parse(_ body: Any) -> ShellPost? {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String,
              let docId = dict["docId"] as? String, matches(docId, docIdPattern)
        else { return nil }
        guard JSONSerialization.isValidJSONObject(dict),
              let data = try? JSONSerialization.data(withJSONObject: dict), data.count <= maxBytes
        else { return nil }
        switch type {
        case "hello":
            return .hello(docId: docId)
        case "listen":
            return .listen(docId: docId)
        case "call":
            guard let callId = dict["callId"] as? String, matches(callId, callIdPattern),
                  let key = dict["key"] as? String, matches(key, keyPattern),
                  let fn = dict["fn"] as? String, matches(fn, fnPattern),
                  let args = dict["args"] as? [Any],
                  let activation = dict["activation"] as? NSNumber, isBool(activation)
            else { return nil }
            return .call(docId: docId, callId: callId, key: key, fn: fn, args: args,
                         activation: activation.boolValue)
        default:
            return nil
        }
    }

    private static let docIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9-]{8,64}$")
    private static let callIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9:_.-]{1,128}$")
    private static let keyPattern = try! NSRegularExpression(pattern: "^[A-Za-z][A-Za-z0-9]{0,63}@[0-9]{1,4}$")
    private static let fnPattern = try! NSRegularExpression(pattern: "^[A-Za-z][A-Za-z0-9]{0,63}$")

    private static func matches(_ value: String, _ pattern: NSRegularExpression) -> Bool {
        let range = NSRange(value.startIndex..., in: value)
        return pattern.firstMatch(in: value, options: [.anchored], range: range)?.range == range
    }

    private static func isBool(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }
}

/// What the gate tells its owner. Held weakly: WebKit retains the handler strongly.
protocol ShellMessageHandlerDelegate: AnyObject {
    func shellMessageHandler(accepted post: ShellPost, origin: Origin,
                             reply: @escaping (Any?, String?) -> Void)
    func shellMessageHandler(dropped reason: String, callId: String?, isMainFrame: Bool, origin: String)
}

final class ShellMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "capybaraShell"
    private static let log = Logger(subsystem: "com.capybarahq.shell", category: "gate")

    let profileOrigin: URL
    weak var delegate: ShellMessageHandlerDelegate?

    init(profileOrigin: URL) {
        self.profileOrigin = profileOrigin
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let frame = message.frameInfo
        let security = frame.securityOrigin
        let callId = (message.body as? [String: Any])?["callId"] as? String
        let shown = "\(security.protocol)://\(security.host):\(security.port)"
        guard OriginGate.accept(isMainFrame: frame.isMainFrame, scheme: security.protocol,
                                host: security.host, port: security.port, profileOrigin: profileOrigin),
              let origin = Origin(scheme: security.protocol, host: security.host, port: security.port)
        else {
            delegate?.shellMessageHandler(dropped: "frame", callId: callId,
                                          isMainFrame: frame.isMainFrame, origin: shown)
            replyHandler(nil, "denied")
            return
        }
        guard let post = ShellPost.parse(message.body) else {
            delegate?.shellMessageHandler(dropped: "shape", callId: callId,
                                          isMainFrame: frame.isMainFrame, origin: shown)
            replyHandler(nil, "denied")
            return
        }
        guard let delegate else {
            // The WebView is gone: no owner to report to or to answer with.
            ShellMessageHandler.log.info("drop no-delegate id=\(callId ?? "", privacy: .public)")
            replyHandler(nil, "denied")
            return
        }
        delegate.shellMessageHandler(accepted: post, origin: origin, reply: replyHandler)
    }
}
