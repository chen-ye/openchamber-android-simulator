import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { statSync } from 'node:fs';
import net from 'node:net';
import { execText, resolveBinaries, type BinaryPaths } from '../core/exec.ts';

export const SCRCPY_SERVER_VERSION = '5.0.1';

// Android MotionEvent / KeyEvent constants
export const AMOTION_ACTION_DOWN = 0;
export const AMOTION_ACTION_UP = 1;
export const AMOTION_ACTION_MOVE = 2;
export const AMOTION_BUTTON_PRIMARY = 1;

export const AKEY_ACTION_DOWN = 0;
export const AKEY_ACTION_UP = 1;

export const CONTROL_MSG_INJECT_KEYCODE = 0;
export const CONTROL_MSG_INJECT_TEXT = 1;
export const CONTROL_MSG_INJECT_TOUCH_EVENT = 2;
export const CONTROL_MSG_INJECT_SCROLL_EVENT = 3;
export const CONTROL_MSG_BACK_OR_SCREEN_ON = 4;
export const CONTROL_MSG_GET_CLIPBOARD = 8;
export const CONTROL_MSG_SET_CLIPBOARD = 9;
export const CONTROL_MSG_SET_DISPLAY_POWER = 10;
export const CONTROL_MSG_ROTATE_DEVICE = 11;

export function encodeTouchEvent(params: {
  action: 0 | 1 | 2;
  pointerId: bigint;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  pressure?: number;
  actionButton?: number;
  buttons?: number;
}): Buffer {
  const buf = Buffer.allocUnsafe(32);
  const w = Math.max(1, Math.min(0xffff, Math.round(params.screenWidth)));
  const h = Math.max(1, Math.min(0xffff, Math.round(params.screenHeight)));
  const x = Math.max(0, Math.min(w - 1, Math.round(params.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(params.y)));
  const pressure =
    params.pressure !== undefined
      ? Math.max(0, Math.min(0xffff, Math.round(params.pressure * 0xffff)))
      : params.action === AMOTION_ACTION_UP
        ? 0
        : 0xffff;

  buf.writeUInt8(CONTROL_MSG_INJECT_TOUCH_EVENT, 0);
  buf.writeUInt8(params.action, 1);
  buf.writeBigInt64BE(params.pointerId, 2);
  buf.writeInt32BE(x, 10);
  buf.writeInt32BE(y, 14);
  buf.writeUInt16BE(w, 18);
  buf.writeUInt16BE(h, 20);
  buf.writeUInt16BE(pressure, 22);
  buf.writeInt32BE(params.actionButton ?? (params.action === AMOTION_ACTION_MOVE ? 0 : AMOTION_BUTTON_PRIMARY), 24);
  buf.writeInt32BE(params.buttons ?? (params.action === AMOTION_ACTION_UP ? 0 : AMOTION_BUTTON_PRIMARY), 28);
  return buf;
}

export function encodeScrollEvent(params: {
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  hScroll: number;
  vScroll: number;
  buttons?: number;
}): Buffer {
  const buf = Buffer.allocUnsafe(21);
  const w = Math.max(1, Math.min(0xffff, Math.round(params.screenWidth)));
  const h = Math.max(1, Math.min(0xffff, Math.round(params.screenHeight)));
  const x = Math.max(0, Math.min(w - 1, Math.round(params.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(params.y)));
  const toFixed16 = (v: number): number => {
    const clamped = Math.max(-1, Math.min(1, v));
    return Math.max(-0x8000, Math.min(0x7fff, Math.round(clamped * 0x7fff)));
  };

  buf.writeUInt8(CONTROL_MSG_INJECT_SCROLL_EVENT, 0);
  buf.writeInt32BE(x, 1);
  buf.writeInt32BE(y, 5);
  buf.writeUInt16BE(w, 9);
  buf.writeUInt16BE(h, 11);
  buf.writeInt16BE(toFixed16(params.hScroll), 13);
  buf.writeInt16BE(toFixed16(params.vScroll), 15);
  buf.writeInt32BE(params.buttons ?? 0, 17);
  return buf;
}

export function encodeKeycodeEvent(params: {
  action: 0 | 1;
  keycode: number;
  repeat?: number;
  metastate?: number;
}): Buffer {
  const buf = Buffer.allocUnsafe(14);
  buf.writeUInt8(CONTROL_MSG_INJECT_KEYCODE, 0);
  buf.writeUInt8(params.action, 1);
  buf.writeInt32BE(params.keycode, 2);
  buf.writeInt32BE(params.repeat ?? 0, 6);
  buf.writeInt32BE(params.metastate ?? 0, 10);
  return buf;
}

export function encodeTextEvent(text: string): Buffer {
  const utf8 = Buffer.from(text, 'utf8');
  const buf = Buffer.allocUnsafe(5 + utf8.length);
  buf.writeUInt8(CONTROL_MSG_INJECT_TEXT, 0);
  buf.writeUInt32BE(utf8.length, 1);
  utf8.copy(buf, 5);
  return buf;
}

export function encodeSetClipboard(text: string, paste: boolean, sequence: bigint): Buffer {
  const utf8 = Buffer.from(text, 'utf8');
  const buf = Buffer.allocUnsafe(14 + utf8.length);
  buf.writeUInt8(CONTROL_MSG_SET_CLIPBOARD, 0);
  buf.writeBigInt64BE(sequence, 1);
  buf.writeUInt8(paste ? 1 : 0, 9);
  buf.writeUInt32BE(utf8.length, 10);
  utf8.copy(buf, 14);
  return buf;
}

export function encodeGetClipboard(copyKey: 0 | 1 | 2 = 1): Buffer {
  return Buffer.from([CONTROL_MSG_GET_CLIPBOARD, copyKey]);
}

export function encodeRotateDevice(): Buffer {
  return Buffer.from([CONTROL_MSG_ROTATE_DEVICE]);
}

export function encodeBackOrScreenOn(action: 0 | 1): Buffer {
  return Buffer.from([CONTROL_MSG_BACK_OR_SCREEN_ON, action]);
}

export type ScrcpyVideoPacket =
  | { readonly kind: 'session'; readonly width: number; readonly height: number }
  | {
      readonly kind: 'frame';
      readonly config: boolean;
      readonly keyframe: boolean;
      readonly pts: bigint;
      readonly payload: Buffer;
    };

export class ScrcpyVideoParser {
  private buf: Buffer = Buffer.alloc(0);
  private stage: 'dummy' | 'deviceMeta' | 'codecMeta' | 'packets' = 'dummy';
  private deviceName = '';
  private codecId = 0;

  push(chunk: Buffer): ScrcpyVideoPacket[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: ScrcpyVideoPacket[] = [];

    while (true) {
      if (this.stage === 'dummy') {
        if (this.buf.length < 1) break;
        this.buf = this.buf.subarray(1);
        this.stage = 'deviceMeta';
      }
      if (this.stage === 'deviceMeta') {
        if (this.buf.length < 64) break;
        const rawName = this.buf.subarray(0, 64);
        const nul = rawName.indexOf(0);
        this.deviceName = rawName.subarray(0, nul === -1 ? 64 : nul).toString('utf8');
        this.buf = this.buf.subarray(64);
        this.stage = 'codecMeta';
      }
      if (this.stage === 'codecMeta') {
        if (this.buf.length < 4) break;
        this.codecId = this.buf.readUInt32BE(0);
        this.buf = this.buf.subarray(4);
        this.stage = 'packets';
      }
      if (this.stage === 'packets') {
        if (this.buf.length < 12) break;
        const hi = this.buf.readUInt32BE(0);
        const lo = this.buf.readUInt32BE(4);
        const size = this.buf.readInt32BE(8);

        if ((hi & 0x80000000) !== 0) {
          // 5.0.1 Session Meta packet: 12 bytes total, 0 payload bytes
          this.buf = this.buf.subarray(12);
          out.push({ kind: 'session', width: lo, height: size });
          continue;
        }

        if (size < 0 || size > 32 * 1024 * 1024) {
          throw new Error(`Invalid scrcpy frame size: ${size}`);
        }
        if (this.buf.length < 12 + size) break;

        const payload = Buffer.from(this.buf.subarray(12, 12 + size));
        this.buf = this.buf.subarray(12 + size);
        const config = (hi & 0x40000000) !== 0;
        const keyframe = (hi & 0x20000000) !== 0;
        const pts = (BigInt(hi & 0x1fffffff) << 32n) | BigInt(lo);
        out.push({ kind: 'frame', config, keyframe, pts, payload });
      }
    }

    return out;
  }

  info(): { deviceName: string; codecId: number } {
    return { deviceName: this.deviceName, codecId: this.codecId };
  }
}

export class JpegFrameSplitter {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    while (true) {
      const soi = this.buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (soi === -1) {
        if (this.buf.length > 1) this.buf = this.buf.subarray(this.buf.length - 1);
        break;
      }
      if (soi > 0) this.buf = this.buf.subarray(soi);
      const eoi = this.buf.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (eoi === -1) break;
      const frame = Buffer.from(this.buf.subarray(0, eoi + 2));
      this.buf = this.buf.subarray(eoi + 2);
      frames.push(frame);
    }
    return frames;
  }
}

async function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function connectVideoSocketWithDummyRetry(
  port: number,
  timeoutMs: number,
): Promise<{ sock: net.Socket; initialChunk: Buffer }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const result = await new Promise<{ sock: net.Socket; initialChunk: Buffer }>(
        (resolve, reject) => {
          const s = net.createConnection({ host: '127.0.0.1', port });
          let settled = false;
          const finishErr = (err: Error) => {
            if (settled) return;
            settled = true;
            s.destroy();
            reject(err);
          };
          s.once('error', finishErr);
          s.once('close', () => {
            finishErr(new Error('adb forward closed before scrcpy-server dummy byte'));
          });
          s.once('data', (chunk: Buffer) => {
            if (settled) return;
            settled = true;
            s.off('error', finishErr);
            s.setNoDelay(true);
            resolve({ sock: s, initialChunk: chunk });
          });
        },
      );
      return result;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, 90));
    }
  }
  throw lastErr ?? new Error(`Timed out waiting for scrcpy video socket on port ${port}`);
}

async function connectSocketWithRetry(port: number, timeoutMs: number): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const sock = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection({ host: '127.0.0.1', port });
        const onErr = (err: Error) => {
          s.destroy();
          reject(err);
        };
        s.once('error', onErr);
        s.once('connect', () => {
          s.off('error', onErr);
          s.setNoDelay(true);
          resolve(s);
        });
      });
      return sock;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  throw lastErr ?? new Error(`Timed out connecting to scrcpy forward port ${port}`);
}

const pushedServerSizeCache = new Map<string, number>();

export interface ScrcpyClientCallbacks {
  readonly onFrame: (frame: { jpeg: Buffer; width: number; height: number }) => void;
  readonly onClipboard?: (text: string) => void;
  readonly onError?: (err: Error) => void;
  readonly onClose?: () => void;
}

export class ScrcpySession {
  readonly serial: string;
  readonly maxSize: number;
  private readonly bins: BinaryPaths;
  private readonly callbacks: ScrcpyClientCallbacks;
  private serverProc: ChildProcessWithoutNullStreams | null = null;
  private ffmpegProc: ChildProcessWithoutNullStreams | null = null;
  private videoSock: net.Socket | null = null;
  private controlSock: net.Socket | null = null;
  private localPort = 0;
  private closed = false;
  private streamWidth = 0;
  private streamHeight = 0;
  private controlReadBuf: Buffer = Buffer.alloc(0);
  private clipboardWaiters: Array<(text: string) => void> = [];
  private latestClipboard: string | null = null;
  private configHeader: Buffer | null = null;

  constructor(
    serial: string,
    maxSize: number,
    callbacks: ScrcpyClientCallbacks,
    bins: BinaryPaths = resolveBinaries(),
  ) {
    this.serial = serial;
    this.maxSize = maxSize;
    this.callbacks = callbacks;
    this.bins = bins;
  }

  dimensions(): { width: number; height: number } {
    return { width: this.streamWidth, height: this.streamHeight };
  }

  async start(): Promise<void> {
    if (!this.bins.adb || !this.bins.scrcpyServer || !this.bins.ffmpeg) {
      throw new Error('adb, scrcpy-server, and ffmpeg are all required for scrcpy streaming.');
    }

    const serverSize = statSync(this.bins.scrcpyServer).size;
    if (pushedServerSizeCache.get(this.serial) !== serverSize) {
      const pushRes = await execText(
        this.bins.adb,
        ['-s', this.serial, 'push', this.bins.scrcpyServer, '/data/local/tmp/scrcpy-server.jar'],
        { timeoutMs: 15_000 },
      );
      if (pushRes.code !== 0) {
        throw new Error(pushRes.stderr.trim() || 'Failed to push scrcpy-server.jar');
      }
      pushedServerSizeCache.set(this.serial, serverSize);
    }

    const scid = Math.floor(Math.random() * 0x7fffffff);
    const scidHex = scid.toString(16).padStart(8, '0');
    const port = await allocateFreePort();
    this.localPort = port;

    const fwdRes = await execText(
      this.bins.adb,
      ['-s', this.serial, 'forward', `tcp:${port}`, `localabstract:scrcpy_${scidHex}`],
      { timeoutMs: 5000 },
    );
    if (fwdRes.code !== 0) {
      throw new Error(fwdRes.stderr.trim() || 'adb forward failed');
    }

    const serverArgs = [
      '-s',
      this.serial,
      'shell',
      `CLASSPATH=/data/local/tmp/scrcpy-server.jar`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SCRCPY_SERVER_VERSION,
      `scid=${scidHex}`,
      'tunnel_forward=true',
      'video=true',
      'audio=false',
      'control=true',
      'video_codec=h264',
      `max_size=${this.maxSize}`,
      'max_fps=30',
      'video_bit_rate=4000000',
      'send_dummy_byte=true',
      'send_device_meta=true',
      'send_stream_meta=true',
      'send_frame_meta=true',
      'stay_awake=true',
      'power_on=false',
      'cleanup=true',
    ];

    const proc = spawn(this.bins.adb, serverArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.serverProc = proc;
    let stderrTail = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString('utf8')).slice(-1000);
    });
    proc.on('exit', (code) => {
      if (!this.closed) {
        this.callbacks.onError?.(
          new Error(stderrTail.trim() || `scrcpy-server exited (${code ?? 'signal'})`),
        );
        void this.stop();
      }
    });

    // Wait for LocalServerSocket + dummy byte (retries automatically if adb forward closes early)
    const { sock: videoSock, initialChunk } = await connectVideoSocketWithDummyRetry(port, 6000);
    if (this.closed) {
      videoSock.destroy();
      return;
    }
    this.videoSock = videoSock;

    const controlSock = await connectSocketWithRetry(port, 3000);
    if (this.closed) {
      controlSock.destroy();
      return;
    }
    this.controlSock = controlSock;
    this.wireControlReader(controlSock);
    this.wireVideoReader(videoSock, initialChunk);
  }

  private restartDecoder(width: number, height: number): ChildProcessWithoutNullStreams | null {
    if (this.ffmpegProc) {
      try {
        this.ffmpegProc.stdin.end();
        this.ffmpegProc.kill('SIGKILL');
      } catch {
        // ignore
      }
      this.ffmpegProc = null;
    }
    if (this.closed || !this.bins.ffmpeg) return null;

    const proc = spawn(
      this.bins.ffmpeg,
      [
        '-v',
        'error',
        '-flags',
        'low_delay',
        '-probesize',
        '4096',
        '-analyzeduration',
        '100000',
        '-threads',
        '1',
        '-f',
        'h264',
        '-i',
        'pipe:0',
        '-strict',
        'unofficial',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        '-q:v',
        '5',
        '-flush_packets',
        '1',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.ffmpegProc = proc;

    const splitter = new JpegFrameSplitter();
    proc.stdout.on('data', (chunk: Buffer) => {
      for (const jpeg of splitter.push(chunk)) {
        if (this.closed) return;
        this.callbacks.onFrame({
          jpeg,
          width: this.streamWidth || width,
          height: this.streamHeight || height,
        });
      }
    });
    proc.stdin.on('error', () => {
      // ignore EPIPE on restart/stop
    });
    proc.on('error', (err) => {
      if (!this.closed) this.callbacks.onError?.(err);
    });
    return proc;
  }

  private wireVideoReader(sock: net.Socket, initialChunk?: Buffer): void {
    const parser = new ScrcpyVideoParser();
    const handleChunk = (chunk: Buffer) => {
      if (this.closed) return;
      try {
        const packets = parser.push(chunk);
        for (const pkt of packets) {
          if (pkt.kind === 'session') {
            const changed = pkt.width !== this.streamWidth || pkt.height !== this.streamHeight;
            this.streamWidth = pkt.width;
            this.streamHeight = pkt.height;
            if (changed || !this.ffmpegProc) {
              this.configHeader = null;
              this.restartDecoder(pkt.width, pkt.height);
            }
          } else {
            if (pkt.config) {
              this.configHeader = pkt.payload;
            }
            let dec = this.ffmpegProc;
            if (!dec && this.streamWidth > 0 && this.streamHeight > 0) {
              dec = this.restartDecoder(this.streamWidth, this.streamHeight);
              if (!pkt.config && this.configHeader && dec) {
                dec.stdin.write(this.configHeader);
              }
            }
            dec?.stdin.write(pkt.payload);
          }
        }
      } catch (err) {
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
        void this.stop();
      }
    };
    if (initialChunk && initialChunk.length > 0) {
      handleChunk(initialChunk);
    }
    sock.on('data', handleChunk);
    sock.on('error', (err) => {
      if (!this.closed) this.callbacks.onError?.(err);
    });
    sock.on('close', () => {
      if (!this.closed) void this.stop();
    });
  }

  private wireControlReader(sock: net.Socket): void {
    sock.on('data', (chunk: Buffer) => {
      this.controlReadBuf =
        this.controlReadBuf.length === 0 ? chunk : Buffer.concat([this.controlReadBuf, chunk]);
      while (this.controlReadBuf.length >= 1) {
        const type = this.controlReadBuf.readUInt8(0);
        if (type === 0) {
          // TYPE_CLIPBOARD: u8 type + u32 len + utf8
          if (this.controlReadBuf.length < 5) break;
          const len = this.controlReadBuf.readUInt32BE(1);
          if (this.controlReadBuf.length < 5 + len) break;
          const text = this.controlReadBuf.subarray(5, 5 + len).toString('utf8');
          this.controlReadBuf = this.controlReadBuf.subarray(5 + len);
          this.latestClipboard = text;
          this.callbacks.onClipboard?.(text);
          while (this.clipboardWaiters.length > 0) {
            const w = this.clipboardWaiters.shift();
            w?.(text);
          }
        } else if (type === 1) {
          // TYPE_ACK_CLIPBOARD: u8 type + i64 sequence
          if (this.controlReadBuf.length < 9) break;
          this.controlReadBuf = this.controlReadBuf.subarray(9);
        } else if (type === 2) {
          // TYPE_UHID_OUTPUT: u8 type + u16 id + u16 size + bytes
          if (this.controlReadBuf.length < 5) break;
          const size = this.controlReadBuf.readUInt16BE(3);
          if (this.controlReadBuf.length < 5 + size) break;
          this.controlReadBuf = this.controlReadBuf.subarray(5 + size);
        } else {
          // Unknown message type: discard buffer to avoid loop
          this.controlReadBuf = Buffer.alloc(0);
          break;
        }
      }
    });
    sock.on('error', () => {
      // handled by video close
    });
  }

  sendControl(buf: Buffer): boolean {
    if (this.closed || !this.controlSock || this.controlSock.destroyed) return false;
    try {
      this.controlSock.write(buf);
      return true;
    } catch {
      return false;
    }
  }

  async fetchClipboard(timeoutMs = 800): Promise<string | null> {
    if (this.closed || !this.controlSock || this.controlSock.destroyed) return this.latestClipboard;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.clipboardWaiters.indexOf(onClip);
        if (idx !== -1) this.clipboardWaiters.splice(idx, 1);
        resolve(this.latestClipboard);
      }, timeoutMs);
      const onClip = (text: string) => {
        clearTimeout(timer);
        resolve(text);
      };
      this.clipboardWaiters.push(onClip);
      this.sendControl(encodeGetClipboard(1));
    });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    try {
      this.videoSock?.destroy();
    } catch {
      // ignore
    }
    try {
      this.controlSock?.destroy();
    } catch {
      // ignore
    }
    try {
      this.ffmpegProc?.stdin.end();
      this.ffmpegProc?.kill('SIGKILL');
    } catch {
      // ignore
    }
    try {
      this.serverProc?.kill('SIGKILL');
    } catch {
      // ignore
    }

    if (this.localPort > 0 && this.bins.adb) {
      await execText(this.bins.adb, ['-s', this.serial, 'forward', '--remove', `tcp:${this.localPort}`], {
        timeoutMs: 2000,
      }).catch(() => undefined);
    }

    this.callbacks.onClose?.();
  }
}
