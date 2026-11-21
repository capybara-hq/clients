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
}
