// Debug simulator builds only, for the strip UI tests (AppUITests/StripTests): opens / closes the
// simulated iPhone Duo by asking SpringBoard for a display swap through the private
// SBSDisplayToolService (spike 1.1). The simulator has no public hinge control. The UI test asks
// for a swap with a Darwin notification; the app listens only when launched by a loader UI test
// (LoaderTestLog), and the Debug simulator build carries DebugSimulator.entitlements for it.
// Device and Release builds contain none of this.

#if DEBUG && targetEnvironment(simulator)
import Foundation

enum DuoSwap {
    static let requestName = "com.capybarahq.shell.test.duo-swap"

    // BOOL SBFDisplayToolSwapSettingsFromArguments(NSArray *, SBFDisplayToolSwapSettings *out, NSError **)
    private typealias FromArguments = @convention(c) (
        NSArray, UnsafeMutableRawPointer, UnsafeMutablePointer<NSError?>?
    ) -> Bool
    // -swapDisplayWithSettings:(struct)s completionHandler:(id)block; on arm64 a struct over 16
    // bytes is passed as a pointer to a caller-owned copy.
    private typealias SwapSend = @convention(c) (AnyObject, Selector, UnsafeRawPointer, AnyObject) -> Void

    private static var retained: [NSObject] = []
    private static var listening = false

    /// Swaps on every request the UI test posts.
    static func listen() {
        guard !listening else { return }
        listening = true
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), nil,
            { _, _, _, _, _ in DispatchQueue.main.async { DuoSwap.swap() } },
            requestName as CFString, nil, .deliverImmediately)
    }

    static func swap() {
        dlopen("/System/Library/PrivateFrameworks/SpringBoardServices.framework/SpringBoardServices", RTLD_NOW)
        dlopen("/System/Library/PrivateFrameworks/SpringBoardFoundation.framework/SpringBoardFoundation", RTLD_NOW)
        let any = UnsafeMutableRawPointer(bitPattern: -2)
        guard let sym = dlsym(any, "SBFDisplayToolSwapSettingsFromArguments"),
              let send = dlsym(any, "objc_msgSend"),
              let serviceClass = NSClassFromString("SBSDisplayToolService") as? NSObject.Type
        else { return log("swap unavailable") }
        let settings = UnsafeMutableRawPointer.allocate(byteCount: 256, alignment: 16)
        settings.initializeMemory(as: UInt8.self, repeating: 0, count: 256)
        var error: NSError?
        guard unsafeBitCast(sym, to: FromArguments.self)([] as NSArray, settings, &error) else {
            return log("swap settings rejected")
        }
        let service = serviceClass.init()
        retained.append(service)
        let selector = NSSelectorFromString("swapDisplayWithSettings:completionHandler:")
        guard service.responds(to: selector) else { return log("swap selector missing") }
        let completion: @convention(block) (AnyObject?) -> Void = { result in
            log(result == nil ? "swapped" : "swap refused: \(String(describing: result))")
        }
        unsafeBitCast(send, to: SwapSend.self)(service, selector, UnsafeRawPointer(settings),
                                               unsafeBitCast(completion, to: AnyObject.self))
    }

    private static func log(_ result: String) {
        LoaderTestLog.current?.log(["event": "duoSwap", "result": result])
    }
}
#endif
