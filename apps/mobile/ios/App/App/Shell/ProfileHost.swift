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
    }

    enum OpenError: Error {
        case noStore, noScript, notCreated(Error)
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

    init(controller: CAPBridgeViewController) {
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

    func open(_ spec: Spec) throws {
        attachContainer()
        let view = try views[spec.profileId] ?? make(spec)
        shown = spec.profileId
        for (id, v) in views { v.isHidden = id != spec.profileId }
        container.isHidden = false
        view.loadBase()
    }

    /// Hides the profile's WebView: the local error page underneath shows instead of its page.
    func showError(_ profileId: String) {
        guard let view = views[profileId] else { return }
        view.stopLoading()
        view.isHidden = true
        if shown == profileId { container.isHidden = true }
    }

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
