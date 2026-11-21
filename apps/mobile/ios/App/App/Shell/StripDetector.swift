// Whether the window has a strip (mobile app spec §6.1): a side region the system reserves along
// the trailing edge, as on the iPhone Duo's outer and inner displays. Decided by the window, never
// by the device model: iOS 27.1's reserved-region API where it reports such a region, else a
// trailing safe-area inset with no leading one (a notch in landscape insets both sides equally).

import UIKit

enum StripDetector {
    /// True when iOS reports a reserved region for the strip, else when the trailing (right) inset
    /// is above 0 and the leading (left) one is 0.
    static func hasStrip(safeArea: UIEdgeInsets, reservedRegion: CGRect?) -> Bool {
        if let region = reservedRegion, !region.isEmpty { return true }
        return safeArea.right > 0 && safeArea.left == 0
    }

    /// The window's answer: its safe area and a reserved region along its trailing edge.
    @MainActor static func hasStrip(window: UIWindow?) -> Bool {
        guard let window else { return false }
        return hasStrip(safeArea: window.safeAreaInsets, reservedRegion: reservedStrip(in: window))
    }

    /// A reserved region that is a strip: on the trailing edge, most of the height, a narrow width.
    /// The Duo's sensor housing (a short occlusion region at the top of the strip) is not one.
    @MainActor static func reservedStrip(in view: UIView) -> CGRect? {
        guard #available(iOS 27.1, *) else { return nil }
        let bounds = view.bounds
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        return view.reservedRegions(kind: .occlusion).first {
            $0.frame.maxX >= bounds.maxX - 1 && $0.frame.height > bounds.height / 2
                && $0.frame.width < bounds.width / 3
        }?.frame
    }
}

/// Reports every change of the window's strip: an invisible view over the host's root that looks
/// again on each safe-area, layout and trait change (opening, closing, rotating, a scene resize).
final class StripProbe: UIView {
    var onChange: ((Bool) -> Void)?
    private(set) var visible = false
    /// While the iPhone Duo opens or closes, the window passes through a layout with no strip
    /// for about 80 ms (measured on the simulator: top 82, right 0) before the other display's
    /// strip arrives. A strip that goes away counts only once it stays away this long; a strip
    /// that arrives counts at once.
    static let lossSettle: TimeInterval = 0.3
    private var pendingLoss: DispatchWorkItem?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        isAccessibilityElement = false
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        registerForTraitChanges([UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self]) {
            (probe: StripProbe, _: UITraitCollection) in probe.evaluate()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("StripProbe is created in code") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        evaluate()
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        evaluate()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        evaluate()
    }

    func evaluate() {
        let now = StripDetector.hasStrip(window: window)
        if now { cancelLoss() }
        guard now != visible else { return }
        if now { return commit(true) }
        guard pendingLoss == nil else { return }
        let confirm = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingLoss = nil
            if !StripDetector.hasStrip(window: self.window), self.visible { self.commit(false) }
        }
        pendingLoss = confirm
        DispatchQueue.main.asyncAfter(deadline: .now() + StripProbe.lossSettle, execute: confirm)
    }

    private func cancelLoss() {
        pendingLoss?.cancel()
        pendingLoss = nil
    }

    private func commit(_ now: Bool) {
        visible = now
        onChange?(now)
    }
}
