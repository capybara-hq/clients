// The profile WebViews of the app (mobile spec §4.4): one per profile, created on first open in the
// profile's own data store, shown in a container over Capacitor's WebView (which shows the local
// pages: the runtime and the error state) and below the launch splash. The runtime drives it through ShellPlugin: open, showError (hide
// the WebView so the local error page shows), setAppearance (the background behind the WebView
// and the status bar style).
//
// While the window has a strip (StripDetector, the iPhone Duo) the container sits in StripHost's
// selected tab, under the pill the OS floats in the strip; else in the plain place above
// Capacitor's WebView. It moves between them on each change, the WebViews inside untouched; a
// split side change (the strip moving to the other edge) only moves the avatar.

import Capacitor
import UIKit
import WebKit

@MainActor
final class ProfileHost {
    struct Spec {
        let profileId: String
        let origin: String
        let base: String
        let dataStoreId: String
        let state: [String: Any]
        /// The sign-in block rules (`blockRulesFor(base)`), compiled before the first load.
        let blockRules: String
        /// A tapped push's in-app path, loaded on the origin instead of the base (also when the
        /// WebView already exists); nil for the base.
        var path: String? = nil
    }

    enum OpenError: Error {
        case noStore, noScript, notCreated(Error), noBlockRules(Error)
    }

    weak var controller: CAPBridgeViewController?
    weak var sink: ShellCallSink?
    weak var monitor: ShellGateMonitor?
    /// Where a navigation that leaves a profile goes.
    var sheet: (URL) -> Void

    private var views: [String: ProfileWebView] = [:]
    private var shown: String?
    private var background: UIColor?
    private let container = UIView()
    /// The container should show (a profile is open and not on its error state).
    private var containerShown = false
    private let probe = StripProbe()
    private var stripHost: StripHost?
    /// The window gained or lost its strip, or the strip moved to the other edge.
    var onStrip: ((Bool, StripSide) -> Void)?
    /// A pill item was tapped (the selected section and search too) / the pill's top item (the
    /// action) / the account avatar.
    var onSection: ((String) -> Void)?
    var onAction: (() -> Void)?
    var onAccount: (() -> Void)?
    /// The page's accent for the strip's action (chrome@1 tokens).
    private var accent: (UIColor, UIColor)?

    /// `controller` nil (tests): the container is never attached to a window.
    init(controller: CAPBridgeViewController?) {
        self.controller = controller
        sheet = { _ in }
        sheet = { [weak self] url in
            guard let controller = self?.controller else { return }
            BrowserSheet.present(url, from: controller)
        }
        container.isHidden = true
        container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        probe.onChange = { [weak self] visible, side in
            guard let self else { return }
            self.stripHost?.side = side
            self.placeContainer()
            self.onStrip?(visible, side)
        }
    }

    /// Starts watching the window for a strip (before the first open: the first state needs it).
    func start() {
        guard probe.superview == nil, let root = controller?.view else { return }
        probe.frame = root.bounds
        root.insertSubview(probe, at: 0)
        probe.evaluate()
    }

    /// Whether the window has a strip now, and its edge.
    var stripNow: (visible: Bool, side: StripSide) {
        probe.evaluate()
        return (probe.visible, probe.side)
    }

    /// The web's pill and avatar for the strip (`nav@1.set`, already validated by the runtime).
    func setStrip(_ state: StripState) {
        strip().apply(state)
    }

    /// The strip's host, made on first use (a test reads it too).
    func strip() -> StripHost {
        if let stripHost { return stripHost }
        let made = StripHost()
        made.side = probe.side
        made.onSelect = { [weak self] id in self?.onSection?(id) }
        made.onAction = { [weak self] in self?.onAction?() }
        made.onAccount = { [weak self] in self?.onAccount?() }
        made.loadAvatar = { [weak self] url, done in self?.loadAvatar(url, done: done) ?? done(nil) }
        if let accent { made.setAccent(accent.0, ink: accent.1) }
        stripHost = made
        return made
    }

    /// The avatar of the shown profile's page: with its cookies only on its own origin.
    private func loadAvatar(_ url: URL, done: @escaping (UIImage?) -> Void) {
        guard let shown, let view = views[shown] else { return done(nil) }
        StripAvatar.load(url, profileOrigin: view.profileOrigin.serialized,
                         cookies: view.configuration.websiteDataStore.httpCookieStore, done: done)
    }

    /// Over the local pages, under the splash: right above Capacitor's own scroll view.
    private func insert(_ view: UIView, in root: UIView) {
        view.frame = root.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        if let scroll = (root as? WKWebView)?.scrollView, scroll.superview === root {
            root.insertSubview(view, aboveSubview: scroll)
        } else {
            root.addSubview(view)
        }
    }

    /// Puts the container where it belongs now: in StripHost while the window has a strip, else in
    /// its plain place. Nothing moves before the first open.
    private func placeContainer() {
        guard let controller, let root = controller.view, container.superview != nil || stripHost?.parent != nil
        else { return }
        if probe.visible {
            let host = strip()
            if host.parent == nil {
                controller.addChild(host)
                insert(host.view, in: root)
                host.didMove(toParent: controller)
            }
            host.host(container)
        } else if let host = stripHost, host.parent != nil {
            host.release()
            host.willMove(toParent: nil)
            host.view.removeFromSuperview()
            host.removeFromParent()
            insert(container, in: root)
        }
        applyShown()
    }

    private func applyShown() {
        container.isHidden = !containerShown
        if let host = stripHost, host.parent != nil { host.view.isHidden = !containerShown }
    }

    /// Capacitor's controller view is its WKWebView itself (`loadView` is final), and the splash
    /// plugin adds its view on top of it. The container goes right above that WebView's own scroll
    /// view: over the local pages, under the splash.
    private func attachContainer() {
        guard container.superview == nil, let root = controller?.view else { return }
        start()
        insert(container, in: root)
        placeContainer()
    }

    /// Shows the profile's WebView and loads its base (or the spec's push path) once its sign-in block rules are in force;
    /// when they cannot be compiled nothing loads (fail closed) and `done` gets the error.
    func open(_ spec: Spec, done: @escaping (Error?) -> Void) {
        attachContainer()
        let view: ProfileWebView
        do {
            view = try views[spec.profileId] ?? make(spec)
        } catch {
            return done(error)
        }
        shown = spec.profileId
        for (id, v) in views { v.isHidden = id != spec.profileId }
        containerShown = true
        applyShown()
        view.installBlockRules(spec.blockRules) { [weak self, weak view] error in
            if let error { return done(OpenError.noBlockRules(error)) }
            guard let self, let view, self.shown == spec.profileId else { return done(nil) }
            view.loadEntry(path: spec.path)
            done(nil)
        }
    }

    /// The profile's WebView, if it was made (sign-in runs its exchange there).
    func view(for profileId: String) -> ProfileWebView? { views[profileId] }

    /// Hides the profile's WebView: the local error page underneath shows instead of its page.
    func showError(_ profileId: String) {
        guard let view = views[profileId] else { return }
        view.stopLoading()
        view.isHidden = true
        if shown == profileId {
            containerShown = false
            applyShown()
        }
    }

    /// Tears the profile's WebView down: a profile hidden by a managed lock or removed. The view
    /// leaves the container and the host's map; with no other owner it is released, so its data
    /// store is no longer in use and a scheduled deletion can run. A later `open` makes a new one.
    func close(_ profileId: String) {
        guard let view = views.removeValue(forKey: profileId) else { return }
        view.close()
        view.removeFromSuperview()
        if shown == profileId {
            shown = nil
            containerShown = false
            applyShown()
        }
        DataStores.shared.webViewReleased()
    }

    func setAppearance(_ profileId: String, background: UIColor, lightContent: Bool,
                       accent fill: UIColor? = nil, onAccent ink: UIColor? = nil) {
        if let fill, let ink { accent = (fill, ink) } else { accent = nil }
        stripHost?.setAccent(fill, ink: ink)
        self.background = background
        container.backgroundColor = background
        views[profileId]?.setBackground(background)
        controller?.view.backgroundColor = background
        controller?.setStatusBarStyle(lightContent ? .lightContent : .darkContent)
    }

    private func make(_ spec: Spec) throws -> ProfileWebView {
        guard let store = DataStores.shared.store(for: spec.dataStoreId) else { throw OpenError.noStore }
        guard let script = ShellScript.bundled() else { throw OpenError.noScript }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let view: ProfileWebView
        do {
            view = try ProfileWebView.make(profileId: spec.profileId, profileOrigin: spec.origin, dataStore: store,
                                           shellVersion: version, state: spec.state, script: script, base: spec.base)
        } catch {
            throw OpenError.notCreated(error)
        }
        view.sink = sink
        view.monitor = monitor
        view.onSheet = { [weak self] url in self?.sheet(url) }
        if let background { view.setBackground(background) }
        #if DEBUG
        view.isInspectable = true
        #endif
        view.frame = container.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(view)
        views[spec.profileId] = view
        return view
    }
}
