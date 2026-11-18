import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppearanceMode, RotationDegrees, UiNode } from '../shared/types.ts';
import {
  adbKey,
  adbLogcat,
  adbSwipe,
  adbTap,
  adbText,
  bootAvd,
  clearAppData,
  connectTcpDevice,
  diagnoseEnvironment,
  discoverDevices,
  dumpUiXml,
  installApk,
  launchApp,
  openUrl,
  queryCurrentFocus,
  queryScreenSize,
  screencapPng,
  setAppearance,
  setRotation,
  shutdownDevice,
  stopApp,
} from './adb.ts';
import { resolveBinaries, type BinaryPaths } from './exec.ts';
import {
  annotateScreenshotPng,
  matchUiNodes,
  parseUiHierarchyXml,
  type UiSelector,
} from './uiautomator.ts';

const TEMP_DIR = '/tmp/opencode';
const KEYCODE_DEL = 67;
const KEYCODE_ENTER = 66;
const KEYCODE_MOVE_END = 123;

function ensureTempDir(): string {
  mkdirSync(TEMP_DIR, { recursive: true });
  return TEMP_DIR;
}

function safeSerialTag(serial: string): string {
  return serial.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// Per-device async mutex so concurrent agent calls / panel actions never race on uiautomator or input
const deviceLocks = new Map<string, Promise<void>>();

export async function withDeviceLock<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  const prev = deviceLocks.get(serial) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const chained = prev.then(() => gate);
  deviceLocks.set(serial, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (deviceLocks.get(serial) === chained) {
      deviceLocks.delete(serial);
    }
  }
}

interface CachedLayout {
  readonly nodes: readonly UiNode[];
  readonly screen: { readonly width: number; readonly height: number } | null;
  readonly capturedAt: number;
}

const lastLayoutBySerial = new Map<string, CachedLayout>();

function resolveKeycodeNumber(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw);
  if (typeof raw === 'string') {
    const upper = raw.trim().toUpperCase().replace(/^KEYCODE_/, '');
    const map: Record<string, number> = {
      HOME: 3,
      BACK: 4,
      CALL: 5,
      ENDCALL: 6,
      DPAD_UP: 19,
      DPAD_DOWN: 20,
      DPAD_LEFT: 21,
      DPAD_RIGHT: 22,
      DPAD_CENTER: 23,
      VOLUME_UP: 24,
      VOLUME_DOWN: 25,
      POWER: 26,
      CAMERA: 27,
      CLEAR: 28,
      TAB: 61,
      SPACE: 62,
      ENTER: 66,
      DEL: 67,
      BACKSPACE: 67,
      MENU: 82,
      SEARCH: 84,
      ESCAPE: 111,
      FORWARD_DEL: 112,
      MOVE_HOME: 122,
      MOVE_END: 123,
      APP_SWITCH: 187,
      RECENTS: 187,
    };
    if (upper in map) return map[upper]!;
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Unknown Android keycode: ${String(raw)}`);
}

export interface ControllerContext {
  readonly preferredSerial?: string | null;
  readonly onSelectDevice?: (id: string) => void;
  readonly onDeviceListChanged?: () => void;
  readonly onScrcpyTap?: (serial: string, x: number, y: number, holdMs?: number) => Promise<boolean>;
  readonly onScrcpyText?: (serial: string, text: string) => Promise<boolean>;
  readonly onScrcpyKey?: (serial: string, keycode: number) => Promise<boolean>;
}

async function resolveBootedSerial(
  requestedSerial: unknown,
  preferredSerial?: string | null,
): Promise<string> {
  const devices = await discoverDevices();
  const booted = devices.filter((d) => d.state === 'booted' && d.serial);

  if (typeof requestedSerial === 'string' && requestedSerial.trim()) {
    const wanted = requestedSerial.trim();
    const match = booted.find((d) => d.serial === wanted || d.id === wanted || d.avdName === wanted);
    if (!match?.serial) {
      throw new Error(`Device "${wanted}" is not booted or not found.`);
    }
    return match.serial;
  }

  if (preferredSerial) {
    const pref = booted.find((d) => d.serial === preferredSerial || d.id === preferredSerial);
    if (pref?.serial) return pref.serial;
  }

  if (booted.length === 1 && booted[0]?.serial) {
    return booted[0].serial;
  }

  if (booted.length === 0) {
    const offAvds = devices.filter((d) => d.kind === 'avd' && d.avdName).map((d) => d.avdName);
    throw new Error(
      offAvds.length > 0
        ? `No Android device is booted. Available AVDs: ${offAvds.join(', ')}. Call android_device with action="boot" first.`
        : 'No booted Android emulator or ADB device found.',
    );
  }

  throw new Error(
    `Multiple booted Android devices found (${booted.map((d) => d.serial).join(', ')}). Specify "serial".`,
  );
}

function summarizeNode(n: UiNode): string {
  const label = n.text || n.contentDesc || n.resourceId || n.className.split('.').pop() || 'node';
  return `#${n.index} "${label.slice(0, 40)}" (${n.center.x},${n.center.y})`;
}

async function captureFreshFlatLayout(
  serial: string,
  bins: BinaryPaths,
): Promise<{ nodes: UiNode[]; screen: { width: number; height: number } | null }> {
  const [xml, size] = await Promise.all([
    dumpUiXml(serial, bins),
    queryScreenSize(serial, bins),
  ]);
  const nodes = parseUiHierarchyXml(xml, {
    includeNonInteractive: false,
    maxNodes: 200,
    screen: size,
    tree: false,
  });
  lastLayoutBySerial.set(serial, { nodes, screen: size, capturedAt: Date.now() });
  return { nodes, screen: size };
}

function parseNodeIndex(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw);
  if (typeof raw === 'string') {
    const m = /^#?(\d+)$/.exec(raw.trim());
    if (m) return Number.parseInt(m[1]!, 10);
  }
  return null;
}

async function resolveNodeBySelector(
  serial: string,
  selector: UiSelector,
  options: { match?: 'single' | 'first'; waitMs?: number },
  bins: BinaryPaths,
): Promise<UiNode> {
  const waitMs = Math.max(0, Math.min(15_000, options.waitMs ?? 0));
  const matchMode = options.match === 'first' ? 'first' : 'single';
  const deadline = Date.now() + waitMs;

  while (true) {
    const { nodes } = await captureFreshFlatLayout(serial, bins);
    const matches = matchUiNodes(nodes, selector);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      if (matchMode === 'first') return matches[0]!;
      throw new Error(
        `Selector matched ${matches.length} nodes (pass match="first" or narrow selector): ${matches
          .slice(0, 5)
          .map(summarizeNode)
          .join(', ')}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`No UI node matched selector ${JSON.stringify(selector)}.`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function resolveTargetPoint(
  serial: string,
  step: Record<string, unknown>,
  bins: BinaryPaths,
): Promise<{ x: number; y: number; matchedNode?: UiNode }> {
  const nodeIdx = parseNodeIndex(step.node);
  if (nodeIdx !== null) {
    const cached = lastLayoutBySerial.get(serial);
    if (!cached) {
      throw new Error(`No cached layout for ${serial}; call android_inspect({ action: "layout" }) first.`);
    }
    const found = cached.nodes.find((n) => n.index === nodeIdx);
    if (!found) {
      throw new Error(`Node #${nodeIdx} not found in latest layout (${cached.nodes.length} nodes).`);
    }
    return { x: found.center.x, y: found.center.y, matchedNode: found };
  }

  if (step.selector !== undefined && step.selector !== null && step.selector !== '') {
    const matched = await resolveNodeBySelector(
      serial,
      step.selector as UiSelector,
      {
        match: step.match === 'first' ? 'first' : 'single',
        waitMs: typeof step.waitMs === 'number' ? step.waitMs : 0,
      },
      bins,
    );
    return { x: matched.center.x, y: matched.center.y, matchedNode: matched };
  }

  const nx = Number(step.x);
  const ny = Number(step.y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    throw new Error('Provide "x" & "y", "node", or "selector".');
  }
  const normalized = step.normalized === true;
  if (normalized || (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 && (nx % 1 !== 0 || ny % 1 !== 0))) {
    const size = await queryScreenSize(serial, bins);
    if (!size) throw new Error(`Could not query screen size for ${serial}.`);
    return {
      x: Math.round(Math.max(0, Math.min(1, nx)) * (size.width - 1)),
      y: Math.round(Math.max(0, Math.min(1, ny)) * (size.height - 1)),
    };
  }
  return { x: Math.round(nx), y: Math.round(ny) };
}

async function runSingleInputStep(
  serial: string,
  step: Record<string, unknown>,
  ctx: ControllerContext,
  bins: BinaryPaths,
): Promise<Record<string, unknown>> {
  const action = String(step.action ?? '');

  switch (action) {
    case 'wait': {
      const ms = Math.max(0, Math.min(15_000, Number(step.ms ?? step.durationMs ?? 300)));
      await new Promise((r) => setTimeout(r, ms));
      return { action: 'wait', ms };
    }

    case 'tap': {
      const target = await resolveTargetPoint(serial, step, bins);
      const usedScrcpy = (await ctx.onScrcpyTap?.(serial, target.x, target.y)) ?? false;
      if (!usedScrcpy) await adbTap(serial, target.x, target.y, bins);
      return {
        action: 'tap',
        x: target.x,
        y: target.y,
        ...(target.matchedNode ? { node: summarizeNode(target.matchedNode) } : {}),
        transport: usedScrcpy ? 'scrcpy' : 'adb',
      };
    }

    case 'long_press': {
      const target = await resolveTargetPoint(serial, step, bins);
      const durationMs = Math.max(300, Math.min(5000, Number(step.durationMs ?? 700)));
      const usedScrcpy = (await ctx.onScrcpyTap?.(serial, target.x, target.y, durationMs)) ?? false;
      if (!usedScrcpy) {
        await adbSwipe(serial, target.x, target.y, target.x, target.y, durationMs, bins);
      }
      return {
        action: 'long_press',
        x: target.x,
        y: target.y,
        durationMs,
        ...(target.matchedNode ? { node: summarizeNode(target.matchedNode) } : {}),
        transport: usedScrcpy ? 'scrcpy' : 'adb',
      };
    }

    case 'swipe': {
      const p1 = await resolveTargetPoint(serial, step, bins);
      const p2 = await resolveTargetPoint(
        serial,
        { x: step.x2, y: step.y2, normalized: step.normalized },
        bins,
      );
      const durationMs = typeof step.durationMs === 'number' ? step.durationMs : 300;
      await adbSwipe(serial, p1.x, p1.y, p2.x, p2.y, durationMs, bins);
      return { action: 'swipe', from: { x: p1.x, y: p1.y }, to: { x: p2.x, y: p2.y }, durationMs };
    }

    case 'scroll': {
      const direction = String(step.direction ?? 'down').toLowerCase();
      if (!['up', 'down', 'left', 'right'].includes(direction)) {
        throw new Error(`Invalid scroll direction: ${direction}`);
      }
      const durationMs = Math.max(120, Math.min(2000, Number(step.durationMs ?? 350)));
      const until = step.until as UiSelector | undefined;
      const maxScrolls = Math.max(1, Math.min(15, Number(step.maxScrolls ?? 5)));

      let bounds: { left: number; top: number; right: number; bottom: number } | null = null;
      if (step.node !== undefined || step.selector !== undefined) {
        const target = await resolveTargetPoint(serial, step, bins);
        bounds = target.matchedNode?.bounds ?? null;
      }

      const layout = await captureFreshFlatLayout(serial, bins);
      if (until) {
        const already = matchUiNodes(layout.nodes, until);
        if (already.length > 0) {
          return { action: 'scroll', direction, scrolls: 0, found: summarizeNode(already[0]!) };
        }
      }

      if (!bounds) {
        const scrollables = layout.nodes
          .filter((n) => n.scrollable && !n.hidden && !n.offScreen)
          .sort(
            (a, b) =>
              (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top) -
              (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top),
          );
        if (scrollables[0]) {
          bounds = scrollables[0].bounds;
        } else {
          const size = layout.screen ?? (await queryScreenSize(serial, bins)) ?? { width: 1080, height: 2400 };
          bounds = { left: 0, top: 0, right: size.width, bottom: size.height };
        }
      }

      const cx = Math.round((bounds.left + bounds.right) / 2);
      const cy = Math.round((bounds.top + bounds.bottom) / 2);
      const spanX = Math.max(40, Math.round((bounds.right - bounds.left) * 0.3));
      const spanY = Math.max(40, Math.round((bounds.bottom - bounds.top) * 0.3));

      // Scrolling "down" reveals lower items -> swipe finger from bottom to top
      const [x1, y1, x2, y2] =
        direction === 'down'
          ? [cx, cy + spanY, cx, cy - spanY]
          : direction === 'up'
            ? [cx, cy - spanY, cx, cy + spanY]
            : direction === 'right'
              ? [cx + spanX, cy, cx - spanX, cy]
              : [cx - spanX, cy, cx + spanX, cy];

      const attempts = until ? maxScrolls : 1;
      for (let i = 1; i <= attempts; i += 1) {
        await adbSwipe(serial, x1, y1, x2, y2, durationMs, bins);
        if (until) {
          await new Promise((r) => setTimeout(r, 250));
          const nextLayout = await captureFreshFlatLayout(serial, bins);
          const found = matchUiNodes(nextLayout.nodes, until);
          if (found.length > 0) {
            return {
              action: 'scroll',
              direction,
              scrolls: i,
              found: summarizeNode(found[0]!),
            };
          }
        }
      }

      return {
        action: 'scroll',
        direction,
        scrolls: attempts,
        ...(until ? { found: null } : {}),
      };
    }

    case 'text': {
      const text = String(step.text ?? '');
      if (!text) throw new Error('"text" is required for action="text".');

      let focusedNode: UiNode | undefined;
      if (step.node !== undefined || step.selector !== undefined || (step.x !== undefined && step.y !== undefined)) {
        const target = await resolveTargetPoint(serial, step, bins);
        focusedNode = target.matchedNode;
        const usedTap = (await ctx.onScrcpyTap?.(serial, target.x, target.y)) ?? false;
        if (!usedTap) await adbTap(serial, target.x, target.y, bins);
        await new Promise((r) => setTimeout(r, 120));
      }

      if (step.clearFirst === true) {
        const clearLen = focusedNode?.text ? Math.min(80, focusedNode.text.length + 4) : 40;
        await adbKey(serial, KEYCODE_MOVE_END, bins);
        for (let i = 0; i < Math.min(clearLen, 24); i += 1) {
          await adbKey(serial, KEYCODE_DEL, bins);
        }
      }

      const usedScrcpy = (await ctx.onScrcpyText?.(serial, text)) ?? false;
      if (!usedScrcpy) await adbText(serial, text, bins);

      if (step.submit === true) {
        const sentEnter = (await ctx.onScrcpyKey?.(serial, KEYCODE_ENTER)) ?? false;
        if (!sentEnter) await adbKey(serial, KEYCODE_ENTER, bins);
      }

      return {
        action: 'text',
        length: text.length,
        submitted: step.submit === true,
        ...(focusedNode ? { node: summarizeNode(focusedNode) } : {}),
        transport: usedScrcpy ? 'scrcpy' : 'adb',
      };
    }

    case 'key': {
      const keycode = resolveKeycodeNumber(step.keycode);
      const usedScrcpy = (await ctx.onScrcpyKey?.(serial, keycode)) ?? false;
      if (!usedScrcpy) await adbKey(serial, keycode, bins);
      return { action: 'key', keycode, transport: usedScrcpy ? 'scrcpy' : 'adb' };
    }

    case 'back': {
      const usedScrcpy = (await ctx.onScrcpyKey?.(serial, 4)) ?? false;
      if (!usedScrcpy) await adbKey(serial, 4, bins);
      return { action: 'back', keycode: 4 };
    }

    case 'home': {
      const usedScrcpy = (await ctx.onScrcpyKey?.(serial, 3)) ?? false;
      if (!usedScrcpy) await adbKey(serial, 3, bins);
      return { action: 'home', keycode: 3 };
    }

    case 'recents': {
      const usedScrcpy = (await ctx.onScrcpyKey?.(serial, 187)) ?? false;
      if (!usedScrcpy) await adbKey(serial, 187, bins);
      return { action: 'recents', keycode: 187 };
    }

    case 'power': {
      const usedScrcpy = (await ctx.onScrcpyKey?.(serial, 26)) ?? false;
      if (!usedScrcpy) await adbKey(serial, 26, bins);
      return { action: 'power', keycode: 26 };
    }

    default:
      throw new Error(`Unsupported android_input action: ${action}`);
  }
}

export async function executeAgentTool(
  tool: 'android_device' | 'android_input' | 'android_inspect',
  input: Record<string, unknown>,
  ctx: ControllerContext = {},
): Promise<unknown> {
  const bins = resolveBinaries();

  if (tool === 'android_device') {
    const action = String(input.action ?? 'list');
    switch (action) {
      case 'list': {
        const devices = await discoverDevices(new Set(), bins);
        return {
          devices,
          selectedSerial: ctx.preferredSerial ?? null,
          tools: {
            adb: Boolean(bins.adb),
            emulator: Boolean(bins.emulator),
            scrcpyServer: Boolean(bins.scrcpyServer),
            ffmpeg: Boolean(bins.ffmpeg),
          },
        };
      }
      case 'select': {
        const id = String(input.serial ?? input.avd ?? '').trim();
        if (!id) throw new Error('Provide "serial" or "avd" to select.');
        const devices = await discoverDevices(new Set(), bins);
        const match = devices.find((d) => d.id === id || d.serial === id || d.avdName === id);
        if (!match) throw new Error(`Device "${id}" not found.`);
        ctx.onSelectDevice?.(match.id);
        return { selected: match };
      }
      case 'connect': {
        const address = String(input.address ?? input.serial ?? '').trim();
        const message = await connectTcpDevice(address, bins);
        ctx.onDeviceListChanged?.();
        return { address, message };
      }
      case 'boot': {
        const devices = await discoverDevices(new Set(), bins);
        let avdName = typeof input.avd === 'string' && input.avd.trim() ? input.avd.trim() : null;
        if (!avdName && typeof input.serial === 'string' && input.serial.startsWith('avd:')) {
          avdName = input.serial.slice(4);
        }
        if (!avdName) {
          const avds = devices.filter((d) => d.avdName);
          if (avds.length === 1 && avds[0]?.avdName) avdName = avds[0].avdName;
          else if (avds.length === 0) throw new Error('No Android Virtual Devices (AVDs) configured.');
          else {
            throw new Error(
              `Multiple AVDs found (${avds.map((d) => d.avdName).join(', ')}). Specify "avd".`,
            );
          }
        }
        const booted = await bootAvd(
          avdName,
          { headless: input.headless !== false, cold: input.cold === true },
          bins,
        );
        ctx.onSelectDevice?.(booted.id);
        ctx.onDeviceListChanged?.();
        return { device: booted };
      }
      case 'shutdown': {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const message = await shutdownDevice(serial, bins);
        lastLayoutBySerial.delete(serial);
        ctx.onDeviceListChanged?.();
        return { serial, message };
      }
      case 'diagnose': {
        const serial =
          typeof input.serial === 'string' && input.serial.trim()
            ? input.serial.trim()
            : ctx.preferredSerial ?? undefined;
        return diagnoseEnvironment(
          { serial, attemptFix: input.attemptFix === true },
          bins,
        );
      }
      case 'rotate': {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        return withDeviceLock(serial, async () => {
          const deg =
            input.rotation === 0 || input.rotation === 90 || input.rotation === 180 || input.rotation === 270
              ? (input.rotation as RotationDegrees)
              : undefined;
          const rotation = await setRotation(serial, deg, bins);
          return { serial, rotation };
        });
      }
      case 'appearance': {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        return withDeviceLock(serial, async () => {
          const mode =
            input.appearance === 'dark' || input.appearance === 'light'
              ? (input.appearance as AppearanceMode)
              : 'dark';
          const applied = await setAppearance(serial, mode, bins);
          return { serial, appearance: applied };
        });
      }
      case 'open_url': {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const url = String(input.url ?? '').trim();
        if (!url) throw new Error('"url" is required for action="open_url".');
        return withDeviceLock(serial, async () => {
          const output = await openUrl(serial, url, bins);
          return { serial, url, output };
        });
      }
      case 'install_apk': {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const paths = Array.isArray(input.apkPaths)
          ? input.apkPaths.map((p) => String(p).trim()).filter(Boolean)
          : String(input.apkPath ?? '').trim();
        const grantPermissions = input.grantPermissions === true;
        return withDeviceLock(serial, async () => {
          const output = await installApk(serial, paths, { grantPermissions }, bins);
          return { serial, output };
        });
      }
      case 'launch': {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const pkg = String(input.package ?? '').trim();
        const activity = typeof input.activity === 'string' ? input.activity : undefined;
        return withDeviceLock(serial, async () => {
          const output = await launchApp(serial, pkg, activity, bins);
          return { serial, package: pkg, output };
        });
      }
      case 'stop_app': {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const pkg = String(input.package ?? '').trim();
        return withDeviceLock(serial, async () => {
          const output = await stopApp(serial, pkg, bins);
          return { serial, package: pkg, output };
        });
      }
      case 'clear_data': {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const pkg = String(input.package ?? '').trim();
        return withDeviceLock(serial, async () => {
          const output = await clearAppData(serial, pkg, bins);
          return { serial, package: pkg, output };
        });
      }
      default:
        throw new Error(`Unsupported android_device action: ${action}`);
    }
  }

  if (tool === 'android_input') {
    const action = String(input.action ?? '');
    const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);

    return withDeviceLock(serial, async () => {
      if (action === 'sequence') {
        const steps = Array.isArray(input.steps) ? input.steps : [];
        if (steps.length === 0) throw new Error('"steps" array is required for action="sequence".');
        if (steps.length > 30) throw new Error('Maximum 30 steps per sequence.');
        const results: Array<Record<string, unknown>> = [];
        for (const rawStep of steps) {
          if (!rawStep || typeof rawStep !== 'object') {
            throw new Error('Each sequence step must be an object.');
          }
          results.push(await runSingleInputStep(serial, rawStep as Record<string, unknown>, ctx, bins));
        }
        return { serial, action: 'sequence', results };
      }

      const result = await runSingleInputStep(serial, input, ctx, bins);
      return { serial, ...result };
    });
  }

  if (tool === 'android_inspect') {
    const action = String(input.action ?? 'layout');
    const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);

    return withDeviceLock(serial, async () => {
      switch (action) {
        case 'screenshot': {
          const [png, size, focus] = await Promise.all([
            screencapPng(serial, bins),
            queryScreenSize(serial, bins),
            queryCurrentFocus(serial, bins),
          ]);
          const dir = ensureTempDir();
          const filePath = path.join(dir, `android-sim-${safeSerialTag(serial)}-${Date.now()}.png`);
          writeFileSync(filePath, png);
          const width = size?.width ?? (png.length >= 24 ? png.readUInt32BE(16) : 0);
          const height = size?.height ?? (png.length >= 24 ? png.readUInt32BE(20) : 0);
          return { serial, path: filePath, width, height, currentFocus: focus };
        }
        case 'layout': {
          const [xml, size, focus] = await Promise.all([
            dumpUiXml(serial, bins),
            queryScreenSize(serial, bins),
            queryCurrentFocus(serial, bins),
          ]);
          const includeAll = input.includeAll === true;
          const maxNodes = typeof input.maxNodes === 'number' ? input.maxNodes : 120;
          const flatNodes = parseUiHierarchyXml(xml, {
            includeNonInteractive: includeAll,
            maxNodes,
            screen: size,
            tree: false,
          });
          lastLayoutBySerial.set(serial, {
            nodes: flatNodes,
            screen: size,
            capturedAt: Date.now(),
          });

          const nodes =
            input.tree === true
              ? parseUiHierarchyXml(xml, {
                  includeNonInteractive: includeAll,
                  maxNodes,
                  screen: size,
                  tree: true,
                })
              : flatNodes;

          let annotatedPath: string | null = null;
          if (input.annotate === true) {
            const png = await screencapPng(serial, bins);
            const annotated = await annotateScreenshotPng(png, flatNodes);
            const dir = ensureTempDir();
            annotatedPath = path.join(dir, `android-layout-${safeSerialTag(serial)}-${Date.now()}.png`);
            writeFileSync(annotatedPath, annotated);
          }
          return {
            serial,
            currentFocus: focus,
            screen: size,
            nodeCount: flatNodes.length,
            ...(annotatedPath ? { annotatedPath } : {}),
            nodes,
          };
        }
        case 'logcat': {
          const lines = typeof input.lines === 'number' ? input.lines : 120;
          const filter = typeof input.filter === 'string' ? input.filter : undefined;
          const clear = input.clear === true;
          const output = await adbLogcat(serial, { lines, filter, clear }, bins);
          return { serial, lines, output };
        }
        default:
          throw new Error(`Unsupported android_inspect action: ${action}`);
      }
    });
  }

  throw new Error(`Unknown tool: ${tool}`);
}
