// Sign-in in the browser on iOS (mobile spec §4.3): `ASWebAuthenticationSession`, the Safari
// sheet over the app that shares Safari's cookies, passwords and SSO sessions
// (`prefersEphemeralWebBrowserSession = false`). It opens the deployment's /apps/authorize and
// returns the `<scheme>://auth/callback` link the consent page redirects to, or a cancel. The
// TypeScript runtime checks that link (state, issuer, expiry, one use) and runs the exchange: this
// file only carries it back, and logs nothing of it.

import AuthenticationServices
import UIKit

enum AuthAnswer: Equatable {
    case callback(String)
    case cancelled
}

enum AuthSessionError: Error, Equatable {
    /// Another sign-in sheet is showing (the system shows one at a time).
    case busy
    case invalidRequest
    /// The sheet could not be shown or failed.
    case failed
}

@MainActor
final class AuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    /// The window the sheet is shown over.
    private let anchor: () -> ASPresentationAnchor
    private var session: ASWebAuthenticationSession?

    init(anchor: @escaping () -> ASPresentationAnchor) {
        self.anchor = anchor
    }

    /// The scheme a callback may use: the brand's, lower case letters, digits, `+ . -`.
    nonisolated static func isScheme(_ scheme: String) -> Bool {
        scheme.range(of: "^[a-z][a-z0-9+.-]*$", options: .regularExpression) != nil
    }

    /// M5: https, or http only to a loopback host (a debug deployment on this machine).
    nonisolated static func isAuthorizeURL(_ url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "https": return url.host?.isEmpty == false
        case "http": return ["127.0.0.1", "localhost", "::1"].contains(url.host?.lowercased() ?? "")
        default: return false
        }
    }

    /// What the session's completion means: a callback link of `scheme`, a cancel, or a failure.
    nonisolated static func answer(callbackURL: URL?, error: Error?, scheme: String) -> Result<AuthAnswer, AuthSessionError> {
        if let error {
            let e = error as NSError
            if e.domain == ASWebAuthenticationSessionErrorDomain,
               e.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                return .success(.cancelled)
            }
            return .failure(.failed)
        }
        guard let url = callbackURL, url.scheme?.lowercased() == scheme else { return .failure(.failed) }
        return .success(.callback(url.absoluteString))
    }

    func start(url: URL, scheme: String, completion: @escaping (Result<AuthAnswer, AuthSessionError>) -> Void) {
        guard session == nil else { return completion(.failure(.busy)) }
        guard AuthSession.isScheme(scheme), AuthSession.isAuthorizeURL(url) else {
            return completion(.failure(.invalidRequest))
        }
        let done: (URL?, Error?) -> Void = { [weak self] callbackURL, error in
            DispatchQueue.main.async {
                self?.session = nil
                completion(AuthSession.answer(callbackURL: callbackURL, error: error, scheme: scheme))
            }
        }
        let made: ASWebAuthenticationSession
        if #available(iOS 17.4, *) {
            made = ASWebAuthenticationSession(url: url, callback: .customScheme(scheme), completionHandler: done)
        } else {
            made = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme, completionHandler: done)
        }
        made.prefersEphemeralWebBrowserSession = false
        made.presentationContextProvider = self
        session = made
        if !made.start() {
            session = nil
            completion(.failure(.failed))
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { anchor() }
    }
}
