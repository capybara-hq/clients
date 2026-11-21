// The strip navigation of the iPhone Duo (mobile app spec §6.1, decided 2026-11-21): a
// `UITabBarController` whose vertical system tab bar the OS places in the window's right strip,
// with the sections the web hands over `nav@1.set` (对话, 收件箱, 智能体, 定时任务), each with the
// shell's own icon (decision 14, amended) and the OS badge, and a menu button at the top of the
// strip above the bar. The profile WebViews' container (ProfileHost) moves into the selected
// tab's view, so one shared WebView stays loaded across tabs (spike 1.1). The host only draws and
// reports taps: the web owns routes and selection follows its `current`.

import UIKit

/// What the runtime hands native (`NavNativeState` in src/runtime/capabilities/nav.ts).
struct StripState: Equatable {
    struct Item: Equatable {
        let id: String
        let label: String
        let badge: String?
    }

    struct Menu: Equatable {
        let label: String
        let badge: String?
    }

    let items: [Item]
    let current: String?
    let menu: Menu?

    static let empty = StripState(items: [], current: nil, menu: nil)

    /// The runtime already validated the shape; anything off here is dropped whole.
    init?(json: [String: Any]) {
        guard let rawItems = json["items"] as? [[String: Any]] else { return nil }
        var items: [Item] = []
        for raw in rawItems {
            guard let id = raw["id"] as? String, StripHost.order.contains(id),
                  let label = raw["label"] as? String
            else { return nil }
            items.append(Item(id: id, label: label, badge: raw["badge"] as? String))
        }
        self.items = items
        current = json["current"] as? String
        if let menu = json["menu"] as? [String: Any] {
            guard let label = menu["label"] as? String else { return nil }
            self.menu = Menu(label: label, badge: menu["badge"] as? String)
        } else {
            self.menu = nil
        }
    }

    init(items: [Item], current: String?, menu: Menu?) {
        self.items = items
        self.current = current
        self.menu = menu
    }
}

/// One section's tab: an empty view the shared container moves into while it is selected.
final class StripTab: UIViewController {
    let sectionId: String

    init(sectionId: String) {
        self.sectionId = sectionId
        super.init(nibName: nil, bundle: nil)
        tabBarItem = UITabBarItem(title: nil, image: UIImage(systemName: StripHost.symbols[sectionId] ?? "circle"),
                                  tag: StripHost.order.firstIndex(of: sectionId) ?? 0)
        tabBarItem.accessibilityIdentifier = "strip-tab-\(sectionId)"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("StripTab is created in code") }

    override func loadView() {
        view = UIView()
        view.backgroundColor = .clear
    }
}

@MainActor
final class StripHost: UITabBarController, UITabBarControllerDelegate {
    /// NAV_SECTION_ORDER.
    nonisolated static let order = ["chats", "inbox", "agents", "schedules"]
    /// Decision 14 (amended 2026-11-21).
    nonisolated static let symbols = [
        "chats": "bubble.left.and.bubble.right",
        "inbox": "tray",
        "agents": "person.2",
        "schedules": "clock",
    ]
    nonisolated static let menuSymbol = "line.3.horizontal"

    /// A section was tapped, the selected one included.
    var onSelect: ((String) -> Void)?
    /// The menu button was tapped.
    var onMenu: (() -> Void)?

    private let sectionTabs: [String: StripTab] = Dictionary(uniqueKeysWithValues: StripHost.order.map { ($0, StripTab(sectionId: $0)) })
    let menuButton = UIButton(type: .system)
    private let menuBadge = UILabel()
    private(set) var state = StripState.empty
    /// The view that moves into the selected tab (ProfileHost's container).
    private weak var content: UIView?

    init() {
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("StripHost is created in code") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        delegate = self
        // Before the web's first `set` the strip shows nothing.
        setViewControllers([sectionTabs["chats"]!], animated: false)
        setBarHidden(true)

        var config: UIButton.Configuration
        if #available(iOS 26.0, *) { config = .glass() } else { config = .gray() }
        config.image = UIImage(systemName: StripHost.menuSymbol)
        config.cornerStyle = .capsule
        menuButton.configuration = config
        menuButton.accessibilityIdentifier = "strip-menu"
        menuButton.isHidden = true
        menuButton.addAction(UIAction { [weak self] _ in self?.onMenu?() }, for: .primaryActionTriggered)
        menuBadge.font = .systemFont(ofSize: 11, weight: .semibold)
        menuBadge.textColor = .white
        menuBadge.backgroundColor = .systemRed
        menuBadge.textAlignment = .center
        menuBadge.layer.cornerRadius = 9
        menuBadge.clipsToBounds = true
        menuBadge.isHidden = true
        menuBadge.isUserInteractionEnabled = false
        menuButton.addSubview(menuBadge)
        view.addSubview(menuButton)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutMenuButton()
        view.bringSubviewToFront(menuButton)
    }

    /// The menu button sits at the top of the strip, under the status bar and the sensor housing,
    /// above the tab bar's items.
    private func layoutMenuButton() {
        let bounds = view.bounds
        let stripWidth = view.window?.safeAreaInsets.right ?? 0
        guard stripWidth > 0 else { return }
        let side: CGFloat = 48
        var top = view.window?.windowScene?.statusBarManager?.statusBarFrame.maxY ?? 0
        let stripMinX = bounds.maxX - stripWidth
#if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            for region in view.reservedRegions(kind: .occlusion) where region.frame.minX >= stripMinX - 1 {
                top = max(top, region.frame.maxY)
            }
        }
#endif
        menuButton.frame = CGRect(x: stripMinX + (stripWidth - side) / 2, y: top + 8, width: side, height: side)
        let text = menuBadge.text ?? ""
        let width = max(18, CGFloat(text.count) * 7 + 8)
        menuBadge.frame = CGRect(x: side - width + 4, y: -4, width: width, height: 18)
    }

    /// Hosts the shared container in the selected tab.
    func host(_ view: UIView) {
        content = view
        attach()
    }

    /// Gives the container back (the window lost its strip).
    func release() {
        content?.removeFromSuperview()
        content = nil
    }

    private func attach() {
        guard let content, let target = selectedViewController?.view else { return }
        if content.superview === target { return }
        content.removeFromSuperview()
        content.frame = target.bounds
        content.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        target.addSubview(content)
    }

    /// Draws the web's sections and menu button. `current: nil` leaves the selection as it was.
    func apply(_ next: StripState) {
        loadViewIfNeeded()
        state = next
        let wanted = next.items.compactMap { item -> StripTab? in
            guard let tab = sectionTabs[item.id] else { return nil }
            tab.tabBarItem.title = item.label
            tab.tabBarItem.accessibilityLabel = item.label
            tab.tabBarItem.badgeValue = item.badge
            return tab
        }
        let previous = selectedViewController as? StripTab
        if !wanted.isEmpty, !(viewControllers ?? []).elementsEqual(wanted, by: { $0 === $1 }) {
            setViewControllers(wanted, animated: false)
        }
        if let current = next.current, let tab = sectionTabs[current], wanted.contains(where: { $0 === tab }) {
            selectedViewController = tab
        } else if let previous, wanted.contains(where: { $0 === previous }) {
            selectedViewController = previous
        }
        setBarHidden(wanted.isEmpty)
        attach()

        if let menu = next.menu {
            menuButton.isHidden = false
            menuButton.accessibilityLabel = menu.label
            menuBadge.text = menu.badge
            menuBadge.isHidden = menu.badge == nil
        } else {
            menuButton.isHidden = true
            menuBadge.isHidden = true
        }
        view.setNeedsLayout()
    }

    private func setBarHidden(_ hidden: Bool) {
        if #available(iOS 18.0, *) {
            if isTabBarHidden != hidden { setTabBarHidden(hidden, animated: false) }
        } else {
            tabBar.isHidden = hidden
        }
    }

    /// Every tap, the selected tab included: the web navigates (it owns routes).
    func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
        if let tab = viewController as? StripTab { onSelect?(tab.sectionId) }
        return true
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        attach()
    }
}
