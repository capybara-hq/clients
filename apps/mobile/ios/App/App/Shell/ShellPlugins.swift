// The app's own Capacitor plugins, registered on the bridge of the app's local pages. Later tasks
// add one line each.

import Capacitor
import UIKit

enum ShellPlugins {
    static func make() -> [CAPPlugin] {
        [
            ShellPlugin(),
        ]
    }
}

/// Capacitor's view controller with the shell's plugins registered.
final class ShellBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        for plugin in ShellPlugins.make() {
            bridge?.registerPluginInstance(plugin)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        #if DEBUG
        HostileHarness.startIfRequested(in: self)
        #endif
    }
}
