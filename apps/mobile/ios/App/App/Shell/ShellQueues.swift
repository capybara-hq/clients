// The two pieces of per-document state a profile WebView keeps for its current document: the
// replies it still owes (calls the runtime has not answered) and the pushes waiting for the
// document's outstanding `listen` post. Both end with the document.

import Foundation

typealias ShellReply = (Any?, String?) -> Void

/// Pushes (state changes, capability events) for the current document. The shell script keeps one
/// `listen` post outstanding; its reply carries the queued pushes. WebKit binds a reply to the
/// document that posted, so a push can only reach the document that listened: a document that
/// never passed the gate never posts a listen, and on every commit the queue and the outstanding
/// listen end.
final class PushQueue {
    static let maxQueued = 64

    private(set) var docId: String?
    private var listener: ShellReply?
    private var queued: [[String: Any]] = []

    /// A new document said hello through the gate: it becomes the only one pushes are for.
    func open(docId: String) {
        end()
        self.docId = docId
    }

    /// The current document's listen. Anything else is answered "gone" and gets nothing.
    @discardableResult
    func listen(docId: String, reply: @escaping ShellReply) -> Bool {
        guard docId == self.docId else {
            reply(nil, "gone")
            return false
        }
        // One listen at a time: an earlier one ends with nothing (the script re-posts).
        listener?([[String: Any]](), nil)
        listener = reply
        deliver()
        return true
    }

    /// Queues a push for the current document; dropped when there is none.
    func push(_ message: [String: Any]) {
        guard docId != nil else { return }
        queued.append(message)
        if queued.count > PushQueue.maxQueued { queued.removeFirst(queued.count - PushQueue.maxQueued) }
        deliver()
    }

    /// The document ended (commit, web process crash, teardown).
    func end() {
        docId = nil
        queued.removeAll()
        let ended = listener
        listener = nil
        ended?(nil, "gone")
    }

    private func deliver() {
        guard let reply = listener, !queued.isEmpty else { return }
        listener = nil
        let batch = queued
        queued.removeAll()
        reply(batch, nil)
    }
}

/// The replies a WebView owes. Ids carry a random prefix per WebView instance, so a late runtime
/// reply for an earlier (or recreated) WebView never resolves this one's call. Every entry has a
/// lifetime: it ends with its document ("gone") or, unanswered, after `lifetime` (`failed`).
final class PendingReplies {
    typealias Schedule = (TimeInterval, @escaping () -> Void) -> Void

    static let defaultLifetime: TimeInterval = 600

    let prefix: String
    private let lifetime: TimeInterval
    private let schedule: Schedule
    private var next = 0
    private var entries: [String: ShellReply] = [:]

    init(lifetime: TimeInterval = PendingReplies.defaultLifetime,
         prefix: String = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12)).lowercased(),
         schedule: @escaping Schedule = { delay, run in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: run) }) {
        self.lifetime = lifetime
        self.prefix = prefix
        self.schedule = schedule
    }

    var count: Int { entries.count }

    /// Stores a reply and answers its id.
    func add(_ reply: @escaping ShellReply) -> String {
        next += 1
        let id = "\(prefix)-\(next)"
        entries[id] = reply
        schedule(lifetime) { [weak self] in
            self?.entries.removeValue(forKey: id)?(["ok": false, "code": "failed"], nil)
        }
        return id
    }

    func take(_ id: String) -> ShellReply? {
        entries.removeValue(forKey: id)
    }

    /// Ends every entry, e.g. with "gone" when the document ends.
    func flush(_ error: String) {
        let all = entries
        entries.removeAll()
        for reply in all.values { reply(nil, error) }
    }
}
