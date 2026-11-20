// The profile WebViews of the app (mobile spec §4.4): one per profile, created on first open in the
// profile's own data store, shown in a container over Capacitor's WebView (which shows the local
// pages: the runtime and the error state) and below the launch splash. The runtime drives it through ShellPlugin: open, showError (hide
// the WebView so the local error page shows), setAppearance (the background behind the WebView
// and the status bar style).

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
    }

    /// Capacitor's controller view is its WKWebView itself (`loadView` is final), and the splash
    /// plugin adds its view on top of it. The container goes right above that WebView's own scroll
    /// view: over the local pages, under the splash.
    private func attachContainer() {
        guard container.superview == nil, let root = controller?.view else { return }
        container.frame = root.bounds
        if let scroll = (root as? WKWebView)?.scrollView, scroll.superview === root {
            root.insertSubview(container, aboveSubview: scroll)
        } else {
            root.addSubview(container)
        }
    }

    /// Shows the profile's WebView and loads its base once its sign-in block rules are in force;
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
        container.isHidden = false
        view.installBlockRules(spec.blockRules) { [weak self, weak view] error in
            if let error { return done(OpenError.noBlockRules(error)) }
            guard let self, let view, self.shown == spec.profileId else { return done(nil) }
            view.loadBase()
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
        if shown == profileId { container.isHidden = true }
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
            container.isHidden = true
        }
        DataStores.shared.webViewReleased()
    }

    /// The profile's live WebView, if any (tests).
    func view(for profileId: String) -> ProfileWebView? { views[profileId] }

    func setAppearance(_ profileId: String, background: UIColor, lightContent: Bool) {
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
