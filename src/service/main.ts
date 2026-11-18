import http from 'node:http';
import {
  createServiceHost,
  readSurfaceControlNotice,
  readSurfaceInputBatch,
  readSurfaceResizeRequest,
  SURFACE_AGENT_ACTIVE_HEADER,
  SURFACE_AGENT_HOLD_MS,
  SURFACE_CLIPBOARD_PATH,
  SURFACE_CONTROL_PATH,
  SURFACE_FRAME_MAX_BYTES,
  SURFACE_FRAME_PATH,
  SURFACE_FRAME_SEQ_HEADER,
  SURFACE_FRAME_WAIT_MS,
  SURFACE_HEIGHT_HEADER,
  SURFACE_INPUT_PATH,
  SURFACE_RESIZE_PATH,
  SURFACE_SEQ_HEADER,
  SURFACE_TITLE_HEADER,
  SURFACE_TITLE_MAX,
  SURFACE_WIDTH_HEADER,
  type SurfaceController,
} from '@openchamber/sdk';
import {
  bootAvd,
  discoverDevices,
  getAppearance,
  getRotation,
  installApk,
  openUrl,
  setAppearance,
  setRotation,
  shutdownDevice,
} from '../core/adb.ts';
import { executeAgentTool } from '../core/controller.ts';
import { resolveBinaries } from '../core/exec.ts';
import { type AgentToolRequest } from '../shared/protocol.ts';
import {
  BLOB_CHUNK,
  type AndroidDevice,
  type AppearanceMode,
  type BlobRef,
  type PageFrame,
  type QualityPreset,
  type RotationDegrees,
  type SimulatorState,
} from '../shared/types.ts';
import {
  AMOTION_ACTION_DOWN,
  AMOTION_ACTION_UP,
  encodeTextEvent,
  encodeTouchEvent,
} from './scrcpy.ts';
import {
  DeviceInputState,
  dispatchSurfaceEvents,
  injectAndroidKey,
  KEYCODE_APP_SWITCH,
  KEYCODE_BACK,
  KEYCODE_HOME,
  KEYCODE_POWER,
  KEYCODE_VOLUME_DOWN,
  KEYCODE_VOLUME_UP,
} from './input.ts';
import { clearServiceDiscovery, writeServiceDiscovery } from './state-file.ts';
import { buildStatusView } from './status.ts';
import { StreamManager } from './stream.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? '0');
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
const host = createServiceHost({ env: process.env });

const streams = new StreamManager();
const surfaceInputState = new DeviceInputState();
const pageInputStates = new Map<string, DeviceInputState>();
const bootingAvds = new Set<string>();

let devicesCache: AndroidDevice[] = [];
let selectedId: string | null = null;
let quality: QualityPreset = 'balanced';
let framed = true;
let cachedAppearance: AppearanceMode | null = null;
let cachedRotation: RotationDegrees = 0;
let surfaceController: SurfaceController = 'none';
let agentActiveUntil = 0;
let lastAction: { message: string; at: number } | null = null;
let lastInstructionsText = '';

const placeholderWaiters = new Set<() => void>();
let lastPlaceholderKey = '';
let lastPlaceholderSeq = 0;

// 8-entry LRU blob map for chunked /page/frame delivery under 256 KB serviceRequest limit
const blobs = new Map<string, string>();
const BLOBS_MAX = 8;

function putBlob(id: string, base64: string): BlobRef {
  blobs.delete(id);
  blobs.set(id, base64);
  while (blobs.size > BLOBS_MAX) {
    const oldest = blobs.keys().next().value;
    if (!oldest) break;
    blobs.delete(oldest);
  }
  return { id, length: base64.length };
}

function pageInputOf(serial: string): DeviceInputState {
  let st = pageInputStates.get(serial);
  if (!st) {
    st = new DeviceInputState();
    pageInputStates.set(serial, st);
  }
  return st;
}

function wakePlaceholderWaiters(): void {
  lastPlaceholderKey = '';
  for (const wake of placeholderWaiters) wake();
  placeholderWaiters.clear();
}

function noteAction(message: string): void {
  lastAction = { message, at: Date.now() };
}

function pickActiveDevice(devices: readonly AndroidDevice[]): AndroidDevice | null {
  if (selectedId) {
    const match = devices.find((d) => d.id === selectedId || d.serial === selectedId);
    if (match) return match;
    if (selectedId.startsWith('avd:')) {
      const avd = selectedId.slice(4);
      const running = devices.find((d) => d.avdName === avd);
      if (running) {
        selectedId = running.id;
        return running;
      }
    }
  }
  const booted = devices.find((d) => d.state === 'booted');
  if (booted) {
    selectedId = booted.id;
    return booted;
  }
  const first = devices[0] ?? null;
  if (first) selectedId = first.id;
  return first;
}

async function refreshDevices(syncMetadata = false): Promise<AndroidDevice[]> {
  const next = await discoverDevices(bootingAvds);
  devicesCache = next;
  const active = pickActiveDevice(next);
  if (syncMetadata && active?.state === 'booted' && active.serial) {
    const [app, rot] = await Promise.all([
      getAppearance(active.serial),
      getRotation(active.serial),
    ]);
    cachedAppearance = app;
    cachedRotation = rot;
  }
  const bootedIds = new Set(
    next.filter((d) => d.state === 'booted' && d.serial).map((d) => d.serial!),
  );
  for (const d of next) {
    if (d.state === 'booted' && d.serial) {
      streams.get(d.serial)?.setTitle(d.label);
    }
  }
  // Clean up streams for devices that vanished
  for (const existing of [...pageInputStates.keys()]) {
    if (!bootedIds.has(existing)) pageInputStates.delete(existing);
  }
  void updateAgentInstructions(next);
  return next;
}

async function updateAgentInstructions(devices: readonly AndroidDevice[]): Promise<void> {
  const summary =
    devices.length === 0
      ? 'Android Simulator extension active; no AVDs or ADB devices currently detected.'
      : `Android Simulator devices (${devices.map((d) => `${d.avdName ?? d.serial ?? d.id} [${d.state}${d.serial ? `, ${d.serial}` : ''}]`).join('; ')}). Use android_device, android_input, and android_inspect tools.`;
  const text = summary.slice(0, 4000);
  if (text === lastInstructionsText) return;
  lastInstructionsText = text;
  await host.setInstructions(null, text).catch(() => undefined);
}

function buildStateSnapshot(targetId?: string | null): SimulatorState {
  const bins = resolveBinaries();
  const active = targetId
    ? devicesCache.find((d) => d.id === targetId || d.serial === targetId) ?? null
    : pickActiveDevice(devicesCache);
  const stream = active?.serial ? streams.get(active.serial) : null;
  return {
    devices: devicesCache,
    selectedId: active?.id ?? selectedId,
    active,
    stream: stream?.status() ?? {
      running: false,
      mode: 'off',
      width: active?.screenWidth ?? 0,
      height: active?.screenHeight ?? 0,
      fps: 0,
      error: null,
    },
    quality,
    framed,
    appearance: cachedAppearance,
    rotation: cachedRotation,
    agentActive: Date.now() < agentActiveUntil,
    toolsAvailable: {
      adb: Boolean(bins.adb),
      emulator: Boolean(bins.emulator),
      scrcpyServer: Boolean(bins.scrcpyServer),
      ffmpeg: Boolean(bins.ffmpeg),
    },
    lastAction,
  };
}

function resolveSerialTarget(bodySerial?: unknown): string {
  if (typeof bodySerial === 'string' && bodySerial.trim()) {
    const wanted = bodySerial.trim();
    const match = devicesCache.find((d) => d.id === wanted || d.serial === wanted);
    if (match?.serial) return match.serial;
    if (!wanted.startsWith('avd:')) return wanted;
  }
  const active = pickActiveDevice(devicesCache);
  if (!active?.serial || active.state !== 'booted') {
    throw new Error('No booted Android device selected.');
  }
  return active.serial;
}

function sanitizeTitle(title: string): string {
  return title.replace(/[^\x20-\x7e]/g, '').slice(0, SURFACE_TITLE_MAX) || 'Android';
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function handleSurfaceFrame(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0;
  const reqWait = Number.parseInt(url.searchParams.get('wait') ?? '0', 10) || 0;
  const waitMs = Math.max(0, Math.min(SURFACE_FRAME_WAIT_MS, reqWait));

  if (devicesCache.length === 0) {
    await refreshDevices(false);
  }

  const active = pickActiveDevice(devicesCache);
  const abortCtrl = new AbortController();
  res.on('close', () => abortCtrl.abort());

  if (!active || active.state !== 'booted' || !active.serial) {
    const title = active ? `${active.label} (${active.state})` : 'No Android device';
    const key = `${active?.id ?? 'none'}:${active?.state ?? 'none'}`;
    if (after === 0 || key !== lastPlaceholderKey || after < lastPlaceholderSeq) {
      const frame = streams.placeholderFrame(title);
      lastPlaceholderKey = key;
      lastPlaceholderSeq = frame.seq;
      const headers: Record<string, string | number> = {
        'Content-Type': frame.mime,
        'Content-Length': frame.bytes.length,
        'Cache-Control': 'no-store',
        [SURFACE_SEQ_HEADER]: String(frame.seq),
        [SURFACE_WIDTH_HEADER]: String(frame.width),
        [SURFACE_HEIGHT_HEADER]: String(frame.height),
        [SURFACE_TITLE_HEADER]: sanitizeTitle(frame.title),
      };
      res.writeHead(200, headers);
      res.end(frame.bytes);
      return;
    }

    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          placeholderWaiters.delete(done);
          abortCtrl.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(waitMs, 4000));
        placeholderWaiters.add(done);
        abortCtrl.signal.addEventListener('abort', done, { once: true });
      });
    }
    res.writeHead(204).end();
    return;
  }

  const stream = streams.getOrCreate(active.serial, quality, active.label);
  await stream.ensureStarted(quality);
  const frame = await stream.waitForFrame(after, waitMs, abortCtrl.signal);
  if (!frame || frame.bytes.length > SURFACE_FRAME_MAX_BYTES) {
    res.writeHead(204).end();
    return;
  }

  const headers: Record<string, string | number> = {
    'Content-Type': frame.mime,
    'Content-Length': frame.bytes.length,
    'Cache-Control': 'no-store',
    [SURFACE_SEQ_HEADER]: String(frame.seq),
    [SURFACE_WIDTH_HEADER]: String(frame.width),
    [SURFACE_HEIGHT_HEADER]: String(frame.height),
    [SURFACE_TITLE_HEADER]: sanitizeTitle(frame.title),
  };
  if (Date.now() < agentActiveUntil) {
    headers[SURFACE_AGENT_ACTIVE_HEADER] = '1';
  }
  res.writeHead(200, headers);
  res.end(frame.bytes);
}

async function handleSurfaceInput(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const batch = readSurfaceInputBatch(raw);
  if (!batch) {
    json(res, 400, { error: 'Invalid input batch' });
    return;
  }

  const active = pickActiveDevice(devicesCache);
  if (!active || active.state !== 'booted' || !active.serial) {
    json(res, 409, { error: 'No booted Android device' });
    return;
  }

  const stream = streams.get(active.serial);
  const current = stream?.current();
  if (!stream || !current || current.placeholder) {
    json(res, 409, { error: 'No simulator picture yet' });
    return;
  }

  const clientSeqHeader = req.headers[SURFACE_FRAME_SEQ_HEADER];
  const clientSeq = typeof clientSeqHeader === 'string' ? Number.parseInt(clientSeqHeader, 10) : 0;
  if (clientSeq > 0 && current.seq > 0 && Math.abs(current.seq - clientSeq) > 120) {
    // Only reject if completely stale across a rotation/size change
    json(res, 409, { error: 'Stale frame' });
    return;
  }

  await dispatchSurfaceEvents({
    events: batch.events,
    session: stream.getScrcpySession(),
    serial: active.serial,
    screenWidth: current.width,
    screenHeight: current.height,
    state: surfaceInputState,
  });

  res.writeHead(204).end();
}

async function handlePageFrame(res: http.ServerResponse, url: URL): Promise<void> {
  const serialParam = url.searchParams.get('serial') ?? '';
  const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0;
  const reqWait = Number.parseInt(url.searchParams.get('wait') ?? '0', 10) || 0;
  const waitMs = Math.max(0, Math.min(10_000, reqWait));

  if (devicesCache.length === 0) {
    await refreshDevices(false);
  }
  const target = devicesCache.find(
    (d) => d.id === serialParam || d.serial === serialParam,
  );
  if (!target || target.state !== 'booted' || !target.serial) {
    res.writeHead(204).end();
    return;
  }

  const abortCtrl = new AbortController();
  res.on('close', () => abortCtrl.abort());
  const stream = streams.getOrCreate(target.serial, quality, target.label);
  await stream.ensureStarted(quality);
  const frame = await stream.waitForFrame(after, waitMs, abortCtrl.signal);
  if (!frame) {
    res.writeHead(204).end();
    return;
  }

  const base64 = frame.bytes.toString('base64');
  const data = putBlob(`page-${target.serial}-${frame.seq}`, base64);
  const payload: PageFrame = {
    seq: frame.seq,
    mime: frame.mime,
    width: frame.width,
    height: frame.height,
    rotation: cachedRotation,
    data,
  };
  json(res, 200, payload);
}

async function handlePageInput(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: { events?: unknown; width?: unknown; height?: unknown; serial?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }
  const batch = readSurfaceInputBatch(JSON.stringify({ events: parsed.events }));
  if (!batch) {
    json(res, 400, { error: 'Invalid input batch' });
    return;
  }
  const serial = typeof parsed.serial === 'string' ? parsed.serial : '';
  const dev = devicesCache.find((d) => d.id === serial || d.serial === serial);
  if (!dev?.serial || dev.state !== 'booted') {
    json(res, 409, { error: 'Device is not booted' });
    return;
  }
  const stream = streams.get(dev.serial);
  const current = stream?.current();
  if (!stream || !current) {
    json(res, 409, { error: 'No stream frame' });
    return;
  }
  const w = typeof parsed.width === 'number' && parsed.width > 0 ? parsed.width : current.width;
  const h = typeof parsed.height === 'number' && parsed.height > 0 ? parsed.height : current.height;
  if (w !== current.width || h !== current.height) {
    json(res, 409, { error: 'Stale frame dimensions' });
    return;
  }
  await dispatchSurfaceEvents({
    events: batch.events,
    session: stream.getScrcpySession(),
    serial: dev.serial,
    screenWidth: current.width,
    screenHeight: current.height,
    state: pageInputOf(dev.serial),
  });
  res.writeHead(204).end();
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  if (pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === SURFACE_FRAME_PATH) {
    await handleSurfaceFrame(req, res, url);
    return;
  }
  if (method === 'POST' && pathname === SURFACE_INPUT_PATH) {
    await handleSurfaceInput(req, res);
    return;
  }
  if (method === 'POST' && pathname === SURFACE_CONTROL_PATH) {
    const raw = await readBody(req);
    const notice = readSurfaceControlNotice(raw);
    if (!notice) {
      json(res, 400, { error: 'Invalid control notice' });
      return;
    }
    surfaceController = notice.controller;
    if (notice.controller !== 'user') {
      const active = pickActiveDevice(devicesCache);
      const cur = active?.serial ? streams.get(active.serial)?.current() : null;
      surfaceInputState.resetTouch(
        active?.serial ? streams.get(active.serial)?.getScrcpySession() ?? null : null,
        cur?.width ?? 0,
        cur?.height ?? 0,
      );
    }
    res.writeHead(204).end();
    return;
  }
  if (method === 'POST' && pathname === SURFACE_RESIZE_PATH) {
    const raw = await readBody(req);
    if (!readSurfaceResizeRequest(raw)) {
      json(res, 400, { error: 'Invalid resize request' });
      return;
    }
    json(res, 400, { error: 'fixed size' });
    return;
  }
  if (method === 'GET' && pathname === SURFACE_CLIPBOARD_PATH) {
    const active = pickActiveDevice(devicesCache);
    const session = active?.serial ? streams.get(active.serial)?.getScrcpySession() ?? null : null;
    if (!session) {
      json(res, 404, { error: 'No active scrcpy session' });
      return;
    }
    const elapsed = Date.now() - surfaceInputState.lastCopyAt;
    if (elapsed >= 0 && elapsed < 150) {
      await new Promise((r) => setTimeout(r, 150 - elapsed));
    }
    const text = await session.fetchClipboard(700);
    if (!text) {
      json(res, 404, { error: 'Clipboard empty' });
      return;
    }
    json(res, 200, { text });
    return;
  }

  if (method === 'GET' && pathname === '/page/frame') {
    await handlePageFrame(res, url);
    return;
  }
  if (method === 'POST' && pathname === '/page/input') {
    await handlePageInput(req, res);
    return;
  }
  if (method === 'GET' && pathname === '/blob') {
    const id = url.searchParams.get('id') ?? '';
    const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
    const blob = blobs.get(id);
    if (!blob || offset < 0 || offset >= blob.length) {
      json(res, 404, { error: 'gone' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(blob.slice(offset, offset + BLOB_CHUNK));
    return;
  }

  if (method === 'GET' && pathname === '/state') {
    const refresh = url.searchParams.get('refresh') === '1';
    if (refresh || devicesCache.length === 0) {
      await refreshDevices(true);
    }
    json(res, 200, buildStateSnapshot(url.searchParams.get('id')));
    return;
  }

  if (method === 'POST' && pathname === '/select') {
    const body = JSON.parse(await readBody(req)) as { id?: string };
    await refreshDevices(false);
    if (body.id) {
      const match = devicesCache.find((d) => d.id === body.id || d.serial === body.id);
      if (!match) {
        json(res, 404, { error: `Device not found: ${body.id}` });
        return;
      }
      selectedId = match.id;
      noteAction(`Selected ${match.label}`);
      wakePlaceholderWaiters();
      if (match.state === 'booted' && match.serial) {
        const [app, rot] = await Promise.all([
          getAppearance(match.serial),
          getRotation(match.serial),
        ]);
        cachedAppearance = app;
        cachedRotation = rot;
      }
    }
    json(res, 200, buildStateSnapshot());
    return;
  }

  if (method === 'POST' && pathname === '/boot') {
    const body = JSON.parse(await readBody(req)) as { id?: string; avdName?: string; select?: boolean };
    await refreshDevices(false);
    let avdName = body.avdName?.trim() || null;
    if (!avdName && body.id) {
      const match = devicesCache.find((d) => d.id === body.id || d.avdName === body.id);
      avdName = match?.avdName ?? (body.id.startsWith('avd:') ? body.id.slice(4) : null);
    }
    if (!avdName) {
      const active = pickActiveDevice(devicesCache);
      avdName = active?.avdName ?? null;
    }
    if (!avdName) {
      json(res, 400, { error: 'Select an AVD to boot.' });
      return;
    }
    bootingAvds.add(avdName);
    try {
      const booted = await bootAvd(avdName, { headless: true });
      if (body.select !== false) selectedId = booted.id;
      noteAction(`Booted ${booted.label}`);
      await refreshDevices(true);
      wakePlaceholderWaiters();
      json(res, 200, buildStateSnapshot());
    } finally {
      bootingAvds.delete(avdName);
    }
    return;
  }

  if (method === 'POST' && pathname === '/shutdown') {
    const body = JSON.parse(await readBody(req)) as { id?: string };
    const serial = resolveSerialTarget(body.id);
    await streams.stop(serial);
    const msg = await shutdownDevice(serial);
    noteAction(msg);
    await refreshDevices(false);
    wakePlaceholderWaiters();
    json(res, 200, buildStateSnapshot());
    return;
  }

  if (method === 'POST' && pathname === '/button') {
    const body = JSON.parse(await readBody(req)) as { name?: string; id?: string };
    const serial = resolveSerialTarget(body.id);
    const session = streams.get(serial)?.getScrcpySession() ?? null;
    const keyMap: Record<string, number> = {
      back: KEYCODE_BACK,
      home: KEYCODE_HOME,
      recents: KEYCODE_APP_SWITCH,
      power: KEYCODE_POWER,
      lock: KEYCODE_POWER,
      volume_up: KEYCODE_VOLUME_UP,
      volume_down: KEYCODE_VOLUME_DOWN,
    };
    const keycode = keyMap[String(body.name ?? '').toLowerCase()];
    if (!keycode) {
      json(res, 400, { error: `Unknown button: ${String(body.name)}` });
      return;
    }
    await injectAndroidKey(serial, keycode, session);
    noteAction(`Pressed ${body.name}`);
    json(res, 200, buildStateSnapshot(body.id));
    return;
  }

  if (method === 'POST' && pathname === '/rotate') {
    const body = JSON.parse(await readBody(req) || '{}') as { id?: string; rotation?: RotationDegrees };
    const serial = resolveSerialTarget(body.id);
    cachedRotation = await setRotation(serial, body.rotation);
    noteAction(`Rotated to ${cachedRotation}°`);
    json(res, 200, buildStateSnapshot(body.id));
    return;
  }

  if (method === 'POST' && pathname === '/appearance') {
    const body = JSON.parse(await readBody(req) || '{}') as { id?: string; mode?: AppearanceMode };
    const serial = resolveSerialTarget(body.id);
    const nextMode: AppearanceMode =
      body.mode ?? (cachedAppearance === 'dark' ? 'light' : 'dark');
    cachedAppearance = await setAppearance(serial, nextMode);
    noteAction(`Appearance: ${cachedAppearance}`);
    json(res, 200, buildStateSnapshot(body.id));
    return;
  }

  if (method === 'POST' && pathname === '/quality') {
    const body = JSON.parse(await readBody(req) || '{}') as { value?: QualityPreset };
    if (body.value === 'full' || body.value === 'balanced' || body.value === 'fast') {
      quality = body.value;
      const active = pickActiveDevice(devicesCache);
      if (active?.serial) {
        const s = streams.get(active.serial);
        if (s) await s.ensureStarted(quality);
      }
      noteAction(`Stream quality: ${quality}`);
    }
    json(res, 200, buildStateSnapshot());
    return;
  }

  if (method === 'POST' && pathname === '/frame') {
    const body = JSON.parse(await readBody(req) || '{}') as { on?: boolean };
    framed = body.on !== false;
    json(res, 200, buildStateSnapshot());
    return;
  }

  if (method === 'POST' && pathname === '/open-url') {
    const body = JSON.parse(await readBody(req)) as { id?: string; url?: string };
    const serial = resolveSerialTarget(body.id);
    const msg = await openUrl(serial, String(body.url ?? ''));
    noteAction(`Opened ${body.url}`);
    json(res, 200, { ...buildStateSnapshot(body.id), detail: msg });
    return;
  }

  if (method === 'POST' && pathname === '/install-apk') {
    const body = JSON.parse(await readBody(req)) as { id?: string; apkPath?: string };
    const serial = resolveSerialTarget(body.id);
    const msg = await installApk(serial, String(body.apkPath ?? ''));
    noteAction('Installed APK');
    json(res, 200, { ...buildStateSnapshot(body.id), detail: msg });
    return;
  }

  if (method === 'GET' && pathname === '/status') {
    await refreshDevices(false);
    json(res, 200, buildStatusView(buildStateSnapshot()));
    return;
  }

  if (method === 'POST' && pathname === '/status') {
    const body = JSON.parse(await readBody(req) || '{}') as { id?: string };
    const actionId = String(body.id ?? '');
    if (actionId.startsWith('boot:')) {
      const avd = actionId.slice(5);
      bootingAvds.add(avd);
      try {
        const booted = await bootAvd(avd, { headless: true });
        selectedId = booted.id;
        wakePlaceholderWaiters();
      } finally {
        bootingAvds.delete(avd);
      }
    } else if (actionId.startsWith('shutdown:')) {
      const serial = actionId.slice(9);
      await streams.stop(serial);
      await shutdownDevice(serial);
      wakePlaceholderWaiters();
    }
    await refreshDevices(true);
    json(res, 200, buildStatusView(buildStateSnapshot()));
    return;
  }

  if (method === 'POST' && pathname === '/agent/tool') {
    const reqBody = JSON.parse(await readBody(req)) as AgentToolRequest;
    agentActiveUntil = Date.now() + SURFACE_AGENT_HOLD_MS;
    const active = pickActiveDevice(devicesCache);
    const data = await executeAgentTool(reqBody.tool, reqBody.input ?? {}, {
      preferredSerial: active?.serial ?? null,
      onSelectDevice: (id) => {
        selectedId = id;
        wakePlaceholderWaiters();
      },
      onDeviceListChanged: () => {
        void refreshDevices(true);
      },
      onScrcpyTap: async (serial, x, y, holdMs = 45) => {
        const stream = streams.get(serial);
        const session = stream?.getScrcpySession();
        const cur = stream?.current();
        if (!session || !cur || cur.width <= 0 || cur.height <= 0) return false;
        // Scale device pixels (if different from stream size) into stream pixels
        const dev = devicesCache.find((d) => d.serial === serial);
        const sx =
          dev?.screenWidth && dev.screenWidth > 0
            ? Math.round((x / dev.screenWidth) * cur.width)
            : x;
        const sy =
          dev?.screenHeight && dev.screenHeight > 0
            ? Math.round((y / dev.screenHeight) * cur.height)
            : y;
        const ok1 = session.sendControl(
          encodeTouchEvent({
            action: AMOTION_ACTION_DOWN,
            pointerId: 1n,
            x: sx,
            y: sy,
            screenWidth: cur.width,
            screenHeight: cur.height,
          }),
        );
        await new Promise((r) => setTimeout(r, Math.max(40, holdMs)));
        const ok2 = session.sendControl(
          encodeTouchEvent({
            action: AMOTION_ACTION_UP,
            pointerId: 1n,
            x: sx,
            y: sy,
            screenWidth: cur.width,
            screenHeight: cur.height,
          }),
        );
        return ok1 && ok2;
      },
      onScrcpyText: async (serial, text) => {
        const session = streams.get(serial)?.getScrcpySession();
        if (!session) return false;
        return session.sendControl(encodeTextEvent(text));
      },
      onScrcpyKey: async (serial, keycode) => {
        const session = streams.get(serial)?.getScrcpySession();
        if (!session) return false;
        await injectAndroidKey(serial, keycode, session);
        return true;
      },
    });
    json(res, 200, { ok: true, data });
    return;
  }

  json(res, 404, { error: `Not found: ${pathname}` });
}

const server = http.createServer((req, res) => {
  if (!token || req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  route(req, res).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      json(res, 500, { error: message });
    } else {
      res.end();
    }
  });
});

// Keep device list & agent instructions fresh in background
const pollTimer = setInterval(() => {
  void refreshDevices(false);
}, 8000);
pollTimer.unref();

const cleanup = async () => {
  clearInterval(pollTimer);
  clearServiceDiscovery(process.pid);
  await streams.stopAll();
  server.close();
};

process.on('SIGTERM', () => {
  void cleanup().finally(() => process.exit(0));
});
process.on('SIGINT', () => {
  void cleanup().finally(() => process.exit(0));
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  if (actualPort > 0 && token) {
    writeServiceDiscovery({
      port: actualPort,
      token,
      pid: process.pid,
      startedAt: Date.now(),
    });
  }
  void refreshDevices(true);
});
