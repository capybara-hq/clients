// The in-app browser sheet (mobile spec §4.4): another origin, a new window, anything that leaves a
// profile opens in SFSafariViewController over the app, never in a profile WebView (R14). It has
// its own cookie jar and process; http(s) only (the navigation policy never sends anything else).

import SafariServices
import UIKit

enum BrowserSheet {
    static func present(_ url: URL, from controller: UIViewController) {
        guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return }
        var top = controller
        while let presented = top.presentedViewController { top = presented }
        let sheet = SFSafariViewController(url: url)
        sheet.dismissButtonStyle = .done
        sheet.modalPresentationStyle = .pageSheet
        #if DEBUG
        if let observer = Observer.current {
            top.present(sheet, animated: true) { observer.presented(sheet, url) }
            return
        }
        #endif
        top.present(sheet, animated: true)
    }

    #if DEBUG
    /// Debug builds, the loader UI tests only (LoaderTestLog): reports each sheet once UIKit has
    /// presented it, then closes it and reports that. The sheet's bar and Done button are drawn by
    /// the Safari view service, another process that a fresh simulator starts cold, so the tests
    /// neither wait on that bar nor tap it.
    final class Observer {
        static var current: Observer?

        private let log: ([String: Any]) -> Void

        init(log: @escaping ([String: Any]) -> Void) {
            self.log = log
        }

        fileprivate func presented(_ sheet: SFSafariViewController, _ url: URL) {
            log(["event": "sheetPresented", "url": url.absoluteString])
            let closed = { self.log(["event": "sheetClosed", "url": url.absoluteString]) }
            // The sheet may already have closed itself (its view service failed to start).
            guard sheet.presentingViewController != nil else { return closed() }
            sheet.dismiss(animated: true, completion: closed)
        }
    }
    #endif
}
