// The native menu of `menu@1` (src/runtime/capabilities/menu.ts): an action sheet on iPhone, a
// popover on iPad anchored at the page's `anchor` rect (CSS px from the profile WebView's top-left,
// which are points). It lives on Capacitor's bridge (the local runtime calls it); profile WebViews
// never reach it. The runtime validated the input; the model re-checks the same limits and
// refuses anything else (defense in depth), and a disabled item is never an answer.

import Capacitor
import UIKit

struct MenuItem: Equatable {
    let id: String
    let label: String
    let destructive: Bool
    let disabled: Bool
}

struct MenuAnchor: Equatable {
    let x: Double, y: Double, width: Double, height: Double
}

struct MenuModel: Equatable {
    static let maxItems = 12
    static let maxLabel = 64
    static let maxTitle = 128

    let title: String?
    let items: [MenuItem]
    let anchor: MenuAnchor?

    /// nil when the input breaks any limit of `menu@1`.
    static func parse(_ input: [String: Any]) -> MenuModel? {
        guard Set(input.keys).isSubset(of: ["title", "items", "anchor", "cancelLabel"]),
              let raw = input["items"] as? [[String: Any]],
              (1...maxItems).contains(raw.count)
        else { return nil }
        var items: [MenuItem] = []
        for entry in raw {
            guard Set(entry.keys).isSubset(of: ["id", "label", "destructive", "disabled"]),
                  let id = entry["id"] as? String, validId(id),
                  let label = entry["label"] as? String,
                  (1...maxLabel).contains(label.count)
            else { return nil }
            guard let destructive = flag(entry["destructive"]),
                  let disabled = flag(entry["disabled"])
            else { return nil }
            items.append(MenuItem(id: id, label: label, destructive: destructive, disabled: disabled))
        }
        guard Set(items.map(\.id)).count == items.count else { return nil }
        var title: String?
        if let value = input["title"] {
            guard let s = value as? String, s.count <= maxTitle else { return nil }
            title = s
        }
        var anchor: MenuAnchor?
        if let value = input["anchor"] {
            guard let a = value as? [String: Any],
                  Set(a.keys).isSubset(of: ["x", "y", "width", "height"]),
                  let x = number(a["x"]), let y = number(a["y"]),
                  let w = number(a["width"]), let h = number(a["height"])
            else { return nil }
            anchor = MenuAnchor(x: x, y: y, width: w, height: h)
        }
        return MenuModel(title: title, items: items, anchor: anchor)
    }

    /// Only an enabled item of this menu can be the answer.
    func answer(for id: String?) -> String? {
        guard let id, let item = items.first(where: { $0.id == id }), !item.disabled else { return nil }
        return id
    }

    private static func validId(_ id: String) -> Bool {
        (1...64).contains(id.utf8.count)
            && id.utf8.allSatisfy { c in
                (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)
                    || c == 0x5F || c == 0x2E || c == 0x2D
            }
    }

    /// Absent is false; present must be a real boolean (not a number).
    private static func flag(_ v: Any?) -> Bool? {
        guard let v else { return false }
        guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }

    private static func number(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }
}

/// Presents one menu at a time and answers exactly once: an item id, or nil when dismissed.
@MainActor
final class MenuHost {
    private var presented: UIAlertController?
    private var completion: ((String?) -> Void)?

    var isShowing: Bool { completion != nil }

    /// - Parameters:
    ///   - anchorView: the view the anchor rect is relative to (the profile WebView); the popover's
    ///     source on iPad. Without one, or without an anchor, the popover centers on `presenter`'s view.
    func show(_ model: MenuModel, cancelLabel: String, from presenter: UIViewController,
              anchorView: UIView?, completion: @escaping (String?) -> Void) {
        // One menu at a time, and never on top of a controller that is mid-presentation: present
        // would fail silently and the call would never settle.
        guard self.completion == nil, presenter.presentedViewController == nil,
              !presenter.isBeingPresented, !presenter.isBeingDismissed
        else {
            completion(nil)
            return
        }
        let sheet = UIAlertController(title: model.title, message: nil, preferredStyle: .actionSheet)
        for item in model.items {
            let action = UIAlertAction(title: item.label, style: item.destructive ? .destructive : .default) {
                [weak self] _ in self?.finish(model.answer(for: item.id))
            }
            action.isEnabled = !item.disabled
            sheet.addAction(action)
        }
        // iPad hides the cancel row (a tap outside dismisses); iPhone needs it.
        sheet.addAction(UIAlertAction(title: cancelLabel, style: .cancel) { [weak self] _ in
            self?.finish(nil)
        })
        if let popover = sheet.popoverPresentationController {
            let source = anchorView ?? presenter.view!
            popover.sourceView = source
            if let a = model.anchor, anchorView != nil {
                popover.sourceRect = MenuHost.clamp(a, to: source.bounds)
            } else {
                popover.sourceRect = CGRect(x: source.bounds.midX, y: source.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            popover.delegate = PopoverDismissal.shared
        }
        self.completion = completion
        presented = sheet
        PopoverDismissal.shared.onDismiss = { [weak self] in self?.finish(nil) }
        presenter.present(sheet, animated: true)
    }

    /// The anchor rect limited to `bounds`: a page-supplied rect never points outside the view.
    static func clamp(_ a: MenuAnchor, to bounds: CGRect) -> CGRect {
        let x = min(max(a.x, bounds.minX), bounds.maxX)
        let y = min(max(a.y, bounds.minY), bounds.maxY)
        let w = min(max(a.width, 0), bounds.maxX - x)
        let h = min(max(a.height, 0), bounds.maxY - y)
        return CGRect(x: x, y: y, width: w, height: h)
    }

    /// Dismisses what is showing and answers nil (the document ended, the app went away).
    func cancel() {
        guard completion != nil else { return }
        presented?.dismiss(animated: false)
        finish(nil)
    }

    private func finish(_ id: String?) {
        guard let done = completion else { return }
        completion = nil
        presented = nil
        done(id)
    }
}

/// A tap outside an iPad popover dismisses it without running any action.
private final class PopoverDismissal: NSObject, UIPopoverPresentationControllerDelegate {
    static let shared = PopoverDismissal()
    var onDismiss: (() -> Void)?

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        onDismiss?()
    }
}

/// The Capacitor plugin `MenuHost`: `show(options)` → `{ id }`.
@objc(MenuHostPlugin)
public class MenuHostPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MenuHostPlugin"
    public let jsName = "MenuHost"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    /// Created on first use, on the main actor.
    private var host: MenuHost?

    @objc func show(_ call: CAPPluginCall) {
        let input = call.options as? [String: Any] ?? [:]
        guard let model = MenuModel.parse(input) else {
            call.reject("invalid menu")
            return
        }
        let cancel = (input["cancelLabel"] as? String) ?? "Cancel"
        DispatchQueue.main.async {
            guard let presenter = Self.topViewController() else {
                call.reject("no window")
                return
            }
            let host = self.host ?? MenuHost()
            self.host = host
            host.show(model, cancelLabel: cancel, from: presenter,
                           anchorView: Self.profileWebView(in: presenter.view.window)) { id in
                call.resolve(["id": id as Any? ?? NSNull()])
            }
        }
    }

    /// Dismisses the menu that is showing, which answers null (the document ended).
    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.host?.cancel()
            call.resolve()
        }
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow)
        var top = window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    /// The visible profile WebView, whose top-left the anchor rect is relative to.
    private static func profileWebView(in window: UIWindow?) -> UIView? {
        func find(_ view: UIView) -> UIView? {
            if view is ProfileWebView, !view.isHidden, view.window != nil { return view }
            for sub in view.subviews { if let hit = find(sub) { return hit } }
            return nil
        }
        return window.flatMap(find)
    }
}
