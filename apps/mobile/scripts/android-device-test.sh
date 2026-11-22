#!/usr/bin/env bash
# Runs the instrumented tests (test:android:device) on the one running emulator or device, then
# prints what the system reported during the run (ANRs, crashes, closed dialogs, focus waits) and,
# when the tests fail, writes logcat, a screenshot and the window list to
# android/app/build/device-diagnostics (CI uploads it).
#
# In CI ($CI set) the emulator is freshly booted: any system dialog already open (an ANR or crash
# dialog of System UI on a slow cold boot) is closed first; the tests' taps also wait for the app's
# window themselves (InputInjection.kt). The error dialogs stay on: hiding them makes the system
# kill a process that stops responding instead of letting a slow emulator catch up.
#
# Usage: scripts/android-device-test.sh
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/android/app/build/device-diagnostics"

adb wait-for-device
if [ -n "${CI:-}" ]; then
  adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null
fi
adb logcat -c || true

(cd "$here" && pnpm run test:android:device)
status=$?

echo "--- system events during the run (ANR, crash, focus waits) ---"
adb logcat -d -b main,system,crash,events 2>/dev/null |
  grep -E "ANR in|am_anr|am_crash|FATAL EXCEPTION|isn't responding|InputInjection|not directed at a window" |
  head -n 80 || true

if [ "$status" -ne 0 ]; then
  rm -rf "$out" && mkdir -p "$out"
  adb logcat -d -b all -v threadtime > "$out/logcat.txt" 2>&1 || true
  adb exec-out screencap -p > "$out/screen.png" 2>/dev/null || true
  adb shell dumpsys window windows > "$out/windows.txt" 2>&1 || true
  adb shell dumpsys activity activities > "$out/activities.txt" 2>&1 || true
  echo "diagnostics in $out"
fi
exit "$status"
