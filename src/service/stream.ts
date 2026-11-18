import { deflateSync } from 'node:zlib';
import { queryScreenSize, screencapPng } from '../core/adb.ts';
import { resolveBinaries } from '../core/exec.ts';
import { qualityMaxSize, type QualityPreset, type StreamStatus } from '../shared/types.ts';
import { ScrcpySession } from './scrcpy.ts';

export interface EncodedFrame {
  readonly seq: number;
  readonly mime: 'image/jpeg' | 'image/png';
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly placeholder: boolean;
}

// Pure Node CRC32 + solid RGBA PNG builder for idle/off placeholder frames
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

export function buildSolidPng(width: number, height: number, rgbHex: number): Buffer {
  const r = (rgbHex >> 16) & 0xff;
  const g = (rgbHex >> 8) & 0xff;
  const b = rgbHex & 0xff;
  const stride = 1 + width * 4;
  const raw = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter None
    for (let x = 0; x < width; x += 1) {
      const p = row + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = 255;
    }
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const DEFAULT_PLACEHOLDER = buildSolidPng(360, 780, 0x18181b);

export class DeviceStream {
  readonly serial: string;
  private readonly allocSeq: () => number;
  private quality: QualityPreset;
  private title: string;
  private scrcpy: ScrcpySession | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private mode: StreamStatus['mode'] = 'off';
  private error: string | null = null;
  private running = false;
  private latest: EncodedFrame | null = null;
  private waiters = new Set<() => void>();
  private frameTimestamps: number[] = [];
  private lastViewerPollAt = 0;
  private startingPromise: Promise<void> | null = null;

  constructor(serial: string, quality: QualityPreset, title: string, allocSeq: () => number) {
    this.serial = serial;
    this.quality = quality;
    this.title = title;
    this.allocSeq = allocSeq;
  }

  getScrcpySession(): ScrcpySession | null {
    return this.scrcpy;
  }

  getQuality(): QualityPreset {
    return this.quality;
  }

  setTitle(title: string): void {
    this.title = title;
  }

  current(): EncodedFrame | null {
    return this.latest;
  }

  status(): StreamStatus {
    const now = Date.now();
    const recent = this.frameTimestamps.filter((t) => now - t <= 2000);
    this.frameTimestamps = recent;
    const fps = recent.length > 0 ? Math.round((recent.length / 2) * 10) / 10 : 0;
    return {
      running: this.running,
      mode: this.mode,
      width: this.latest?.width ?? 0,
      height: this.latest?.height ?? 0,
      fps,
      error: this.error,
    };
  }

  touchViewer(): void {
    this.lastViewerPollAt = Date.now();
    this.ensureIdleCheck();
  }

  private ensureIdleCheck(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      if (this.running && this.lastViewerPollAt > 0 && Date.now() - this.lastViewerPollAt > 45_000) {
        void this.stop();
      }
    }, 10_000);
    this.idleTimer.unref();
  }

  async ensureStarted(quality?: QualityPreset): Promise<void> {
    this.touchViewer();
    if (quality && quality !== this.quality) {
      this.quality = quality;
      await this.stop();
    }
    if (this.running) return;
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = this.startInternal().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  private async startInternal(): Promise<void> {
    this.error = null;
    const bins = resolveBinaries();

    if (bins.adb && bins.scrcpyServer && bins.ffmpeg) {
      try {
        const session = new ScrcpySession(
          this.serial,
          qualityMaxSize(this.quality),
          {
            onFrame: ({ jpeg, width, height }) => {
              this.mode = 'scrcpy';
              this.running = true;
              this.error = null;
              this.publishFrame('image/jpeg', jpeg, width, height, false);
            },
            onError: (err) => {
              this.error = err.message;
            },
            onClose: () => {
              if (this.scrcpy === session) {
                this.scrcpy = null;
                this.running = false;
                this.mode = 'off';
              }
            },
          },
          bins,
        );
        this.scrcpy = session;
        this.running = true;
        this.mode = 'scrcpy';
        await session.start();

        // Seed an immediate initial frame via screencap if scrcpy hasn't emitted yet (static screen)
        setTimeout(() => {
          if (this.running && !this.latest) {
            void this.captureSingleFallbackFrame();
          }
        }, 450);
        return;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        await this.scrcpy?.stop();
        this.scrcpy = null;
      }
    }

    // Fallback: periodic adb screencap polling
    this.startScreencapFallback();
  }

  private async captureSingleFallbackFrame(): Promise<void> {
    try {
      const [png, size] = await Promise.all([
        screencapPng(this.serial),
        queryScreenSize(this.serial),
      ]);
      const w = size?.width ?? (png.length >= 24 ? png.readUInt32BE(16) : 1080);
      const h = size?.height ?? (png.length >= 24 ? png.readUInt32BE(20) : 2400);
      if (!this.latest) {
        this.publishFrame('image/png', png, w, h, false);
      }
    } catch {
      // ignore if scrcpy already delivered or device closed
    }
  }

  private startScreencapFallback(): void {
    if (this.fallbackTimer) return;
    this.running = true;
    this.mode = 'screencap';
    let inFlight = false;
    const tick = async () => {
      if (inFlight || !this.running) return;
      inFlight = true;
      try {
        const png = await screencapPng(this.serial);
        const w = png.length >= 24 ? png.readUInt32BE(16) : 1080;
        const h = png.length >= 24 ? png.readUInt32BE(20) : 2400;
        this.error = null;
        this.publishFrame('image/png', png, w, h, false);
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        inFlight = false;
      }
    };
    void tick();
    this.fallbackTimer = setInterval(() => void tick(), 450);
    this.fallbackTimer.unref();
  }

  private publishFrame(
    mime: 'image/jpeg' | 'image/png',
    bytes: Buffer,
    width: number,
    height: number,
    placeholder: boolean,
  ): void {
    const seq = this.allocSeq();
    this.frameTimestamps.push(Date.now());
    this.latest = {
      seq,
      mime,
      bytes,
      width,
      height,
      title: this.title,
      placeholder,
    };
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  async waitForFrame(afterSeq: number, waitMs: number, abortSignal?: AbortSignal): Promise<EncodedFrame | null> {
    this.touchViewer();
    if (this.latest && this.latest.seq > afterSeq) {
      return this.latest;
    }
    if (waitMs <= 0) return null;

    return new Promise((resolve) => {
      const done = (frame: EncodedFrame | null) => {
        clearTimeout(timer);
        this.waiters.delete(onWake);
        abortSignal?.removeEventListener('abort', onAbort);
        resolve(frame);
      };
      const onWake = () => {
        if (this.latest && this.latest.seq > afterSeq) done(this.latest);
      };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), waitMs);
      this.waiters.add(onWake);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.mode = 'off';
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const s = this.scrcpy;
    this.scrcpy = null;
    await s?.stop();
  }
}

export class StreamManager {
  private readonly streams = new Map<string, DeviceStream>();
  private nextSeq = 0;

  allocSeq = (): number => {
    this.nextSeq += 1;
    return this.nextSeq;
  };

  get(serial: string): DeviceStream | null {
    return this.streams.get(serial) ?? null;
  }

  getOrCreate(serial: string, quality: QualityPreset, title: string): DeviceStream {
    let stream = this.streams.get(serial);
    if (!stream) {
      stream = new DeviceStream(serial, quality, title, this.allocSeq);
      this.streams.set(serial, stream);
    } else {
      stream.setTitle(title);
    }
    return stream;
  }

  placeholderFrame(title: string): EncodedFrame {
    return {
      seq: this.allocSeq(),
      mime: 'image/png',
      bytes: DEFAULT_PLACEHOLDER,
      width: 360,
      height: 780,
      title,
      placeholder: true,
    };
  }

  async stopAllExcept(keepSerials: ReadonlySet<string>): Promise<void> {
    for (const [serial, stream] of this.streams) {
      if (!keepSerials.has(serial)) {
        this.streams.delete(serial);
        await stream.stop();
      }
    }
  }

  async stop(serial: string): Promise<void> {
    const stream = this.streams.get(serial);
    if (!stream) return;
    this.streams.delete(serial);
    await stream.stop();
  }

  async stopAll(): Promise<void> {
    const all = [...this.streams.values()];
    this.streams.clear();
    await Promise.all(all.map((s) => s.stop()));
  }
}
