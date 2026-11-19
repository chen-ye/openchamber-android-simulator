# AGENTS.md — android-simulator

OpenChamber extension in TypeScript/Bun targeting `@openchamber/sdk@2.7.1`.

## Layout

- `src/shared/` — Shared device, quality, and protocol types.
- `src/core/` — Binary discovery (`adb`, `emulator`, `scrcpy-server`, `ffmpeg`), ADB/AVD lifecycle, `uiautomator` XML parser + PNG annotator, and agent tool controller.
- `src/service/` — Node HTTP loopback service (`127.0.0.1:$OPENCHAMBER_SERVICE_PORT`, Bearer auth), `scrcpy-server` 5.0.1 TCP video/control client, stream manager, and Work Status view.
- `src/frame/` — Browser IIFE bundles for the docked rail panel (`panel/`) and 4-tile full-screen page (`page/`).
- `plugin/` — Bundled OpenCode plugin (`plugin/index.js`, zero external runtime imports) registering `android_device`, `android_input`, and `android_inspect`.
- `skills/android-simulator/SKILL.md` — Agent usage guide.

## Commands

- `bun run typecheck` — TypeScript check via `bun check --no-script`.
- `bun test` — Run unit tests (`test/`).
- `bun run build` — Rebuild `dist/` (`panel/`, `page/`, `service/`) and `plugin/index.js` via `openchamber-guest-bundle`.
- `bun run check` — Run `openchamber-guest-check`.
- `bun run verify` — Run all four checks in sequence.

## Invariants

- Never auto-boot an offline AVD without an explicit user click or `android_device({ action: "boot" })`.
- Never write runtime files inside the extension directory (it triggers live extension reload); runtime service discovery lives in `os.tmpdir()`.
- `dist/` and `plugin/index.js` must stay up to date with `src/` and `plugin/src/`.
- Work Status (`/status` `GuestStatusView`) is validated strictly by OpenChamber via `guestStatusViewSchema`: every `row.id` and `action.id` must match `GUEST_STATUS_CONTROL_ID` (`/^[a-z][a-z0-9-]{0,39}$/` — never raw colons, underscores, or uppercase serials/AVD names), labels/confirms must stay within `1..60` chars, values within `1..80` chars (compact for the 300px card), and multi-word badges must use `\u00A0` (`Agent\u00A0active`) so `WorkStatusPill` does not wrap onto two lines.
