import type { SurfaceInputEvent, SurfaceKeyEvent, SurfaceModifiers } from '@openchamber/sdk';
import { adbKey, adbText } from '../core/adb.ts';
import {
  AKEY_ACTION_DOWN,
  AKEY_ACTION_UP,
  AMOTION_ACTION_DOWN,
  AMOTION_ACTION_MOVE,
  AMOTION_ACTION_UP,
  encodeKeycodeEvent,
  encodeScrollEvent,
  encodeSetClipboard,
  encodeTextEvent,
  encodeTouchEvent,
  type ScrcpySession,
} from './scrcpy.ts';

// Android KeyEvent constants
export const KEYCODE_HOME = 3;
export const KEYCODE_BACK = 4;
export const KEYCODE_POWER = 26;
export const KEYCODE_VOLUME_UP = 24;
export const KEYCODE_VOLUME_DOWN = 25;
export const KEYCODE_APP_SWITCH = 187;
export const KEYCODE_DEL = 67;
export const KEYCODE_FORWARD_DEL = 112;
export const KEYCODE_ENTER = 66;
export const KEYCODE_TAB = 61;
export const KEYCODE_ESCAPE = 111;
export const KEYCODE_SPACE = 62;
export const KEYCODE_DPAD_UP = 19;
export const KEYCODE_DPAD_DOWN = 20;
export const KEYCODE_DPAD_LEFT = 21;
export const KEYCODE_DPAD_RIGHT = 22;
export const KEYCODE_MOVE_HOME = 122;
export const KEYCODE_MOVE_END = 123;
export const KEYCODE_PAGE_UP = 92;
export const KEYCODE_PAGE_DOWN = 93;
export const KEYCODE_COPY = 278;
export const KEYCODE_PASTE = 279;

const AMETA_SHIFT_ON = 1;
const AMETA_ALT_ON = 2;
const AMETA_CTRL_ON = 0x1000;
const AMETA_META_ON = 0x10000;

export function androidMetaState(mod: SurfaceModifiers): number {
  let state = 0;
  if (mod.shift) state |= AMETA_SHIFT_ON;
  if (mod.alt) state |= AMETA_ALT_ON;
  if (mod.ctrl) state |= AMETA_CTRL_ON;
  if (mod.meta) state |= AMETA_META_ON;
  return state;
}

export function mapWebKeyToAndroidKeycode(ev: Pick<SurfaceKeyEvent, 'key' | 'code'>): number | null {
  switch (ev.key) {
    case 'Backspace':
      return KEYCODE_DEL;
    case 'Delete':
      return KEYCODE_FORWARD_DEL;
    case 'Enter':
      return KEYCODE_ENTER;
    case 'Tab':
      return KEYCODE_TAB;
    case 'Escape':
      return KEYCODE_ESCAPE;
    case ' ':
      return KEYCODE_SPACE;
    case 'ArrowUp':
      return KEYCODE_DPAD_UP;
    case 'ArrowDown':
      return KEYCODE_DPAD_DOWN;
    case 'ArrowLeft':
      return KEYCODE_DPAD_LEFT;
    case 'ArrowRight':
      return KEYCODE_DPAD_RIGHT;
    case 'Home':
      return KEYCODE_MOVE_HOME;
    case 'End':
      return KEYCODE_MOVE_END;
    case 'PageUp':
      return KEYCODE_PAGE_UP;
    case 'PageDown':
      return KEYCODE_PAGE_DOWN;
    case 'BrowserBack':
    case 'GoBack':
      return KEYCODE_BACK;
    default:
      break;
  }

  if (/^Key([A-Z])$/.test(ev.code)) {
    const ch = ev.code.charCodeAt(3);
    return 29 + (ch - 65); // KEYCODE_A = 29 .. KEYCODE_Z = 54
  }
  if (/^Digit([0-9])$/.test(ev.code)) {
    const ch = ev.code.charCodeAt(5);
    return 7 + (ch - 48); // KEYCODE_0 = 7 .. KEYCODE_9 = 16
  }
  return null;
}

export function isAsciiPrintable(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return text.length > 0;
}

export class DeviceInputState {
  touching = false;
  lastX = 0;
  lastY = 0;
  lastCopyAt = 0;

  resetTouch(session: ScrcpySession | null, screenW: number, screenH: number): void {
    if (!this.touching) return;
    this.touching = false;
    if (session && screenW > 0 && screenH > 0) {
      session.sendControl(
        encodeTouchEvent({
          action: AMOTION_ACTION_UP,
          pointerId: 1n,
          x: this.lastX,
          y: this.lastY,
          screenWidth: screenW,
          screenHeight: screenH,
        }),
      );
    }
  }
}

export async function dispatchSurfaceEvents(params: {
  events: readonly SurfaceInputEvent[];
  session: ScrcpySession | null;
  serial: string;
  screenWidth: number;
  screenHeight: number;
  state: DeviceInputState;
}): Promise<void> {
  const { events, session, serial, screenWidth, screenHeight, state } = params;
  const w = Math.max(1, screenWidth);
  const h = Math.max(1, screenHeight);

  for (const ev of events) {
    if (ev.type === 'pointer') {
      const x = Math.max(0, Math.min(w - 1, Math.round(ev.x)));
      const y = Math.max(0, Math.min(h - 1, Math.round(ev.y)));
      state.lastX = x;
      state.lastY = y;

      if (ev.action === 'down') {
        if (ev.button !== 0 && (ev.buttons & 1) === 0) continue;
        state.touching = true;
        if (session) {
          session.sendControl(
            encodeTouchEvent({
              action: AMOTION_ACTION_DOWN,
              pointerId: 1n,
              x,
              y,
              screenWidth: w,
              screenHeight: h,
            }),
          );
        }
      } else if (ev.action === 'move') {
        if (!state.touching) continue;
        if (session) {
          session.sendControl(
            encodeTouchEvent({
              action: AMOTION_ACTION_MOVE,
              pointerId: 1n,
              x,
              y,
              screenWidth: w,
              screenHeight: h,
            }),
          );
        }
      } else if (ev.action === 'up') {
        if (!state.touching) continue;
        state.touching = false;
        if (session) {
          session.sendControl(
            encodeTouchEvent({
              action: AMOTION_ACTION_UP,
              pointerId: 1n,
              x,
              y,
              screenWidth: w,
              screenHeight: h,
            }),
          );
        }
      }
      continue;
    }

    if (ev.type === 'wheel') {
      const x = Math.max(0, Math.min(w - 1, Math.round(ev.x)));
      const y = Math.max(0, Math.min(h - 1, Math.round(ev.y)));
      // Web deltaY > 0 means scroll down; scrcpy positive vScroll scrolls up.
      const hScroll = Math.max(-1, Math.min(1, -ev.deltaX / 120));
      const vScroll = Math.max(-1, Math.min(1, -ev.deltaY / 120));
      if (session) {
        session.sendControl(
          encodeScrollEvent({
            x,
            y,
            screenWidth: w,
            screenHeight: h,
            hScroll,
            vScroll,
          }),
        );
      }
      continue;
    }

    if (ev.type === 'text') {
      if (!ev.text) continue;
      if (session) {
        if (isAsciiPrintable(ev.text) && !ev.text.includes('\n') && ev.text.length <= 200) {
          session.sendControl(encodeTextEvent(ev.text));
        } else {
          session.sendControl(encodeSetClipboard(ev.text, true, BigInt(Date.now())));
        }
      } else {
        await adbText(serial, ev.text);
      }
      continue;
    }

    if (ev.type === 'key') {
      const hasShortcutMod = ev.modifiers.ctrl || ev.modifiers.meta;
      const lower = ev.key.toLowerCase();

      // Copy chord -> trigger copy and remember timestamp for /surface/clipboard
      if (ev.action === 'down' && hasShortcutMod && lower === 'c') {
        state.lastCopyAt = Date.now();
        if (session) {
          session.sendControl(encodeKeycodeEvent({ action: AKEY_ACTION_DOWN, keycode: KEYCODE_COPY }));
          session.sendControl(encodeKeycodeEvent({ action: AKEY_ACTION_UP, keycode: KEYCODE_COPY }));
        } else {
          await adbKey(serial, KEYCODE_COPY);
        }
        continue;
      }

      // Printable keys without Ctrl/Meta/Alt arrive via 'text' event in browser surfaces.
      const keycode = mapWebKeyToAndroidKeycode(ev);
      if (keycode === null) continue;
      const isSpecialNav =
        keycode === KEYCODE_DEL ||
        keycode === KEYCODE_FORWARD_DEL ||
        keycode === KEYCODE_ENTER ||
        keycode === KEYCODE_TAB ||
        keycode === KEYCODE_ESCAPE ||
        keycode === KEYCODE_DPAD_UP ||
        keycode === KEYCODE_DPAD_DOWN ||
        keycode === KEYCODE_DPAD_LEFT ||
        keycode === KEYCODE_DPAD_RIGHT ||
        keycode === KEYCODE_MOVE_HOME ||
        keycode === KEYCODE_MOVE_END ||
        keycode === KEYCODE_PAGE_UP ||
        keycode === KEYCODE_PAGE_DOWN ||
        keycode === KEYCODE_BACK;

      if (!isSpecialNav && !hasShortcutMod && !ev.modifiers.alt) {
        continue;
      }

      if (session) {
        session.sendControl(
          encodeKeycodeEvent({
            action: ev.action === 'down' ? AKEY_ACTION_DOWN : AKEY_ACTION_UP,
            keycode,
            metastate: androidMetaState(ev.modifiers),
          }),
        );
      } else if (ev.action === 'down') {
        await adbKey(serial, keycode);
      }
    }
  }
}

export async function injectAndroidKey(
  serial: string,
  keycode: number,
  session: ScrcpySession | null,
): Promise<void> {
  if (session) {
    const okDown = session.sendControl(encodeKeycodeEvent({ action: AKEY_ACTION_DOWN, keycode }));
    const okUp = session.sendControl(encodeKeycodeEvent({ action: AKEY_ACTION_UP, keycode }));
    if (okDown && okUp) return;
  }
  await adbKey(serial, keycode);
}
