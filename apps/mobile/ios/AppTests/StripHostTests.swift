// StripHost (nav@1 minor version of 2026-11-22): the pill's tabs (the action on top, then the
// sections and search), what each tap reports, the highlight that follows `current` (null clears
// it), the account avatar and its place on the strip's side. In the app host, without a window.

import UIKit
import XCTest
@testable import App

@MainActor
final class StripHostTests: XCTestCase {
    private func state(current: String? = "chats", icon: String = "square-pen",
                       account: StripState.Account? = nil) -> StripState {
        StripState(
            items: [
                .init(id: "chats", label: "对话", badge: nil),
                .init(id: "inbox", label: "收件箱", badge: "3"),
                .init(id: "agents", label: "智能体", badge: nil),
                .init(id: "schedules", label: "定时任务", badge: nil),
                .init(id: "search", label: "搜索", badge: nil),
            ],
            current: current,
            action: .init(id: "new-conversation", label: "新会话", icon: icon),
            account: account)
    }

    private func tabs(_ host: StripHost) -> [StripTab] {
        (host.viewControllers ?? []).compactMap { $0 as? StripTab }
    }

    func testTheActionIsTheTopItemFollowedByTheSectionsAndSearch() {
        let host = StripHost()
        host.apply(state())
        XCTAssertEqual(tabs(host).map(\.itemId), ["action", "chats", "inbox", "agents", "schedules", "search"])
        XCTAssertEqual(host.actionTab.tabBarItem.title, "新会话")
        XCTAssertEqual(host.actionTab.tabBarItem.accessibilityIdentifier, "strip-action")
        XCTAssertEqual(host.actionTab.tabBarItem.image?.renderingMode, .alwaysOriginal)
        XCTAssertEqual(tabs(host)[2].tabBarItem.badgeValue, "3")
    }

    func testNothingShowsBeforeTheFirstSet() {
        let host = StripHost()
        host.apply(.empty)
        XCTAssertTrue(host.accountButton.isHidden)
        if #available(iOS 18.0, *) { XCTAssertTrue(host.isTabBarHidden) } else { XCTAssertTrue(host.tabBar.isHidden) }
    }

    func testCurrentNullClearsTheHighlightAndALaterSectionSelectsAgain() {
        let host = StripHost()
        host.apply(state(current: "agents"))
        XCTAssertEqual(host.highlighted, "agents")
        host.apply(state(current: nil))
        XCTAssertNil(host.highlighted)
        XCTAssertTrue(host.selectedViewController === host.actionTab)
        host.apply(state(current: "inbox"))
        XCTAssertEqual(host.highlighted, "inbox")
    }

    func testTapsReportAndOnlySectionsTakeTheSelection() {
        let host = StripHost()
        host.apply(state(current: "chats"))
        var selected: [String] = []
        var actions = 0
        host.onSelect = { selected.append($0) }
        host.onAction = { actions += 1 }
        let byId = Dictionary(uniqueKeysWithValues: tabs(host).map { ($0.itemId, $0) })
        XCTAssertFalse(host.tabBarController(host, shouldSelect: host.actionTab))
        XCTAssertFalse(host.tabBarController(host, shouldSelect: byId["search"]!))
        XCTAssertTrue(host.tabBarController(host, shouldSelect: byId["inbox"]!))
        XCTAssertTrue(host.tabBarController(host, shouldSelect: byId["chats"]!))
        XCTAssertEqual(actions, 1)
        XCTAssertEqual(selected, ["search", "inbox", "chats"])
    }

    func testTheAccountButtonReportsAndShowsTheInitialAndBadge() {
        let host = StripHost()
        var taps = 0
        host.onAccount = { taps += 1 }
        let account = StripState.Account(name: "Grace Hopper", avatarUrl: nil, initial: "G", badge: "2")
        host.apply(state(account: account))
        XCTAssertFalse(host.accountButton.isHidden)
        XCTAssertEqual(host.accountButton.accessibilityLabel, "Grace Hopper")
        XCTAssertEqual(host.accountButton.initialLabel.text, "G")
        XCTAssertEqual(host.accountButton.badgeLabel.text, "2")
        XCTAssertFalse(host.accountButton.badgeLabel.isHidden)
        host.accountButton.sendActions(for: .touchUpInside)
        XCTAssertTrue(host.accountButton.accessibilityActivate())
        XCTAssertEqual(taps, 2)
        host.apply(state(account: nil))
        XCTAssertTrue(host.accountButton.isHidden)
    }

    func testTheAvatarLoadsOnceAndAFailureKeepsTheInitial() {
        let host = StripHost()
        var asked: [URL] = []
        var answer: ((UIImage?) -> Void)?
        host.loadAvatar = { url, done in
            asked.append(url)
            answer = done
        }
        let url = URL(string: "https://cdn.example/a.png")!
        let account = StripState.Account(name: "G", avatarUrl: url, initial: "G", badge: nil)
        host.apply(state(account: account))
        host.apply(state(current: "inbox", account: account))
        XCTAssertEqual(asked, [url])
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { _ in }
        answer?(image)
        let shown = expectation(description: "the image shows")
        DispatchQueue.main.async {
            XCTAssertNotNil(host.accountButton.image)
            XCTAssertTrue(host.accountButton.initialLabel.isHidden)
            shown.fulfill()
        }
        wait(for: [shown], timeout: 5)
    }

    func testTheAvatarSitsInTheStripOnItsSide() {
        let bounds = CGRect(x: 0, y: 0, width: 500, height: 800)
        let right = StripHost.accountFrame(bounds: bounds, stripWidth: 84, side: .right, top: 54)
        XCTAssertEqual(right.midX, 500 - 42, accuracy: 0.5)
        XCTAssertEqual(right.minY, 62)
        let left = StripHost.accountFrame(bounds: bounds, stripWidth: 84, side: .left, top: 54)
        XCTAssertEqual(left.midX, 42, accuracy: 0.5)
        let host = StripHost()
        host.loadViewIfNeeded()
        host.side = .left
        XCTAssertEqual(host.side, .left)
    }

    func testTheActionIsFilledWithTheAccent() {
        let traits = UITraitCollection(userInterfaceStyle: .light)
        let image = StripHost.actionImage(symbol: "plus", fill: .systemOrange, ink: .white, traits: traits)
        XCTAssertEqual(image.size, CGSize(width: 30, height: 30))
        // A pixel inside the circle, off the glyph, carries the fill.
        let host = StripHost()
        host.apply(state(icon: "plus"))
        host.setAccent(UIColor(red: 1, green: 0.416, blue: 0.075, alpha: 1), ink: .white)
        XCTAssertEqual(host.actionFill, UIColor(red: 1, green: 0.416, blue: 0.075, alpha: 1))
        host.setAccent(nil, ink: nil)
        XCTAssertEqual(host.actionFill, host.view.tintColor)
    }

    func testTheStateParsesTheNewShapeAndRefusesTheOld() {
        let json: [String: Any] = [
            "items": [["id": "chats", "label": "对话"], ["id": "search", "label": "搜索"]],
            "current": NSNull(),
            "action": ["id": "new-conversation", "label": "新会话", "icon": "square-pen"],
            "account": ["name": "G", "initial": "G", "avatarUrl": NSNull(), "badge": "2"],
        ]
        let parsed = StripState(json: json)
        XCTAssertNotNil(parsed)
        XCTAssertNil(parsed?.current)
        XCTAssertEqual(parsed?.action?.icon, "square-pen")
        XCTAssertEqual(parsed?.account?.badge, "2")
        var badIcon = json
        badIcon["action"] = ["id": "x", "label": "x", "icon": "pencil"]
        XCTAssertNil(StripState(json: badIcon))
        var searchCurrent = json
        searchCurrent["current"] = "search"
        XCTAssertNil(StripState(json: searchCurrent))
        var badAvatar = json
        badAvatar["account"] = ["name": "G", "initial": "G", "avatarUrl": "javascript:alert(1)"]
        XCTAssertNil(StripState(json: badAvatar))
    }

    func testAvatarCookiesGoOnlyToTheProfilesOrigin() {
        let origin = "https://a.example"
        XCTAssertTrue(StripAvatar.sendsCookies(URL(string: "https://a.example/api/avatar")!, profileOrigin: origin))
        XCTAssertFalse(StripAvatar.sendsCookies(URL(string: "https://cdn.example/a.png")!, profileOrigin: origin))
        XCTAssertFalse(StripAvatar.sendsCookies(URL(string: "https://a.example:8443/a.png")!, profileOrigin: origin))
        XCTAssertTrue(StripAvatar.allowed(URL(string: "https://cdn.example/a.png")!, profileOrigin: origin))
        XCTAssertFalse(StripAvatar.allowed(URL(string: "http://cdn.example/a.png")!, profileOrigin: origin))
        let local = "http://10.0.0.5:3000"
        XCTAssertTrue(StripAvatar.allowed(URL(string: "http://10.0.0.5:3000/a.png")!, profileOrigin: local))
        XCTAssertFalse(StripAvatar.allowed(URL(string: "data:image/png;base64,AA")!, profileOrigin: origin))
    }
}
