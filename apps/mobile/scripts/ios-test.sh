#!/usr/bin/env bash
# Runs one test bundle of the iOS app (AppTests: XCTest; AppUITests: XCUITest) on a simulator.
#
# Xcode: the newest Xcode in /Applications when it is newer than the selected one (through
# DEVELOPER_DIR, so nothing global changes); otherwise the selected one. Simulator: an iPhone on
# the newest installed iOS runtime (27.1 or later where present, but an older runtime never fails
# the run), a regular model before a special one (Duo). A simulator this script found shut down is
# shut down again at the end.
#
# Usage: scripts/ios-test.sh AppTests|AppUITests
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
bundle="${1:?usage: ios-test.sh AppTests|AppUITests}"

version_of() { /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$1/Contents/Info.plist"; }
newer() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ] && [ "$1" != "$2" ]; }

current_dir="$(xcode-select -p)"
current="$(version_of "${current_dir%/Contents/Developer}" 2>/dev/null || echo 0)"
for app in /Applications/Xcode*.app; do
  [ -d "$app" ] || continue
  v="$(version_of "$app" 2>/dev/null || echo 0)"
  if newer "$v" "$current"; then
    current="$v"
    export DEVELOPER_DIR="$app/Contents/Developer"
  fi
done
echo "Xcode $current (${DEVELOPER_DIR:-$current_dir})"

udid="$(xcrun simctl list devices available -j | node -e '
  const devices = JSON.parse(require("node:fs").readFileSync(0, "utf8")).devices;
  const candidates = [];
  for (const [runtime, list] of Object.entries(devices)) {
    const m = /\.iOS-(\d+)-(\d+)/.exec(runtime);
    if (!m) continue;
    const version = Number(m[1]) * 1000 + Number(m[2]);
    for (const d of list) {
      if (d.name.startsWith("iPhone")) candidates.push({ ...d, version, special: / Duo/.test(d.name) });
    }
  }
  candidates.sort((a, b) => b.version - a.version || Number(a.special) - Number(b.special));
  const pick = candidates[0];
  if (!pick) {
    console.error("no available iPhone simulator");
    process.exit(1);
  }
  console.error(`simulator: ${pick.name} iOS ${Math.floor(pick.version / 1000)}.${pick.version % 1000} ${pick.udid} (${pick.state})`);
  console.log(`${pick.udid} ${pick.state}`);
')"
state="${udid#* }"
udid="${udid%% *}"
cleanup() { [ "$state" = "Shutdown" ] && xcrun simctl shutdown "$udid" 2>/dev/null || true; }
trap cleanup EXIT

# The app bundle needs the local pages and Capacitor's generated config (both gitignored).
(cd "$here" && node scripts/build.ts && node_modules/.bin/cap sync ios >/dev/null)

xcodebuild test \
  -project "$here/ios/App/App.xcodeproj" \
  -scheme App \
  -destination "platform=iOS Simulator,id=$udid" \
  -derivedDataPath "$here/ios/DerivedData" \
  -only-testing:"$bundle" \
  | grep -E "Test Suite|Test Case|Executed|error:|TEST (SUCCEEDED|FAILED)|\*\* "
