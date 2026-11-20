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
        top.present(sheet, animated: true)
    }
}
