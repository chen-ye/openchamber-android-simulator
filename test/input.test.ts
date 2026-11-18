import { describe, expect, test } from 'bun:test';
import {
  isAsciiPrintable,
  KEYCODE_BACK,
  KEYCODE_DEL,
  KEYCODE_ENTER,
  mapWebKeyToAndroidKeycode,
} from '../src/service/input.ts';
import { buildSolidPng } from '../src/service/stream.ts';

describe('Android input mapping', () => {
  test('maps web keys and codes to Android KeyEvent codes', () => {
    expect(mapWebKeyToAndroidKeycode({ key: 'Enter', code: 'Enter' })).toBe(KEYCODE_ENTER);
    expect(mapWebKeyToAndroidKeycode({ key: 'Backspace', code: 'Backspace' })).toBe(KEYCODE_DEL);
    expect(mapWebKeyToAndroidKeycode({ key: 'BrowserBack', code: 'BrowserBack' })).toBe(KEYCODE_BACK);
    expect(mapWebKeyToAndroidKeycode({ key: 'a', code: 'KeyA' })).toBe(29);
    expect(mapWebKeyToAndroidKeycode({ key: '9', code: 'Digit9' })).toBe(16);
  });

  test('detects ASCII printable strings cleanly', () => {
    expect(isAsciiPrintable('hello world!')).toBe(true);
    expect(isAsciiPrintable('café')).toBe(false);
    expect(isAsciiPrintable('line1\nline2')).toBe(false);
    expect(isAsciiPrintable('')).toBe(false);
  });
});

describe('buildSolidPng', () => {
  test('produces a valid PNG header and expected dimensions', () => {
    const png = buildSolidPng(360, 780, 0x18181b);
    expect(png.readUInt32BE(0)).toBe(0x89504e47);
    expect(png.readUInt32BE(16)).toBe(360);
    expect(png.readUInt32BE(20)).toBe(780);
  });
});
