// Whether the window has a strip and on which edge (mobile app spec §6.1, interaction model
// §10.7): a side region the system reserves, as on the iPhone Duo's outer and inner displays, on
// the right with one app in the foreground and on the left for the left app of an inner-display
// split. Decided by the window, never by the device model: iOS 27.1's reserved-region API where it
// reports such a region, else a safe-area inset on exactly one side (a notch in landscape insets
// both sides equally).

import UIKit

/// The edge the strip is on: the right with one app in the foreground, the left only for the left
/// app of an inner-display split (interaction model §10.7, D16).
enum StripSide: String {
    case left, right
}

enum StripDetector {
    /// The strip's edge, or nil for none: a reserved region along one edge (its side), else a
    /// safe-area inset on exactly one side (right > 0 with left 0, or left > 0 with right 0).
    static func strip(safeArea: UIEdgeInsets, reservedRegion: CGRect?, width: CGFloat) -> StripSide? {
        if let region = reservedRegion, !region.isEmpty {
            return width > 0 && region.midX < width / 2 ? .left : .right
        }
        if safeArea.right > 0 && safeArea.left == 0 { return .right }
        if safeArea.left > 0 && safeArea.right == 0 { return .left }
        return nil
    }

    /// True when the window has a strip on either edge.
    static func hasStrip(safeArea: UIEdgeInsets, reservedRegion: CGRect?, width: CGFloat = 0) -> Bool {
        strip(safeArea: safeArea, reservedRegion: reservedRegion, width: width) != nil
    }

    /// The window's answer: its safe area and a reserved region along one of its edges.
    @MainActor static func strip(window: UIWindow?) -> StripSide? {
        guard let window else { return nil }
        return strip(safeArea: window.safeAreaInsets, reservedRegion: reservedStrip(in: window),
                     width: window.bounds.width)
    }

    @MainActor static func hasStrip(window: UIWindow?) -> Bool { strip(window: window) != nil }

    /// A reserved region that is a strip: along the leading or trailing edge, most of the height, a
    /// narrow width. The Duo's sensor housing (a short occlusion region at the top of the strip) is
    /// not one.
    @MainActor static func reservedStrip(in view: UIView) -> CGRect? {
#if compiler(>=6.4)
        guard #available(iOS 27.1, *) else { return nil }
        let bounds = view.bounds
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        return view.reservedRegions(kind: .occlusion).first {
            ($0.frame.maxX >= bounds.maxX - 1 || $0.frame.minX <= bounds.minX + 1)
                && $0.frame.height > bounds.height / 2 && $0.frame.width < bounds.width / 3
        }?.frame
#else
        return nil
#endif
    }
}

/// Reports every change of the window's strip: an invisible view over the host's root that looks
/// again on each safe-area, layout and trait change (opening, closing, rotating, a scene resize).
final class StripProbe: UIView {
    var onChange: ((Bool, StripSide) -> Void)?
    private(set) var visible = false
    /// The strip's edge (kept while there is none, for when it returns).
    private(set) var side: StripSide = .right
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
        let found = StripDetector.strip(window: window)
        let now = found != nil
        if now { cancelLoss() }
        // A split move (inner display) changes the side with the strip kept: reported at once.
        if let found, visible, found != side { return commit(true, found) }
        guard now != visible else { return }
        if let found { return commit(true, found) }
        guard pendingLoss == nil else { return }
        let confirm = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingLoss = nil
            if !StripDetector.hasStrip(window: self.window), self.visible { self.commit(false, self.side) }
        }
        pendingLoss = confirm
        DispatchQueue.main.asyncAfter(deadline: .now() + StripProbe.lossSettle, execute: confirm)
    }

    private func cancelLoss() {
        pendingLoss?.cancel()
        pendingLoss = nil
    }

    private func commit(_ now: Bool, _ edge: StripSide) {
        visible = now
        side = edge
        onChange?(now, edge)
    }
}
