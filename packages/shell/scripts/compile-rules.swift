// Compiles signInBlockRules output with the real WebKit content-blocker compiler (macOS).
// Not part of the vitest run. Usage, from the repository root:
//   node --experimental-strip-types packages/shell/scripts/dump-rules.ts > /tmp/rules.json
//   swift packages/shell/scripts/compile-rules.swift /tmp/rules.json
// The JSON is { "<base>": [ { trigger, action }, ... ] }. Exit code 1 when any list is rejected.
import Foundation
import WebKit

let args: [String] = CommandLine.arguments
if args.count != 2 {
  print("usage: compile-rules <rules.json>")
  exit(2)
}
let data: Data = FileManager.default.contents(atPath: args[1]) ?? Data()
let parsed: Any? = try? JSONSerialization.jsonObject(with: data)
let lists: [String: [Any]] = (parsed as? [String: [Any]]) ?? [:]
if lists.isEmpty {
  print("no rule lists in \(args[1])")
  exit(2)
}

let dir: URL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
let maybeStore: WKContentRuleListStore? = WKContentRuleListStore(url: dir)
guard let store = maybeStore else {
  print("cannot create a rule list store")
  exit(2)
}

var failed: Bool = false
var pending: Int = lists.count
let bases: [String] = lists.keys.sorted()
for (index, base) in bases.enumerated() {
  let rules: [Any] = lists[base] ?? []
  let encoded: Data = (try? JSONSerialization.data(withJSONObject: rules)) ?? Data()
  let json: String = String(decoding: encoded, as: UTF8.self)
  store.compileContentRuleList(forIdentifier: "list\(index)", encodedContentRuleList: json) {
    (list: WKContentRuleList?, error: Error?) in
    if let error = error {
      failed = true
      print("FAIL \(base): \(error)")
    } else {
      print("OK   \(base) (\(rules.count) rules)")
    }
    pending -= 1
    if pending == 0 {
      try? FileManager.default.removeItem(at: dir)
      exit(failed ? 1 : 0)
    }
  }
}
RunLoop.main.run()
