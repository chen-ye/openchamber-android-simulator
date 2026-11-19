---
name: android-simulator
description: Use when building, testing, installing, or debugging Android apps on local emulators (AVDs) or connected ADB devices using the Android Simulator extension tools (`android_device`, `android_input`, `android_inspect`) and optional local `android` CLI composition.
---

# Android Simulator Workflow

Prefer semantic selectors and structured UI inspection over blind pixel guessing:

1. **Discover / Boot / Connect only when needed:**
   - Call `android_device({ action: "list" })` to see running emulators, USB/TCP devices, and offline AVDs.
   - Only call `android_device({ action: "boot", avd: "<name>" })` (add `cold: true` if snapshot state is wedged) when no target device is booted and the task requires running on an emulator.
   - Attach TCP/Tailscale/Redroid ADB targets with `android_device({ action: "connect", address: "host:5555" })`.
   - If ADB or `uiautomator` acts wedged, run `android_device({ action: "diagnose", attemptFix: true })`.

2. **Selector-First & `#N` Input:**
   - When you already know a label or resource ID, target it directly with `android_input({ action: "tap", selector: "text=Sign in,clickable=true", waitMs: 3000 })` (default `match: "single"` fails safely if ambiguous; pass `match: "first"` when intended).
   - Otherwise call `android_inspect({ action: "layout", annotate: true })` (add `tree: true` to disambiguate duplicate labels inside sibling cards), then tap by `node: N` (from `#N`) or exact `center` coordinates.
   - Use `android_input({ action: "scroll", direction: "down", until: "text=Save" })` to scroll inside scrollable containers, `long_press` for context menus, `text` with `clearFirst: true` / `submit: true`, and `sequence` to batch fast multi-step interactions without LLM round-trip latency.

3. **Install, Launch, Screenshot, Reset & Debug:**
   - Install APKs with `android_device({ action: "install_apk", apkPath: "...", grantPermissions: true })` (or `apkPaths: [...]` for split APKs).
   - Launch, force-stop, or reset app data via `launch`, `stop_app`, and `clear_data`; open deep links via `open_url`.
   - Capture screenshots with `android_inspect({ action: "screenshot", filename: "light.png" })` — writes PNG under `/tmp/opencode/` (or a timestamped file when `filename` is omitted) and returns `{ serial, path, width, height, currentFocus }` ready for `read` or `openchamber_render`.
   - Prefer `android_inspect({ action: "screenshot" })` and `android_device({ action: "appearance", appearance: "light" | "dark" })` over raw `adb exec-out screencap` or `adb shell cmd uimode`.
   - Check crashes or logs with `android_inspect({ action: "logcat", lines: 120 })` (`clear: true` before reproducing a bug).
   - Test rotation via `android_device({ action: "rotate" })`.

4. **Composing with Google's `android` CLI (when available, e.g. `~/.local/bin/android`):**
   - For **Jetpack Compose `@Preview`s** without booting an emulator: run `~/.local/bin/android preview render ... --component-tree`.
   - For **WebViews, Flutter, or Canvas/games** where `uiautomator` returns few/no nodes: run `~/.local/bin/android screen capture -a -o /tmp/opencode/cv.png` to get CV edge-detected `#N` boxes and `android screen resolve`.
   - For **delta APK installs**, **Perfetto system traces**, or **R8/APK size analysis**: run `~/.local/bin/android install`, `android profiler`, or `android analyze` directly via `shell`.
