# Android Simulator for OpenChamber

An [OpenChamber](https://openchamber.dev) extension that streams local Android emulators (AVDs) and connected ADB devices (USB or TCP/Tailscale) live into OpenChamber's shared surface, multi-tile full-screen page, and Work Status panel—plus native OpenCode agent tools (`android_device`, `android_input`, `android_inspect`) with structured `uiautomator` layout inspection.

## Features

- **Live Rail Panel + Shared Surface**: Docked toolbar (`Device` picker, `Boot`/`Power off`, `Back`, `Home`, `Recents`, `Rotate`, `Dark`/`Light`, `Power`, `1:1`/`1:2`/`1:3` quality, inline `APK / URL` drawer) over OpenChamber's shared surface canvas. Works across desktop, web, and mobile relay with no extra open ports.
- **Multi-Tile Full-Screen Page**: Open **Extension pages → Android Simulator** to view and interact with up to 4 emulators or devices side-by-side (`+` / `×` corners, clickable CSS Pixel frame hardware buttons, keyboard + paste forwarding).
- **Work Status Section**: Shows active device, stream mode (`scrcpy` / `screencap`), resolution, FPS, `Agent active` badge, and quick `Boot` / `Power off` actions.
- **Fast `scrcpy-server` Streaming + Binary Input**: Streams H.264 from `scrcpy-server` (`5.0.1`) decoded via `ffmpeg` MJPEG pipe, with binary `INJECT_TOUCH_EVENT`, `INJECT_SCROLL_EVENT`, `INJECT_KEYCODE`, `INJECT_TEXT`, and clipboard sync—falling back automatically to `adb exec-out screencap` when needed.
- **OpenCode Agent Tools + Skill**:
  - `android_device`: `list`, `select`, `connect`, `boot` (with `cold`), `shutdown`, `launch`, `stop_app`, `clear_data`, `rotate`, `appearance`, `open_url`, `install_apk` (`grantPermissions`, split APKs), `diagnose`
  - `android_input`: `tap`, `long_press`, `swipe`, `scroll` (`until` selector), `text` (`clearFirst`, `submit`), `key`, `back`, `home`, `recents`, `power`, `sequence` — targeting `(x, y)`, `#N` node index, or semantic `selector` + `waitMs`
  - `android_inspect`: `layout` (flat or nested `tree`, `hidden`/`offScreen`/`selected`/`password` flags, `#N` annotated PNG), `screenshot`, `logcat`
  - Includes `SKILL.md` guidance for optional composition with Google's `android` CLI (`preview`, `profiler`, `analyze`, CV `screen capture --annotate`) when installed.
- **Explicit Boot Only**: Offline AVDs never boot automatically until you click **Boot** or an agent calls `android_device({ action: "boot" })`.

## Prerequisites

- OpenChamber `>= 2.7.1` (desktop app or web server).
- Android SDK (`adb` and `emulator` under `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, or `~/Android/Sdk`).
- `scrcpy` (`scrcpy-server` 5.0.1) and `ffmpeg` on `PATH` (or Homebrew `/home/linuxbrew/.linuxbrew` / `/opt/homebrew`) for low-latency live video and binary touch/key input.

## Install

Add this folder (or repository URL) in **Settings → Extensions**:

```text
~/openchamber-extensions/android-simulator
```

Approve the requested permissions (**Run a local service** and **OpenCode plugin**).

## Development

```bash
bun install
bun run verify   # typecheck + unit tests + bundle dist/ & plugin/ + openchamber-guest-check
```

`dist/` and `plugin/index.js` are committed so OpenChamber installs from folder or Git URL without a build step.
