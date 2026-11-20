import XCTest
@testable import App

// Pushes reach only the document that said hello and listened; owed replies end with their
// document or their lifetime, and their ids never repeat across WebView instances.
@MainActor
final class PushQueueTests: XCTestCase {
    private final class Recorder {
        var answers: [(Any?, String?)] = []
        lazy var reply: ShellReply = { [unowned self] value, error in self.answers.append((value, error)) }
        var batches: [[[String: Any]]] { answers.compactMap { $0.0 as? [[String: Any]] } }
        var errors: [String] { answers.compactMap { $0.1 } }
    }

    func testAPushReachesOnlyTheListeningDocument() {
        let queue = PushQueue()
        queue.open(docId: "doc-aaaa-0001")
        queue.push(["type": "state", "n": 1])
        let listener = Recorder()
        XCTAssertTrue(queue.listen(docId: "doc-aaaa-0001", reply: listener.reply))
        XCTAssertEqual(listener.batches.first?.compactMap { $0["n"] as? Int }, [1])
    }

    func testAPushNeverReachesADocumentThatDidNotPostTheListen() {
        let queue = PushQueue()
        queue.open(docId: "doc-aaaa-0001")
        let listener = Recorder()
        queue.listen(docId: "doc-aaaa-0001", reply: listener.reply)
        // The document ends (a commit to a sandboxed or foreign document): its listen ends "gone".
        queue.end()
        XCTAssertEqual(listener.errors, ["gone"])
        // A push now has no document; a listen from anything but a gated hello is refused.
        queue.push(["type": "state", "n": 2])
        let stranger = Recorder()
        XCTAssertFalse(queue.listen(docId: "doc-aaaa-0001", reply: stranger.reply))
        XCTAssertFalse(queue.listen(docId: "doc-bbbb-0002", reply: stranger.reply))
        XCTAssertEqual(stranger.errors, ["gone", "gone"])
        XCTAssertTrue(stranger.batches.isEmpty)
        // The next profile document does not inherit what was queued for the old one.
        queue.open(docId: "doc-cccc-0003")
        let next = Recorder()
        queue.listen(docId: "doc-cccc-0003", reply: next.reply)
        XCTAssertTrue(next.answers.isEmpty)
        queue.push(["type": "state", "n": 3])
        XCTAssertEqual(next.batches.first?.compactMap { $0["n"] as? Int }, [3])
    }

    func testAPushQueuedForOneDocumentIsDroppedWhenAnotherSaysHello() {
        let queue = PushQueue()
        queue.open(docId: "doc-aaaa-0001")
        queue.push(["type": "state", "n": 1])
        queue.open(docId: "doc-bbbb-0002")
        let listener = Recorder()
        queue.listen(docId: "doc-bbbb-0002", reply: listener.reply)
        XCTAssertTrue(listener.answers.isEmpty)
    }

    func testOneListenAtATime() {
        let queue = PushQueue()
        queue.open(docId: "doc-aaaa-0001")
        let first = Recorder(), second = Recorder()
        queue.listen(docId: "doc-aaaa-0001", reply: first.reply)
        queue.listen(docId: "doc-aaaa-0001", reply: second.reply)
        XCTAssertEqual(first.batches.map(\.count), [0])
        queue.push(["type": "event"])
        XCTAssertEqual(second.batches.map(\.count), [1])
    }

    func testTheQueueIsBounded() {
        let queue = PushQueue()
        queue.open(docId: "doc-aaaa-0001")
        for n in 0..<(PushQueue.maxQueued + 10) { queue.push(["n": n]) }
        let listener = Recorder()
        queue.listen(docId: "doc-aaaa-0001", reply: listener.reply)
        XCTAssertEqual(listener.batches.first?.count, PushQueue.maxQueued)
        XCTAssertEqual(listener.batches.first?.first?["n"] as? Int, 10)
    }
}

@MainActor
final class PendingRepliesTests: XCTestCase {
    func testIdsCarryARandomPrefixPerInstance() {
        let a = PendingReplies(schedule: { _, _ in }), b = PendingReplies(schedule: { _, _ in })
        XCTAssertNotEqual(a.prefix, b.prefix)
        let id = a.add { _, _ in }
        XCTAssertTrue(id.hasPrefix("\(a.prefix)-"))
        XCTAssertNil(b.take(id), "another instance never resolves this id")
        XCTAssertNotNil(a.take(id))
        XCTAssertNil(a.take(id), "answered once")
    }

    func testAnUnansweredCallExpiresAsFailed() {
        var timers: [() -> Void] = []
        let pending = PendingReplies(lifetime: 5, schedule: { delay, run in
            XCTAssertEqual(delay, 5)
            timers.append(run)
        })
        var answer: Any?
        let id = pending.add { value, _ in answer = value }
        timers.forEach { $0() }
        XCTAssertEqual((answer as? [String: Any])?["code"] as? String, "failed")
        XCTAssertNil(pending.take(id))
    }

    func testFlushEndsEveryEntryAndALaterTimerDoesNothing() {
        var timers: [() -> Void] = []
        let pending = PendingReplies(schedule: { _, run in timers.append(run) })
        var errors: [String] = []
        _ = pending.add { _, e in errors.append(e ?? "") }
        _ = pending.add { _, e in errors.append(e ?? "") }
        pending.flush("gone")
        timers.forEach { $0() }
        XCTAssertEqual(errors, ["gone", "gone"])
        XCTAssertEqual(pending.count, 0)
    }
}
