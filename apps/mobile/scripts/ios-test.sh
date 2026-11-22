#!/usr/bin/env bash
# Runs test bundles of the iOS app (AppTests: XCTest; AppUITests: XCUITest) on a simulator: one
# `build-for-testing`, then one `test-without-building` per bundle.
#
# Xcode: in CI ($CI set) the runner's selected Xcode, unless it has no usable iPhone simulator.
# Otherwise (and locally) the newest non-beta Xcode among the selected one and /Applications/Xcode*.app
# that has one. A simulator is usable for an Xcode when its iOS runtime is not newer than that
# Xcode's iOS simulator SDK. The choice goes through DEVELOPER_DIR: nothing global changes, no sudo.
# Simulator: an iPhone on the newest usable runtime (27.1 or later where present; an older runtime
# never fails the run), a regular model before a special one (Duo). A simulator this script found
# shut down is shut down again at the end. It boots during the build; every bundle runs (a failed
# one fails the script at the end), and its full output and result bundle go to ios/test-results.
#
# Usage: scripts/ios-test.sh AppTests|AppUITests [AppTests|AppUITests]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
[ "$#" -gt 0 ] || { echo "usage: ios-test.sh AppTests|AppUITests ..." >&2; exit 2; }

version_of() { /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$1/Contents/Info.plist"; }

# Prints "<udid> <state>" of the simulator to use with the Xcode at $1 (a Developer dir), or fails.
pick_simulator() {
  local sdk
  sdk="$(DEVELOPER_DIR="$1" xcrun --sdk iphonesimulator --show-sdk-version 2>/dev/null)" || return 1
  DEVELOPER_DIR="$1" xcrun simctl list devices available -j | node -e '
    const [major, minor = "0"] = process.argv[1].split(".");
    const sdk = Number(major) * 1000 + Number(minor);
    const devices = JSON.parse(require("node:fs").readFileSync(0, "utf8")).devices;
    const candidates = [];
    for (const [runtime, list] of Object.entries(devices)) {
      const m = /\.iOS-(\d+)-(\d+)/.exec(runtime);
      if (!m) continue;
      const version = Number(m[1]) * 1000 + Number(m[2]);
      if (version > sdk) continue;
      for (const d of list) {
        if (d.name.startsWith("iPhone")) candidates.push({ ...d, version, special: / Duo/.test(d.name) });
      }
    }
    candidates.sort((a, b) => b.version - a.version || Number(a.special) - Number(b.special));
    const pick = candidates[0];
    if (!pick) process.exit(1);
    const v = `${Math.floor(pick.version / 1000)}.${pick.version % 1000}`;
    console.error(`simulator: ${pick.name} iOS ${v} ${pick.udid} (${pick.state}), SDK ${process.argv[1]}`);
    console.log(`${pick.udid} ${pick.state}`);
  ' "$sdk"
}

default_dir="$(xcode-select -p)"
chosen="" picked=""
if [ -n "${CI:-}" ] && picked="$(pick_simulator "$default_dir")"; then
  chosen="$default_dir"
else
  # Candidates newest first: the selected Xcode and every Xcode in /Applications, betas skipped.
  candidates="$(
    for app in "${default_dir%/Contents/Developer}" /Applications/Xcode*.app; do
      [ -d "$app/Contents/Developer" ] || continue
      case "$app" in *[Bb]eta*) continue ;; esac
      echo "$(version_of "$app" 2>/dev/null || echo 0) $app/Contents/Developer"
    done | sort -rV -k1,1 | awk '!seen[$2]++'
  )"
  while read -r _ dir; do
    [ -n "$dir" ] || continue
    if picked="$(pick_simulator "$dir")"; then chosen="$dir"; break; fi
  done <<<"$candidates"
fi
[ -n "$chosen" ] || { echo "no Xcode with a usable iPhone simulator" >&2; exit 1; }
export DEVELOPER_DIR="$chosen"
echo "Xcode $(version_of "${chosen%/Contents/Developer}") ($chosen)"
udid="${picked%% *}"
state="${picked#* }"
cleanup() { [ "$state" = "Shutdown" ] && xcrun simctl shutdown "$udid" 2>/dev/null || true; }
trap cleanup EXIT

# The app bundle needs the local pages and Capacitor's generated config (both gitignored).
(cd "$here" && node scripts/build.ts && node_modules/.bin/cap sync ios >/dev/null)

common=(
  -project "$here/ios/App/App.xcodeproj"
  -scheme App
  -destination "platform=iOS Simulator,id=$udid"
  -derivedDataPath "$here/ios/DerivedData"
)
results="$here/ios/test-results"
rm -rf "$results" && mkdir -p "$results"

# Boot the simulator while the build runs, and wait until it is fully up before any test: left to
# xcodebuild, a fresh CI simulator boots when the first bundle starts and is still settling while
# the tests launch the app (clients#41: a UI test's launch timed out).
xcrun simctl boot "$udid" 2>/dev/null || true
xcodebuild build-for-testing "${common[@]}" -quiet
xcrun simctl bootstatus "$udid" >/dev/null
status=0
for bundle in "$@"; do
  # The full output and the result bundle stay in ios/test-results (CI uploads them on failure);
  # the console gets the test lines.
  set +e
  xcodebuild test-without-building "${common[@]}" -only-testing:"$bundle" \
    -resultBundlePath "$results/$bundle.xcresult" 2>&1 \
    | tee "$results/$bundle.log" \
    | grep --line-buffered -E "Test Suite|Test Case|Executed|error:|TEST (SUCCEEDED|FAILED)|\*\* "
  code="${PIPESTATUS[0]}"
  set -e
  if [ "$code" != 0 ]; then
    echo "xcodebuild exited $code for $bundle; the result bundle's summary:" >&2
    xcrun xcresulttool get test-results summary --path "$results/$bundle.xcresult" >&2 || true
    status="$code"
  fi
done
exit "$status"
