// Where a navigation of a profile WebView may go: the port of src/runtime/navigation.ts (and of
// `isInWindowSignIn` from @capybara-hq/shell, for the navigation case). WebKit asks for a policy
// before every navigation and the answer is needed now, so this runs natively; vitest, XCTest and
// JUnit all pass apps/mobile/test/fixtures/navigation.json, and the sign-in guard passes
// packages/shell/test/fixtures/in-window-sign-in.json.
//
// URLs are taken apart by `NavURL` below, the same way on both platforms: the scheme, then for
// http(s) the authority (userinfo dropped, as WHATWG does, `\` counted as `/`), the raw path and
// the raw query. Origins compare as `Origin` (OriginGate.swift).

import Foundation

enum NavigationDecision: String {
    case allow, sheet, block
}

/// A URL split the way the navigation rules need it. Only http(s) URLs get an origin.
struct NavURL {
    let scheme: String
    let origin: Origin?
    let rawPath: String
    let rawQuery: String?

    init?(_ string: String) {
        guard let colon = string.firstIndex(of: ":") else { return nil }
        let scheme = String(string[..<colon]).lowercased()
        guard let first = scheme.unicodeScalars.first, CharacterSet.letters.contains(first),
              scheme.unicodeScalars.allSatisfy({ $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "+-.".unicodeScalars.contains($0)) })
        else { return nil }
        self.scheme = scheme
        guard scheme == "http" || scheme == "https" else {
            origin = nil
            rawPath = ""
            rawQuery = nil
            return
        }
        var rest = string[string.index(after: colon)...]
        while let c = rest.first, c == "/" || c == "\\" { rest = rest.dropFirst() }
        let authorityEnd = rest.firstIndex(where: { "/\\?#".contains($0) }) ?? rest.endIndex
        var authority = rest[..<authorityEnd]
        if let at = authority.lastIndex(of: "@") { authority = authority[authority.index(after: at)...] }
        var host = Substring(authority)
        var port = 0
        if let close = authority.lastIndex(of: "]"), authority.first == "[" {
            host = authority[...close]
            let after = authority[authority.index(after: close)...]
            if after.first == ":" { port = NavURL.port(after.dropFirst()) ?? -1 } else if !after.isEmpty { port = -1 }
        } else if let c = authority.lastIndex(of: ":") {
            host = authority[..<c]
            port = NavURL.port(authority[authority.index(after: c)...]) ?? -1
        }
        origin = port < 0 ? nil : Origin(scheme: scheme, host: String(host), port: port)
        let tail = rest[authorityEnd...]
        let pathEnd = tail.firstIndex(where: { $0 == "?" || $0 == "#" }) ?? tail.endIndex
        rawPath = String(tail[..<pathEnd])
        if pathEnd < tail.endIndex, tail[pathEnd] == "?" {
            let q = tail[tail.index(after: pathEnd)...]
            rawQuery = String(q[..<(q.firstIndex(of: "#") ?? q.endIndex)])
        } else {
            rawQuery = nil
        }
    }

    /// Empty means the default; digits only, at most 65535.
    private static func port(_ s: Substring) -> Int? {
        if s.isEmpty { return 0 }
        guard s.count <= 5, s.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(s), n <= 65535 else { return nil }
        return n
    }

    var isHttp: Bool { scheme == "http" || scheme == "https" }

    /// The first value of a query parameter, form-decoded (`+` is a space), as URLSearchParams does.
    func queryValue(_ name: String) -> String? {
        guard let rawQuery else { return nil }
        for pair in rawQuery.split(separator: "&", omittingEmptySubsequences: true) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let key = PercentDecoding.lenient(String(parts[0]).replacingOccurrences(of: "+", with: " "))
            if key == name {
                let value = parts.count > 1 ? String(parts[1]) : ""
                return PercentDecoding.lenient(value.replacingOccurrences(of: "+", with: " "))
            }
        }
        return nil
    }
}

enum PercentDecoding {
    /// `decodeURIComponent`: nil when an escape is malformed or the bytes are not UTF-8.
    static func strict(_ s: String) -> String? {
        var bytes: [UInt8] = []
        var it = Array(s.utf8)[...]
        while let b = it.first {
            it = it.dropFirst()
            if b != UInt8(ascii: "%") {
                bytes.append(b)
                continue
            }
            guard it.count >= 2, let hi = hex(it[it.startIndex]), let lo = hex(it[it.startIndex + 1]) else { return nil }
            bytes.append(hi << 4 | lo)
            it = it.dropFirst(2)
        }
        // A failable decode: nil unless the bytes are valid UTF-8.
        let text = String(decoding: bytes, as: UTF8.self)
        return Array(text.utf8) == bytes ? text : nil
    }

    /// URLSearchParams' decoding: a malformed escape stays as written, bad UTF-8 is replaced.
    static func lenient(_ s: String) -> String {
        var bytes: [UInt8] = []
        let all = Array(s.utf8)
        var i = 0
        while i < all.count {
            if all[i] == UInt8(ascii: "%"), i + 2 < all.count,
               let hi = hex(all[i + 1]), let lo = hex(all[i + 2]) {
                bytes.append(hi << 4 | lo)
                i += 3
            } else {
                bytes.append(all[i])
                i += 1
            }
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    private static func hex(_ b: UInt8) -> UInt8? {
        switch b {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return b - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return b - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return b - UInt8(ascii: "A") + 10
        default: return nil
        }
    }
}

/// The two in-WebView sign-in routes (`isInWindowSignIn` of packages/shell/src/sign-in-guard.ts).
enum SignInGuard {
    /// Percent-escapes decoded per segment (a malformed one stays), `\` as `/`, doubled slashes and
    /// dot segments resolved, no trailing slash, lower case.
    static func canonicalPath(_ path: String) -> String {
        let decoded = path.split(separator: "/", omittingEmptySubsequences: false)
            .map { PercentDecoding.strict(String($0)) ?? String($0) }
            .joined(separator: "/")
            .replacingOccurrences(of: "\\", with: "/")
        var out: [String] = []
        for part in decoded.split(separator: "/", omittingEmptySubsequences: false) {
            if part.isEmpty || part == "." { continue }
            if part == ".." { _ = out.popLast() } else { out.append(part.lowercased()) }
        }
        return out.isEmpty ? "" : "/" + out.joined(separator: "/")
    }

    static func isInWindowSignIn(method: String, url: String, base: String) -> Bool {
        guard let target = NavURL(url), let home = NavURL(base),
              let targetOrigin = target.origin, targetOrigin == home.origin
        else { return false }
        let prefix = canonicalPath(home.rawPath)
        let path = canonicalPath(target.rawPath)
        guard path.hasPrefix(prefix + "/") else { return false }
        let route = path.dropFirst(prefix.count).split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        let parts = Array(route)
        // /api/v1/auth/sso/<one or more>/start
        if parts.count >= 6, Array(parts.prefix(4)) == ["api", "v1", "auth", "sso"], parts.last == "start" {
            return true
        }
        return method.uppercased() == "POST" && parts == ["api", "v1", "auth", "login"]
    }
}

enum NavigationPolicy {
    /// The kernel's OAuth state lives 10 minutes; so does a pending return.
    static let oauthReturnTTL: TimeInterval = 600

    private static let frameSchemes: Set<String> = ["http", "https", "about", "data", "blob"]

    static func isAuthorizationUrl(_ url: String, profileOrigin: Origin) -> Bool {
        guard let u = NavURL(url), u.isHttp, u.queryValue("response_type") != nil,
              u.queryValue("client_id") != nil, u.queryValue("state") != nil,
              let back = u.queryValue("redirect_uri").flatMap(NavURL.init), back.isHttp
        else { return false }
        return back.origin == profileOrigin
    }

    static func decide(url: String, profileOrigin: String, base: String, isMainFrame: Bool,
                       targetBlank: Bool, oauthReturnPending: Bool,
                       fromProfileOrigin: Bool) -> NavigationDecision {
        guard let u = NavURL(url), let profile = Origin(string: profileOrigin) else { return .block }
        if u.isHttp, u.origin == profile, SignInGuard.isInWindowSignIn(method: "POST", url: url, base: base) {
            return .block
        }
        if targetBlank { return u.isHttp && u.origin != nil ? .sheet : .block }
        if !isMainFrame { return frameSchemes.contains(u.scheme) ? .allow : .block }
        guard u.isHttp, let origin = u.origin else { return .block }
        if origin == profile { return .allow }
        if oauthReturnPending { return .allow }
        // Only a page on the profile origin may start a leave-and-return (never a foreign one).
        if fromProfileOrigin, isAuthorizationUrl(url, profileOrigin: profile) { return .allow }
        return .sheet
    }
}

/// A pending connector OAuth leave-and-return (`nextOauthReturn` in navigation.ts).
struct OauthReturn: Equatable {
    var since: Date

    static func isPending(_ state: OauthReturn?, now: Date) -> Bool {
        guard let state else { return false }
        return now.timeIntervalSince(state.since) < NavigationPolicy.oauthReturnTTL
    }

    static func next(_ prev: OauthReturn?, url: String, decision: NavigationDecision, profileOrigin: Origin,
                     now: Date) -> OauthReturn? {
        let live = isPending(prev, now: now) ? prev : nil
        guard decision == .allow, let u = NavURL(url), u.isHttp, let origin = u.origin else { return live }
        if origin == profileOrigin { return nil }
        return live ?? OauthReturn(since: now)
    }
}
