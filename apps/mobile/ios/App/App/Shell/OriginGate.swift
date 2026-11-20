// The origin gate (mobile spec §5.3, §15.2): a post reaches the runtime only from the main frame
// of a document whose security origin is exactly the profile origin. Exact means scheme, host and
// effective port; a default port is normalized. This is the only boundary between a remote page
// and native capabilities; the shell script's own check is a convenience.

import Foundation

/// An origin in the form both sides compare: lower case scheme and host, the effective port.
struct Origin: Equatable {
    let scheme: String
    /// ASCII only (an IDN host must already be punycode), without IPv6 brackets.
    let host: String
    let port: Int

    /// `port` 0 or the scheme's default means the default port. Nil for anything but http(s), an
    /// empty or non-ASCII host, or a port out of range.
    init?(scheme: String, host: String, port: Int) {
        let scheme = scheme.lowercased()
        guard let defaultPort = Origin.defaultPorts[scheme] else { return nil }
        var host = host
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        guard !host.isEmpty, host.unicodeScalars.allSatisfy({ $0.isASCII && $0.value > 0x20 }),
              !host.contains("/"), !host.contains("@"), !host.contains("%")
        else { return nil }
        guard port == 0 || (1...65535).contains(port) else { return nil }
        self.scheme = scheme
        self.host = host.lowercased()
        self.port = port == 0 ? defaultPort : port
    }

    /// From a profile origin URL (`https://a.example`, `http://127.0.0.1:8765`); nil when it has
    /// a path, query, fragment or credentials, which a serialized origin never has.
    init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme, let host = components.encodedHost,
              components.user == nil, components.password == nil,
              components.path.isEmpty || components.path == "/",
              components.query == nil, components.fragment == nil
        else { return nil }
        self.init(scheme: scheme, host: host, port: components.port ?? 0)
    }

    init?(string: String) {
        guard let url = URL(string: string) else { return nil }
        self.init(url: url)
    }

    /// The WHATWG serialization (`normalizeAddress` in @capybara-hq/shell produces the same).
    var serialized: String {
        let shownHost = host.contains(":") ? "[\(host)]" : host
        return port == Origin.defaultPorts[scheme] ? "\(scheme)://\(shownHost)" : "\(scheme)://\(shownHost):\(port)"
    }

    private static let defaultPorts = ["https": 443, "http": 80]
}

enum OriginGate {
    /// True only for the main frame on exactly the profile origin.
    static func accept(isMainFrame: Bool, scheme: String, host: String, port: Int, profileOrigin: URL) -> Bool {
        guard isMainFrame,
              let profile = Origin(url: profileOrigin),
              let frame = Origin(scheme: scheme, host: host, port: port)
        else { return false }
        return frame == profile
    }
}
