# Android Simulator extension for OpenChamber

Streams local Android emulators (AVDs) and connected ADB devices (USB or TCP) live into OpenChamber with low-latency touch and keyboard input, a multi-tile viewer, Work Status controls, session instructions, and OpenCode agent tools (`android_device`, `android_input`, `android_inspect`).

## Setup

### Prerequisites

1. OpenChamber `>= 2.7.1`.
2. Android SDK tools (`adb` and `emulator`) installed in `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Android/Sdk` (Linux), `~/Library/Android/sdk` (macOS), `/opt/android-sdk`, `/usr/lib/android-sdk`, or on `PATH`.
3. `scrcpy` (`scrcpy-server`, or `$SCRCPY_SERVER_PATH`) and `ffmpeg` on `PATH` (or in Homebrew `/home/linuxbrew/.linuxbrew` / `/opt/homebrew`) for live `scrcpy` H.264 streaming and binary touch/key input. When either is missing, video falls back automatically to periodic `adb exec-out screencap` PNG polling.

### Enable in OpenChamber

1. Open **Settings → Extensions** and add the `android-simulator` folder (or repository URL).
2. Approve the requested permissions (local service, `adb`/`emulator`/`scrcpy-server`/`ffmpeg` execution, and OpenCode plugin).

`dist/` and `plugin/index.js` are committed so OpenChamber can load the extension without a build step. Offline AVDs never boot automatically until you click **Boot** or an agent calls `android_device({ action: "boot" })`.

## Using Android Simulator in OpenChamber

### Rail panel and live surface

The **Android Simulator** toolbar docks above OpenChamber's live device screen:

- **Device picker**: Switch between configured AVDs, running emulators, USB devices, and TCP ADB targets (showing state and API level).
- **Power lifecycle**: **Boot** an offline AVD (headless), **Off** a running emulator, or **Unplug** a TCP device.
- **Navigation & hardware**: **Back**, **Home**, **Recents**, **Rotate**, **Dark** / **Light** appearance toggle, and **Power**.
- **Stream quality**: Cycle between `1:1` (full resolution), `1:2` (balanced, `1080px` max), and `1:3` (fast, `720px` max).
- **`APK / URL` drawer**: Expand to **Install APK** from a local path (supports `~/`) or **Open URL** (web URLs and deep links).
- **Status badge**: Shows live FPS, `Agent` while an agent tool is driving the device, `Booting`, `No adb`, or the current device state.

Click, drag, scroll, type, paste, or copy (`Ctrl`/`Cmd+C` syncs the Android clipboard) directly on the screen. Streams stop automatically after 45 seconds without an active viewer.

### Multi-tile full-screen page

Open **Extension pages → Android Simulator** to view and interact with up to 4 emulators or devices side-by-side:

- Use **`+`** and **`×`** in a tile corner to add or close tiles (tile assignments, quality, and frame state are saved across reloads).
- Toggle **Frame** in the toolbar to show or hide the device bezel with clickable **Volume Up**, **Volume Down**, and **Power / Lock** side buttons.
- Click **Boot** directly on an offline AVD tile placeholder to start it in place.

### Work Status panel

The **Android Simulator** section in Work Status shows:

- Active device name, status dot, state or API level, and a **Boot**, **Power off** (`Power off?` confirm), or **Disconnect** button when applicable.
- Stream row showing transport (`scrcpy` or `screencap`), resolution, FPS, and an `Agent active` badge when agent tools recently ran.
- A **Connected** summary row when more than one device is booted, or a warning note if `adb` is missing or streaming hits an error.

### Agent tools, skill, and session instructions

- **Session instructions**: Summarizes detected AVDs and ADB devices (`serial` and state) so the agent knows what is available without polling first.
- **Bundled skill**: Includes `skills/android-simulator/SKILL.md`, guiding agents to prefer semantic selectors and `#N` layout nodes over raw coordinate guessing, and documenting optional composition with Google's `android` CLI when installed.
- **OpenCode tools**:
  - `android_device`: `list`, `select`, `connect` (`host:port`), `boot` (`avd`, `headless`, `cold`), `shutdown`, `launch`, `stop_app`, `clear_data`, `rotate` (`0`/`90`/`180`/`270`), `appearance` (`light`/`dark`), `open_url`, `install_apk` (`apkPath`, `apkPaths`, `grantPermissions`), and `diagnose` (`attemptFix`).
  - `android_input`: `tap`, `long_press`, `swipe`, `scroll` (`direction`, `until`, `maxScrolls`), `text` (`clearFirst`, `submit`), `key`, `back`, `home`, `recents`, `power`, and `sequence` (up to 30 batched steps including `wait`). Targets `#N` node indices from the latest layout, semantic `selector` (`waitMs`, `match`), pixel coordinates, or `normalized: true` (`0..1`) coordinates.
  - `android_inspect`: `layout` (`annotate`, `tree`, `includeAll`, `maxNodes`), `screenshot` (writes PNG files under `/tmp/opencode/`), and `logcat` (`lines`, `filter`, `clear`).

### How the pieces fit together

```text
  Local Android tools (adb, emulator, scrcpy-server, ffmpeg)
        │  H.264/screencap video, binary input, uiautomator XML
        ▼
  Android Simulator service
        │
        ├──► Rail Panel & Live Surface (single active device)
        ├──► Multi-Tile Page (up to 4 devices + bezel hardware keys)
        ├──► Work Status (Boot / Power off / Disconnect, stream FPS)
        └──► OpenCode Plugin (android_device, android_input, android_inspect)
```

## Development

```bash
bun run typecheck
bun test
bun run build
bun run check
bun run verify
```
