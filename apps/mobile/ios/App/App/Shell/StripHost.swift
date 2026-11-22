// The strip navigation of the iPhone Duo (mobile app spec §6.1; interaction model §10, minor
// version of 2026-11-22): a `UITabBarController` whose vertical system tab bar the OS floats as a
// pill in the window's strip, and the account avatar under the status above it. The pill holds,
// top to bottom, the web's action (`nav@1.set`'s `action`: the page's primary, else 新会话) drawn
// accent-filled with the shell's own glyph, then the sections (对话, 收件箱, 智能体, 定时任务) and
// 搜索, each with the shell's own icon and the OS badge. No menu button (D12). The profile
// WebViews' container (ProfileHost) moves into the selected tab's view, so one shared WebView
// stays loaded across tabs (spike 1.1). The host only draws and reports taps: the web owns routes,
// and the highlight follows its `current` (null: no section, the action's tab holds the content).
// The strip is on the right, or on the left for the left app of an inner-display split; the OS
// moves the pill, the host moves the avatar.

import UIKit

/// What the runtime hands native (`NavNativeState` in src/runtime/capabilities/nav.ts).
struct StripState: Equatable {
    struct Item: Equatable {
        let id: String
        let label: String
        let badge: String?
    }

    struct Action: Equatable {
        let id: String
        let label: String
        /// `plus` or `square-pen`.
        let icon: String
    }

    struct Account: Equatable {
        let name: String
        let avatarUrl: URL?
        let initial: String
        let badge: String?
    }

    let items: [Item]
    /// Null: no section is highlighted.
    let current: String?
    /// Nil only before the page's first `set`: the strip then shows nothing.
    let action: Action?
    let account: Account?

    static let empty = StripState(items: [], current: nil, action: nil, account: nil)

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
        let current = json["current"] as? String
        if let current, current == "search" || !items.contains(where: { $0.id == current }) { return nil }
        self.current = current
        if let raw = json["action"] as? [String: Any] {
            guard let id = raw["id"] as? String, let label = raw["label"] as? String,
                  let icon = raw["icon"] as? String, StripHost.actionSymbols[icon] != nil
            else { return nil }
            action = Action(id: id, label: label, icon: icon)
        } else if json["action"] == nil || json["action"] is NSNull {
            action = nil
        } else {
            return nil
        }
        if let raw = json["account"] as? [String: Any] {
            guard let name = raw["name"] as? String, let initial = raw["initial"] as? String else { return nil }
            var url: URL?
            if let text = raw["avatarUrl"] as? String {
                guard let parsed = URL(string: text), ["https", "http"].contains(parsed.scheme?.lowercased() ?? "")
                else { return nil }
                url = parsed
            }
            account = Account(name: name, avatarUrl: url, initial: initial, badge: raw["badge"] as? String)
        } else {
            account = nil
        }
    }

    init(items: [Item], current: String?, action: Action?, account: Account?) {
        self.items = items
        self.current = current
        self.action = action
        self.account = account
    }
}

/// One tab: an empty view the shared container moves into while it is selected. A section, search
/// (never selected) or the action (selected only while no section is current).
final class StripTab: UIViewController {
    let itemId: String

    init(itemId: String) {
        self.itemId = itemId
        super.init(nibName: nil, bundle: nil)
        let symbol = StripHost.symbols[itemId] ?? "circle"
        tabBarItem = UITabBarItem(title: nil, image: UIImage(systemName: symbol),
                                  tag: StripHost.order.firstIndex(of: itemId).map { $0 + 1 } ?? 0)
        tabBarItem.accessibilityIdentifier = "strip-tab-\(itemId)"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("StripTab is created in code") }

    override func loadView() {
        view = UIView()
        view.backgroundColor = .clear
    }
}

/// The account avatar under the status: the image when it loads, else the initial, in a circle,
/// with the OS badge.
final class StripAccountButton: UIControl {
    static let size: CGFloat = 40
    let imageView = UIImageView()
    let initialLabel = UILabel()
    let badgeLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityIdentifier = "strip-account"
        backgroundColor = .secondarySystemFill
        layer.cornerRadius = Self.size / 2
        initialLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        initialLabel.textAlignment = .center
        initialLabel.textColor = .label
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.layer.cornerRadius = Self.size / 2
        imageView.isHidden = true
        badgeLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        badgeLabel.textColor = .white
        badgeLabel.backgroundColor = .systemRed
        badgeLabel.textAlignment = .center
        badgeLabel.layer.cornerRadius = 9
        badgeLabel.clipsToBounds = true
        badgeLabel.isHidden = true
        for sub in [initialLabel, imageView, badgeLabel] as [UIView] {
            sub.isUserInteractionEnabled = false
            addSubview(sub)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("StripAccountButton is created in code") }

    override func layoutSubviews() {
        super.layoutSubviews()
        initialLabel.frame = bounds
        imageView.frame = bounds
        let text = badgeLabel.text ?? ""
        let width = max(18, CGFloat(text.count) * 7 + 8)
        badgeLabel.frame = CGRect(x: bounds.width - width + 4, y: -4, width: width, height: 18)
    }

    /// VoiceOver's activation taps the avatar.
    override func accessibilityActivate() -> Bool {
        sendActions(for: .touchUpInside)
        return true
    }

    /// The image is shown (the avatar loaded); nil shows the initial.
    var image: UIImage? {
        get { imageView.image }
        set {
            imageView.image = newValue
            imageView.isHidden = newValue == nil
            initialLabel.isHidden = newValue != nil
        }
    }
}

@MainActor
final class StripHost: UITabBarController, UITabBarControllerDelegate {
    /// NAV_ITEM_ORDER: the sections, then search.
    nonisolated static let order = ["chats", "inbox", "agents", "schedules", "search"]
    /// Decision 14 (amended 2026-11-21), and search.
    nonisolated static let symbols = [
        "chats": "bubble.left.and.bubble.right",
        "inbox": "tray",
        "agents": "person.2",
        "schedules": "clock",
        "search": "magnifyingglass",
    ]
    /// The action's glyph per `icon`.
    nonisolated static let actionSymbols = ["plus": "plus", "square-pen": "square.and.pencil"]
    nonisolated static let actionTabId = "action"

    /// An item was tapped, the selected section and search included.
    var onSelect: ((String) -> Void)?
    /// The pill's top item (the action) was tapped.
    var onAction: (() -> Void)?
    /// The account avatar was tapped.
    var onAccount: (() -> Void)?
    /// Loads the avatar image (ProfileHost: with the shown profile's cookies on its own origin).
    var loadAvatar: ((URL, @escaping (UIImage?) -> Void) -> Void)?

    private let sectionTabs: [String: StripTab] =
        Dictionary(uniqueKeysWithValues: StripHost.order.map { ($0, StripTab(itemId: $0)) })
    let actionTab = StripTab(itemId: StripHost.actionTabId)
    let accountButton = StripAccountButton()
    private(set) var state = StripState.empty
    /// The strip's edge; the avatar follows it (the OS moves the pill).
    var side: StripSide = .right {
        didSet { if side != oldValue { view.setNeedsLayout() } }
    }
    /// The page's accent and the ink on it (chrome@1 tokens); nil: the shell's tint.
    private var accent: (fill: UIColor, ink: UIColor)?
    /// The avatar URL whose image is shown or loading.
    private var avatarShown: URL?
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
        setViewControllers([actionTab], animated: false)
        setBarHidden(true)
        accountButton.isHidden = true
        // A plain UIControl sends no primaryActionTriggered on a tap (UIButton does): touch up inside.
        accountButton.addAction(UIAction { [weak self] _ in self?.onAccount?() }, for: .touchUpInside)
        view.addSubview(accountButton)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (host: StripHost, _: UITraitCollection) in
            host.drawAction()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutAccount()
        view.bringSubviewToFront(accountButton)
    }

    /// The avatar sits at the top of the strip, under the status bar and the sensor housing, above
    /// the pill, on the strip's edge.
    private func layoutAccount() {
        let bounds = view.bounds
        let insets = view.window?.safeAreaInsets ?? .zero
        let stripWidth = side == .left ? insets.left : insets.right
        guard stripWidth > 0 else { return }
        var top = view.window?.windowScene?.statusBarManager?.statusBarFrame.maxY ?? 0
        let stripMinX = side == .left ? bounds.minX : bounds.maxX - stripWidth
#if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            let stripMaxX = stripMinX + stripWidth
            for region in view.reservedRegions(kind: .occlusion)
            where region.frame.minX >= stripMinX - 1 && region.frame.maxX <= stripMaxX + 1
                && region.frame.height < bounds.height / 2 {
                top = max(top, region.frame.maxY)
            }
        }
#endif
        accountButton.frame = StripHost.accountFrame(bounds: bounds, stripWidth: stripWidth, side: side, top: top)
    }

    /// The avatar's frame: centered in the strip on `side`, 8 points under `top`.
    nonisolated static func accountFrame(bounds: CGRect, stripWidth: CGFloat, side: StripSide, top: CGFloat) -> CGRect {
        let size = StripAccountButton.size
        let stripMinX = side == .left ? bounds.minX : bounds.maxX - stripWidth
        return CGRect(x: stripMinX + (stripWidth - size) / 2, y: top + 8, width: size, height: size)
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

    /// The page's accent for the action's fill (chrome@1 tokens), or nil for the shell's tint.
    func setAccent(_ fill: UIColor?, ink: UIColor?) {
        if let fill, let ink { accent = (fill, ink) } else { accent = nil }
        drawAction()
    }

    /// The action's image: an accent-filled circle with the shell's glyph, drawn as is (never
    /// tinted by the bar), so it reads as the pill's primary item whether selected or not.
    static func actionImage(symbol: String, fill: UIColor, ink: UIColor, traits: UITraitCollection) -> UIImage {
        let side: CGFloat = 30
        let config = UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
        let glyph = UIImage(systemName: symbol, withConfiguration: config)?
            .withTintColor(ink.resolvedColor(with: traits), renderingMode: .alwaysOriginal)
        let image = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            fill.resolvedColor(with: traits).setFill()
            UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: side, height: side)).fill()
            if let glyph {
                let size = glyph.size
                glyph.draw(in: CGRect(x: (side - size.width) / 2, y: (side - size.height) / 2,
                                      width: size.width, height: size.height))
            }
        }
        return image.withRenderingMode(.alwaysOriginal)
    }

    /// The fill the action is drawn with now (the page's accent, else the shell's tint).
    var actionFill: UIColor { accent?.fill ?? view.tintColor ?? .systemBlue }

    private func drawAction() {
        guard let action = state.action, let symbol = StripHost.actionSymbols[action.icon] else { return }
        let image = StripHost.actionImage(symbol: symbol, fill: actionFill, ink: accent?.ink ?? .white,
                                          traits: traitCollection)
        actionTab.tabBarItem.image = image
        actionTab.tabBarItem.selectedImage = image
    }

    /// Draws the web's pill and avatar. `current: nil` highlights no section.
    func apply(_ next: StripState) {
        loadViewIfNeeded()
        state = next
        var wanted: [StripTab] = []
        if let action = next.action {
            actionTab.tabBarItem.title = action.label
            actionTab.tabBarItem.accessibilityLabel = action.label
            actionTab.tabBarItem.accessibilityIdentifier = "strip-action"
            drawAction()
            wanted.append(actionTab)
            for item in next.items {
                guard let tab = sectionTabs[item.id] else { continue }
                tab.tabBarItem.title = item.label
                tab.tabBarItem.accessibilityLabel = item.label
                tab.tabBarItem.badgeValue = item.badge
                wanted.append(tab)
            }
        }
        if !wanted.isEmpty, !(viewControllers ?? []).elementsEqual(wanted, by: { $0 === $1 }) {
            setViewControllers(wanted, animated: false)
        }
        if let current = next.current, let tab = sectionTabs[current], wanted.contains(where: { $0 === tab }) {
            selectedViewController = tab
        } else if !wanted.isEmpty {
            // No section current: none is highlighted, the action's tab holds the content.
            selectedViewController = actionTab
        }
        setBarHidden(wanted.isEmpty)
        attach()
        applyAccount(next.action == nil ? nil : next.account)
        view.setNeedsLayout()
    }

    /// The section highlighted now, nil when none (the action's tab is selected).
    var highlighted: String? {
        guard let tab = selectedViewController as? StripTab, tab !== actionTab else { return nil }
        return tab.itemId
    }

    private func applyAccount(_ account: StripState.Account?) {
        guard let account else {
            accountButton.isHidden = true
            accountButton.image = nil
            avatarShown = nil
            return
        }
        accountButton.isHidden = false
        accountButton.accessibilityLabel = account.name
        accountButton.initialLabel.text = account.initial
        accountButton.badgeLabel.text = account.badge
        accountButton.badgeLabel.isHidden = account.badge == nil
        accountButton.accessibilityValue = account.badge
        guard account.avatarUrl != avatarShown else { return }
        avatarShown = account.avatarUrl
        accountButton.image = nil
        guard let url = account.avatarUrl, let loadAvatar else { return }
        loadAvatar(url) { [weak self] image in
            DispatchQueue.main.async {
                guard let self, self.avatarShown == url else { return }
                self.accountButton.image = image
            }
        }
    }

    private func setBarHidden(_ hidden: Bool) {
        if #available(iOS 18.0, *) {
            if isTabBarHidden != hidden { setTabBarHidden(hidden, animated: false) }
        } else {
            tabBar.isHidden = hidden
        }
    }

    /// Every tap, the selected tab included: the web navigates (it owns routes). The action and
    /// search never take the selection from a tap: the web decides what follows.
    func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
        guard let tab = viewController as? StripTab else { return false }
        if tab === actionTab {
            onAction?()
            return false
        }
        onSelect?(tab.itemId)
        return tab.itemId != "search"
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        attach()
    }
}
