import UIKit
import XCTest
@testable import App

@MainActor
final class MenuHostTests: XCTestCase {
    private func input(_ items: [[String: Any]], extra: [String: Any] = [:]) -> [String: Any] {
        ["items": items].merging(extra) { a, _ in a }
    }

    func testParseKeepsFlagsTitleAndAnchor() throws {
        let model = try XCTUnwrap(MenuModel.parse(input(
            [["id": "a", "label": "A"], ["id": "b", "label": "B", "destructive": true, "disabled": true]],
            extra: ["title": "T", "anchor": ["x": 1, "y": 2, "width": 3, "height": 4], "cancelLabel": "Cancel"])))
        XCTAssertEqual(model.title, "T")
        XCTAssertEqual(model.items, [
            MenuItem(id: "a", label: "A", destructive: false, disabled: false),
            MenuItem(id: "b", label: "B", destructive: true, disabled: true),
        ])
        XCTAssertEqual(model.anchor, MenuAnchor(x: 1, y: 2, width: 3, height: 4))
    }

    func testParseRefusesWhatTheRuntimeRefuses() {
        let many = (0..<13).map { ["id": "i\($0)", "label": "x"] as [String: Any] }
        let bad: [[String: Any]] = [
            [:],
            input([]),
            input(many),
            input([["id": "a b", "label": "x"]]),
            input([["id": "a", "label": String(repeating: "x", count: 65)]]),
            input([["id": "a", "label": "x", "icon": "trash"]]),
            input([["id": "a", "label": "x", "items": [["id": "b", "label": "y"]]]]),
            input([["id": "a", "label": "x", "destructive": 1]]),
            input([["id": "a", "label": "x"], ["id": "a", "label": "y"]]),
            input([["id": "a", "label": "x"]], extra: ["extra": 1]),
            input([["id": "a", "label": "x"]], extra: ["anchor": ["x": "1", "y": 2, "width": 3, "height": 4]]),
            input([["id": "a", "label": "x"]], extra: ["title": String(repeating: "x", count: 129)]),
        ]
        for case let value in bad { XCTAssertNil(MenuModel.parse(value), "\(value)") }
    }

    func testADisabledOrUnknownItemIsNeverTheAnswer() throws {
        let model = try XCTUnwrap(MenuModel.parse(input(
            [["id": "a", "label": "A"], ["id": "b", "label": "B", "disabled": true]])))
        XCTAssertEqual(model.answer(for: "a"), "a")
        XCTAssertNil(model.answer(for: "b"))
        XCTAssertNil(model.answer(for: "zzz"))
        XCTAssertNil(model.answer(for: nil))
    }

    func testTheSheetCarriesTheFlagsAndAnswersOnce() throws {
        let model = try XCTUnwrap(MenuModel.parse(input([
            ["id": "a", "label": "A"],
            ["id": "b", "label": "B", "destructive": true],
            ["id": "c", "label": "C", "disabled": true],
        ])))
        let presenter = RecordingPresenter()
        let host = MenuHost()
        var answers: [String?] = []
        host.show(model, cancelLabel: "Cancel", from: presenter, anchorView: nil) { answers.append($0) }
        let sheet = try XCTUnwrap(presenter.sheet)
        XCTAssertEqual(sheet.actions.map(\.title), ["A", "B", "C", "Cancel"])
        XCTAssertEqual(sheet.actions.map(\.isEnabled), [true, true, false, true])
        XCTAssertEqual(sheet.actions.map(\.style), [.default, .destructive, .default, .cancel])
        XCTAssertTrue(host.isShowing)
        // A second menu while one is showing is answered nil without presenting.
        var second: [String?] = []
        host.show(model, cancelLabel: "Cancel", from: presenter, anchorView: nil) { second.append($0) }
        XCTAssertEqual(second.count, 1)
        XCTAssertNil(second[0])
        invoke(sheet.actions[1])
        XCTAssertEqual(answers, ["b"])
        // Cancelling afterwards never answers again.
        host.cancel()
        XCTAssertEqual(answers, ["b"])
        XCTAssertFalse(host.isShowing)
    }

    func testCancelAnswersNilAndDismissesWhatIsShowing() throws {
        let model = try XCTUnwrap(MenuModel.parse(input([["id": "a", "label": "A"]])))
        let presenter = RecordingPresenter()
        let host = MenuHost()
        var answers: [String?] = []
        host.show(model, cancelLabel: "Cancel", from: presenter, anchorView: nil) { answers.append($0) }
        host.cancel()
        XCTAssertEqual(answers.count, 1)
        XCTAssertNil(answers[0])
    }

    func testTheAnchorIsClampedToTheViewBounds() {
        let bounds = CGRect(x: 0, y: 0, width: 100, height: 200)
        XCTAssertEqual(MenuHost.clamp(MenuAnchor(x: -50, y: 500, width: 1e9, height: -3), to: bounds),
                       CGRect(x: 0, y: 200, width: 100, height: 0))
        XCTAssertEqual(MenuHost.clamp(MenuAnchor(x: 10, y: 20, width: 30, height: 40), to: bounds),
                       CGRect(x: 10, y: 20, width: 30, height: 40))
    }

    func testAMenuOnAMidPresentationControllerAnswersNilAtOnce() throws {
        let model = try XCTUnwrap(MenuModel.parse(input([["id": "a", "label": "A"]])))
        let presenter = BusyPresenter()
        let host = MenuHost()
        var answers: [String?] = []
        host.show(model, cancelLabel: "Cancel", from: presenter, anchorView: nil) { answers.append($0) }
        XCTAssertEqual(answers.count, 1)
        XCTAssertNil(answers[0])
        XCTAssertFalse(host.isShowing)
    }

    func testExternalURLs() {
        XCTAssertNotNil(ExternalURL.parse("https://example.com/x"))
        XCTAssertNotNil(ExternalURL.parse("http://example.com"))
        XCTAssertNil(ExternalURL.parse("ftp://example.com"))
        XCTAssertNil(ExternalURL.parse("javascript:alert(1)"))
        XCTAssertNil(ExternalURL.parse("https:///nohost"))
        XCTAssertNil(ExternalURL.parse("https://a.example/" + String(repeating: "x", count: 2049)))
    }

    /// Runs an action's handler, as a tap would.
    private func invoke(_ action: UIAlertAction) {
        typealias Handler = @convention(block) (UIAlertAction) -> Void
        let handler = action.value(forKey: "handler") as AnyObject
        unsafeBitCast(handler, to: Handler.self)(action)
    }
}

/// A presenter that records the sheet instead of showing it.
private final class RecordingPresenter: UIViewController {
    var sheet: UIAlertController?
    override func present(_ vc: UIViewController, animated: Bool, completion: (() -> Void)? = nil) {
        sheet = vc as? UIAlertController
        completion?()
    }
}

private final class BusyPresenter: UIViewController {
    override var presentedViewController: UIViewController? { UIViewController() }
}
