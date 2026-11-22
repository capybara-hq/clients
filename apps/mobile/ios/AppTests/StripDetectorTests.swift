// StripDetector (Task 31): the strip is decided by the window's safe area and reserved regions,
// never the model. Numbers from spike 1.4 (iPhone Duo outer display) and a standard iPhone.

import UIKit
import XCTest
@testable import App

final class StripDetectorTests: XCTestCase {
    func testDuoOuterPortraitHasTheStrip() {
        let safe = UIEdgeInsets(top: 0, left: 0, bottom: 34, right: 84)
        XCTAssertTrue(StripDetector.hasStrip(safeArea: safe, reservedRegion: nil))
    }

    func testIPhonePortraitHasNone() {
        let safe = UIEdgeInsets(top: 59, left: 0, bottom: 34, right: 0)
        XCTAssertFalse(StripDetector.hasStrip(safeArea: safe, reservedRegion: nil))
    }

    func testIPhoneLandscapeHasNone() {
        let safe = UIEdgeInsets(top: 0, left: 59, bottom: 21, right: 59)
        XCTAssertFalse(StripDetector.hasStrip(safeArea: safe, reservedRegion: nil))
    }

    func testAReservedRegionIsTheStrip() {
        let region = CGRect(x: 382, y: 0, width: 84, height: 678)
        XCTAssertTrue(StripDetector.hasStrip(safeArea: .zero, reservedRegion: region))
        XCTAssertFalse(StripDetector.hasStrip(safeArea: .zero, reservedRegion: .zero))
    }

    func testAnIPadOrNoInsetsHasNone() {
        XCTAssertFalse(StripDetector.hasStrip(safeArea: .zero, reservedRegion: nil))
        let ipad = UIEdgeInsets(top: 24, left: 0, bottom: 20, right: 0)
        XCTAssertFalse(StripDetector.hasStrip(safeArea: ipad, reservedRegion: nil))
    }

    // The strip's side (interaction model §10.7, D16): right with one app in the foreground, left
    // only for the left app of an inner-display split.

    func testTheSideIsRightForOneApp() {
        let outer = UIEdgeInsets(top: 0, left: 0, bottom: 34, right: 84)
        XCTAssertEqual(StripDetector.strip(safeArea: outer, reservedRegion: nil, width: 466), .right)
    }

    func testTheLeftAppOfASplitHasItsStripOnTheLeft() {
        let leftApp = UIEdgeInsets(top: 0, left: 84, bottom: 20, right: 0)
        XCTAssertEqual(StripDetector.strip(safeArea: leftApp, reservedRegion: nil, width: 500), .left)
        XCTAssertTrue(StripDetector.hasStrip(safeArea: leftApp, reservedRegion: nil))
    }

    func testAReservedRegionGivesItsEdge() {
        let right = CGRect(x: 382, y: 0, width: 84, height: 678)
        XCTAssertEqual(StripDetector.strip(safeArea: .zero, reservedRegion: right, width: 466), .right)
        let left = CGRect(x: 0, y: 0, width: 84, height: 678)
        XCTAssertEqual(StripDetector.strip(safeArea: .zero, reservedRegion: left, width: 466), .left)
    }

    func testBothSidesOrNoneIsNoStrip() {
        let landscape = UIEdgeInsets(top: 0, left: 59, bottom: 21, right: 59)
        XCTAssertNil(StripDetector.strip(safeArea: landscape, reservedRegion: nil, width: 852))
        XCTAssertNil(StripDetector.strip(safeArea: .zero, reservedRegion: nil, width: 852))
    }
}
