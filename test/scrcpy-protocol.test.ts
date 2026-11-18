import { describe, expect, test } from 'bun:test';
import {
  AMOTION_ACTION_DOWN,
  AMOTION_ACTION_UP,
  encodeGetClipboard,
  encodeKeycodeEvent,
  encodeRotateDevice,
  encodeScrollEvent,
  encodeSetClipboard,
  encodeTextEvent,
  encodeTouchEvent,
  JpegFrameSplitter,
  ScrcpyVideoParser,
} from '../src/service/scrcpy.ts';

describe('scrcpy 5.0.1 binary protocol encoders', () => {
  test('encodes 32-byte touch event in big-endian', () => {
    const down = encodeTouchEvent({
      action: AMOTION_ACTION_DOWN,
      pointerId: 1n,
      x: 540,
      y: 1200,
      screenWidth: 1080,
      screenHeight: 2400,
    });
    expect(down.length).toBe(32);
    expect(down.readUInt8(0)).toBe(2);
    expect(down.readUInt8(1)).toBe(0);
    expect(down.readBigInt64BE(2)).toBe(1n);
    expect(down.readInt32BE(10)).toBe(540);
    expect(down.readInt32BE(14)).toBe(1200);
    expect(down.readUInt16BE(18)).toBe(1080);
    expect(down.readUInt16BE(20)).toBe(2400);
    expect(down.readUInt16BE(22)).toBe(0xffff);
    expect(down.readInt32BE(24)).toBe(1);
    expect(down.readInt32BE(28)).toBe(1);

    const up = encodeTouchEvent({
      action: AMOTION_ACTION_UP,
      pointerId: 1n,
      x: 540,
      y: 1200,
      screenWidth: 1080,
      screenHeight: 2400,
    });
    expect(up.readUInt8(1)).toBe(1);
    expect(up.readUInt16BE(22)).toBe(0);
    expect(up.readInt32BE(28)).toBe(0);
  });

  test('encodes 21-byte scroll event and clamps normalized scroll', () => {
    const buf = encodeScrollEvent({
      x: 100,
      y: 200,
      screenWidth: 1080,
      screenHeight: 2400,
      hScroll: 2.5,
      vScroll: -0.5,
    });
    expect(buf.length).toBe(21);
    expect(buf.readUInt8(0)).toBe(3);
    expect(buf.readInt16BE(13)).toBe(0x7fff);
    expect(buf.readInt16BE(15)).toBe(Math.round(-0.5 * 0x7fff));
  });

  test('encodes keycode, text, clipboard, and rotate messages', () => {
    const key = encodeKeycodeEvent({ action: 0, keycode: 4, metastate: 1 });
    expect(key.length).toBe(14);
    expect(key.readInt32BE(2)).toBe(4);
    expect(key.readInt32BE(10)).toBe(1);

    const text = encodeTextEvent('hello');
    expect(text.length).toBe(10);
    expect(text.readUInt32BE(1)).toBe(5);
    expect(text.subarray(5).toString('utf8')).toBe('hello');

    const clip = encodeSetClipboard('hi', true, 42n);
    expect(clip.length).toBe(16);
    expect(clip.readBigInt64BE(1)).toBe(42n);
    expect(clip.readUInt8(9)).toBe(1);
    expect(clip.readUInt32BE(10)).toBe(2);

    expect(encodeGetClipboard(1)).toEqual(Buffer.from([8, 1]));
    expect(encodeRotateDevice()).toEqual(Buffer.from([11]));
  });
});

describe('ScrcpyVideoParser 5.0.1 handshake + session meta + frames', () => {
  test('parses split chunks across dummy byte, 64B name, 4B codec, session meta, and frame', () => {
    const parser = new ScrcpyVideoParser();

    const dummy = Buffer.from([0x00]);
    const name = Buffer.alloc(64);
    Buffer.from('Pixel_8_API_35').copy(name);
    const codec = Buffer.from('h264', 'ascii');

    const sessionMeta = Buffer.alloc(12);
    sessionMeta.writeUInt32BE(0x80000000, 0);
    sessionMeta.writeInt32BE(540, 4);
    sessionMeta.writeInt32BE(1200, 8);

    const payload = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);
    const frameMeta = Buffer.alloc(12);
    frameMeta.writeUInt32BE(0x40000000, 0); // PACKET_FLAG_CONFIG
    frameMeta.writeUInt32BE(0, 4);
    frameMeta.writeInt32BE(payload.length, 8);

    const stream = Buffer.concat([dummy, name, codec, sessionMeta, frameMeta, payload]);
    // Feed in awkward small slices
    const packets = [
      ...parser.push(stream.subarray(0, 10)),
      ...parser.push(stream.subarray(10, 75)),
      ...parser.push(stream.subarray(75)),
    ];

    expect(parser.info().deviceName).toBe('Pixel_8_API_35');
    expect(parser.info().codecId).toBe(0x68323634);
    expect(packets).toHaveLength(2);
    expect(packets[0]).toEqual({ kind: 'session', width: 540, height: 1200 });
    expect(packets[1]?.kind).toBe('frame');
    if (packets[1]?.kind === 'frame') {
      expect(packets[1].config).toBe(true);
      expect(packets[1].payload).toEqual(payload);
    }
  });
});

describe('JpegFrameSplitter', () => {
  test('extracts multiple JPEG images split across arbitrary buffer boundaries', () => {
    const splitter = new JpegFrameSplitter();
    const img1 = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
    const img2 = Buffer.from([0xff, 0xd8, 0x33, 0x44, 0x55, 0xff, 0xd9]);
    const combined = Buffer.concat([Buffer.from([0x00]), img1, img2]);

    const a = splitter.push(combined.subarray(0, 4));
    const b = splitter.push(combined.subarray(4, 10));
    const c = splitter.push(combined.subarray(10));

    expect([...a, ...b, ...c]).toEqual([img1, img2]);
  });
});
