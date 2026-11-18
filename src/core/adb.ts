import { accessSync, constants, existsSync, openSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AndroidDevice,
  AppearanceMode,
  RotationDegrees,
} from '../shared/types.ts';
import {
  androidToolEnv,
  execBuffer,
  execText,
  resolveBinaries,
  spawnDetachedLog,
  type BinaryPaths,
} from './exec.ts';

export interface AvdInfo {
  readonly avdName: string;
  readonly model: string | null;
  readonly apiLevel: string | null;
  readonly screenWidth: number | null;
  readonly screenHeight: number | null;
}

export function expandHomePath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function parseIniKeyValues(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    map[key] = val;
  }
  return map;
}

function readAvdMetadata(avdName: string): Omit<AvdInfo, 'avdName'> {
  const avdRoot = process.env.ANDROID_AVD_HOME || path.join(os.homedir(), '.android', 'avd');
  const iniPath = path.join(avdRoot, `${avdName}.ini`);
  let avdDir = path.join(avdRoot, `${avdName}.avd`);
  if (existsSync(iniPath)) {
    try {
      const ini = parseIniKeyValues(readFileSync(iniPath, 'utf8'));
      if (ini.path && existsSync(ini.path)) avdDir = ini.path;
    } catch {
      // ignore unreadable ini
    }
  }
  const configPath = path.join(avdDir, 'config.ini');
  if (!existsSync(configPath)) {
    return { model: null, apiLevel: null, screenWidth: null, screenHeight: null };
  }
  try {
    const cfg = parseIniKeyValues(readFileSync(configPath, 'utf8'));
    const width = Number.parseInt(cfg['hw.lcd.width'] ?? '', 10);
    const height = Number.parseInt(cfg['hw.lcd.height'] ?? '', 10);
    const sysdir = cfg['image.sysdir.1'] ?? '';
    const apiMatch = /android-(\d+)/i.exec(sysdir);
    const model = cfg['hw.device.name'] || null;
    return {
      model,
      apiLevel: apiMatch?.[1] ?? null,
      screenWidth: Number.isFinite(width) && width > 0 ? width : null,
      screenHeight: Number.isFinite(height) && height > 0 ? height : null,
    };
  } catch {
    return { model: null, apiLevel: null, screenWidth: null, screenHeight: null };
  }
}

export async function listAvds(bins: BinaryPaths = resolveBinaries()): Promise<AvdInfo[]> {
  if (!bins.emulator) return [];
  const res = await execText(bins.emulator, ['-list-avds'], {
    timeoutMs: 5000,
    env: androidToolEnv(bins.sdkRoot),
  });
  if (res.code !== 0) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('INFO') && !line.startsWith('WARNING'))
    .map((avdName) => ({
      avdName,
      ...readAvdMetadata(avdName),
    }));
}

interface RawAdbRow {
  readonly serial: string;
  readonly rawState: string;
  readonly model: string | null;
  readonly transport: 'local' | 'usb' | 'tcp';
}

export function parseAdbDevicesOutput(stdout: string): RawAdbRow[] {
  const rows: RawAdbRow[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('List of devices')) continue;
    const parts = line.split(/\s+/);
    const serial = parts[0];
    const rawState = parts[1];
    if (!serial || !rawState) continue;
    let model: string | null = null;
    for (const part of parts.slice(2)) {
      if (part.startsWith('model:')) {
        model = part.slice('model:'.length).replace(/_/g, ' ');
      }
    }
    const transport: 'local' | 'usb' | 'tcp' = serial.startsWith('emulator-')
      ? 'local'
      : serial.includes(':')
        ? 'tcp'
        : 'usb';
    rows.push({ serial, rawState, model, transport });
  }
  return rows;
}

async function queryEmulatorAvdName(serial: string, bins: BinaryPaths): Promise<string | null> {
  if (!bins.adb) return null;
  const res = await execText(bins.adb, ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 2000 });
  if (res.code !== 0) return null;
  const firstLine = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && l !== 'OK');
  return firstLine || null;
}

export async function queryScreenSize(
  serial: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<{ width: number; height: number } | null> {
  if (!bins.adb) return null;
  const res = await execText(bins.adb, ['-s', serial, 'shell', 'wm', 'size'], { timeoutMs: 2500 });
  if (res.code !== 0) return null;
  const override = /Override size:\s*(\d+)x(\d+)/i.exec(res.stdout);
  const physical = /Physical size:\s*(\d+)x(\d+)/i.exec(res.stdout);
  const match = override ?? physical;
  if (!match) return null;
  const width = Number.parseInt(match[1] ?? '', 10);
  const height = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

export async function queryDeviceBooted(
  serial: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<boolean> {
  if (!bins.adb) return false;
  const res = await execText(
    bins.adb,
    ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
    { timeoutMs: 2500 },
  );
  return res.code === 0 && res.stdout.trim() === '1';
}

export async function queryApiLevel(
  serial: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<string | null> {
  if (!bins.adb) return null;
  const res = await execText(
    bins.adb,
    ['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'],
    { timeoutMs: 2500 },
  );
  if (res.code !== 0) return null;
  const val = res.stdout.trim();
  return /^\d+$/.test(val) ? val : null;
}

export async function discoverDevices(
  bootingAvds: ReadonlySet<string> = new Set(),
  bins: BinaryPaths = resolveBinaries(),
): Promise<AndroidDevice[]> {
  const [avds, adbRes] = await Promise.all([
    listAvds(bins),
    bins.adb ? execText(bins.adb, ['devices', '-l'], { timeoutMs: 4000 }) : Promise.resolve(null),
  ]);

  const avdByName = new Map<string, AvdInfo>();
  for (const avd of avds) avdByName.set(avd.avdName, avd);

  const runningAvdNames = new Set<string>();
  const devices: AndroidDevice[] = [];
  const rawRows = adbRes && adbRes.code === 0 ? parseAdbDevicesOutput(adbRes.stdout) : [];

  await Promise.all(
    rawRows.map(async (row) => {
      const isEmulator = row.serial.startsWith('emulator-');
      let avdName: string | null = null;
      let state: AndroidDevice['state'] = 'offline';
      let apiLevel: string | null = null;
      let screenWidth: number | null = null;
      let screenHeight: number | null = null;

      if (row.rawState === 'unauthorized') {
        state = 'unauthorized';
      } else if (row.rawState === 'offline') {
        state = 'offline';
      } else if (row.rawState === 'device') {
        const [booted, size, sdk, emuAvd] = await Promise.all([
          queryDeviceBooted(row.serial, bins),
          queryScreenSize(row.serial, bins),
          queryApiLevel(row.serial, bins),
          isEmulator ? queryEmulatorAvdName(row.serial, bins) : Promise.resolve(null),
        ]);
        state = booted ? 'booted' : 'booting';
        avdName = emuAvd;
        apiLevel = sdk;
        screenWidth = size?.width ?? null;
        screenHeight = size?.height ?? null;
      }

      if (avdName) runningAvdNames.add(avdName);
      const avdMeta = avdName ? avdByName.get(avdName) : undefined;
      const label = avdName
        ? `${avdName} (${row.serial})`
        : row.model
          ? `${row.model} (${row.serial})`
          : row.serial;

      devices.push({
        id: row.serial,
        serial: row.serial,
        avdName,
        label,
        kind: isEmulator ? 'emulator' : 'device',
        state,
        model: row.model ?? avdMeta?.model ?? null,
        apiLevel: apiLevel ?? avdMeta?.apiLevel ?? null,
        transport: row.transport,
        screenWidth: screenWidth ?? avdMeta?.screenWidth ?? null,
        screenHeight: screenHeight ?? avdMeta?.screenHeight ?? null,
      });
    }),
  );

  for (const avd of avds) {
    if (runningAvdNames.has(avd.avdName)) continue;
    devices.push({
      id: `avd:${avd.avdName}`,
      serial: null,
      avdName: avd.avdName,
      label: avd.avdName,
      kind: 'avd',
      state: bootingAvds.has(avd.avdName) ? 'booting' : 'off',
      model: avd.model,
      apiLevel: avd.apiLevel,
      transport: 'avd',
      screenWidth: avd.screenWidth,
      screenHeight: avd.screenHeight,
    });
  }

  // Sort: booted devices/emulators first, then booting, then offline AVDs alphabetically
  const rank = (s: AndroidDevice['state']): number => {
    switch (s) {
      case 'booted':
        return 0;
      case 'booting':
        return 1;
      case 'unauthorized':
        return 2;
      case 'offline':
        return 3;
      case 'off':
        return 4;
    }
  };
  devices.sort((a, b) => rank(a.state) - rank(b.state) || a.label.localeCompare(b.label));
  return devices;
}

export async function bootAvd(
  avdName: string,
  options: { headless?: boolean; cold?: boolean; waitMs?: number } = {},
  bins: BinaryPaths = resolveBinaries(),
): Promise<AndroidDevice> {
  if (!bins.emulator) {
    throw new Error('Android emulator binary not found (checked ANDROID_HOME/emulator/emulator).');
  }
  if (!bins.adb) {
    throw new Error('adb binary not found (checked ANDROID_HOME/platform-tools/adb).');
  }

  // Check if already running first
  const existing = (await discoverDevices(new Set(), bins)).find(
    (d) => d.avdName === avdName && d.serial,
  );
  if (existing && existing.state === 'booted') return existing;

  if (!existing) {
    const safeName = avdName.replace(/[^A-Za-z0-9_.-]/g, '_');
    const logPath = path.join(os.tmpdir(), `openchamber-android-sim-${safeName}.log`);
    const logFd = openSync(logPath, 'a');
    const args = ['-avd', avdName, '-no-audio', '-no-boot-anim', '-gpu', 'auto'];
    if (options.headless !== false) {
      args.push('-no-window');
    }
    if (options.cold === true) {
      args.push('-no-snapshot-load');
    }
    spawnDetachedLog(bins.emulator, args, logFd, androidToolEnv(bins.sdkRoot));
  }

  const deadline = Date.now() + (options.waitMs ?? 90_000);
  while (Date.now() < deadline) {
    const devices = await discoverDevices(new Set([avdName]), bins);
    const match = devices.find((d) => d.avdName === avdName && d.serial && d.state === 'booted');
    if (match) return match;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error(`Timed out waiting for AVD "${avdName}" to finish booting.`);
}

export async function shutdownDevice(
  serial: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<string> {
  if (!bins.adb) throw new Error('adb binary not found.');
  if (serial.startsWith('emulator-')) {
    const res = await execText(bins.adb, ['-s', serial, 'emu', 'kill'], { timeoutMs: 8000 });
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `Failed to shut down ${serial}.`);
    }
    return `Shut down ${serial}`;
  }
  if (serial.includes(':')) {
    const res = await execText(bins.adb, ['disconnect', serial], { timeoutMs: 5000 });
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `Failed to disconnect ${serial}.`);
    }
    return `Disconnected ${serial}`;
  }
  throw new Error(`Cannot power off physical USB device ${serial} via adb.`);
}

export async function getAppearance(
  serial: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<AppearanceMode | null> {
  if (!bins.adb) return null;
  const res = await execText(bins.adb, ['-s', serial, 'shell', 'cmd', 'uimode', 'night'], {
    timeoutMs: 3000,
  });
  if (res.code !== 0) return null;
  const low = res.stdout.toLowerCase();
  if (low.includes('yes')) return 'dark';
  if (low.includes('no')) return 'light';
  return null;
}

export async function setAppearance(
  serial: string,
  mode: AppearanceMode,
  bins: BinaryPaths = resolveBinaries(),
): Promise<AppearanceMode> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const res = await execText(
    bins.adb,
    ['-s', serial, 'shell', 'cmd', 'uimode', 'night', mode === 'dark' ? 'yes' : 'no'],
    { timeoutMs: 4000 },
  );
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'Failed to update night mode.');
  }
  return mode;
}

export async function getRotation(
  serial: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<RotationDegrees> {
  if (!bins.adb) return 0;
  const res = await execText(
    bins.adb,
    ['-s', serial, 'shell', 'settings', 'get', 'system', 'user_rotation'],
    { timeoutMs: 3000 },
  );
  const val = Number.parseInt(res.stdout.trim(), 10);
  switch (val) {
    case 1:
      return 90;
    case 2:
      return 180;
    case 3:
      return 270;
    default:
      return 0;
  }
}

export async function setRotation(
  serial: string,
  degrees?: RotationDegrees,
  bins: BinaryPaths = resolveBinaries(),
): Promise<RotationDegrees> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const current = await getRotation(serial, bins);
  const next: RotationDegrees =
    degrees !== undefined ? degrees : current === 0 ? 90 : 0;
  const userRot = next === 90 ? '1' : next === 180 ? '2' : next === 270 ? '3' : '0';
  await execText(
    bins.adb,
    ['-s', serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'],
    { timeoutMs: 3000 },
  );
  const res = await execText(
    bins.adb,
    ['-s', serial, 'shell', 'settings', 'put', 'system', 'user_rotation', userRot],
    { timeoutMs: 3000 },
  );
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'Failed to rotate device.');
  }
  return next;
}

export async function installApk(
  serial: string,
  apkPathOrPaths: string | readonly string[],
  optionsOrBins: { grantPermissions?: boolean } | BinaryPaths = {},
  maybeBins?: BinaryPaths,
): Promise<string> {
  const isBins = 'adb' in optionsOrBins;
  const options = isBins ? {} : optionsOrBins;
  const bins = isBins ? optionsOrBins : maybeBins ?? resolveBinaries();
  if (!bins.adb) throw new Error('adb binary not found.');

  const rawPaths = Array.isArray(apkPathOrPaths) ? apkPathOrPaths : [apkPathOrPaths];
  const resolved = rawPaths.map((p) => path.resolve(expandHomePath(String(p).trim())));
  if (resolved.length === 0) throw new Error('At least one APK path is required.');
  for (const p of resolved) {
    if (!existsSync(p)) throw new Error(`APK not found: ${p}`);
  }

  const flags = ['-r', '-d'];
  if (options.grantPermissions) flags.push('-g');

  const args =
    resolved.length > 1
      ? ['-s', serial, 'install-multiple', ...flags, ...resolved]
      : ['-s', serial, 'install', ...flags, resolved[0]!];

  const res = await execText(bins.adb, args, { timeoutMs: 120_000 });
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  if (res.code !== 0 || !combined.includes('Success')) {
    throw new Error(combined || 'adb install failed.');
  }
  return combined;
}

export async function connectTcpDevice(
  address: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<string> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const target = address.trim();
  if (!target) throw new Error('"address" (host:port) is required.');
  const res = await execText(bins.adb, ['connect', target], { timeoutMs: 10_000 });
  const out = `${res.stdout}\n${res.stderr}`.trim();
  if (res.code !== 0 || /failed|unable|refused/i.test(out)) {
    throw new Error(out || `adb connect ${target} failed.`);
  }
  return out;
}

export async function launchApp(
  serial: string,
  packageName: string,
  activity?: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<string> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const pkg = packageName.trim();
  if (!pkg) throw new Error('"package" is required.');
  if (activity && activity.trim()) {
    const component = activity.includes('/') ? activity.trim() : `${pkg}/${activity.trim()}`;
    const res = await execText(
      bins.adb,
      ['-s', serial, 'shell', 'am', 'start', '-n', shellEscape(component)],
      { timeoutMs: 10_000 },
    );
    const out = `${res.stdout}\n${res.stderr}`.trim();
    if (res.code !== 0 || /Error:|Exception/i.test(out)) {
      throw new Error(out || `Failed to launch ${component}`);
    }
    return out || `Launched ${component}`;
  }
  const res = await execText(
    bins.adb,
    ['-s', serial, 'shell', 'monkey', '-p', shellEscape(pkg), '-c', 'android.intent.category.LAUNCHER', '1'],
    { timeoutMs: 10_000 },
  );
  const out = `${res.stdout}\n${res.stderr}`.trim();
  if (res.code !== 0 || out.includes('No activities found')) {
    throw new Error(out || `Failed to launch ${pkg}`);
  }
  return out || `Launched ${pkg}`;
}

export async function stopApp(
  serial: string,
  packageName: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<string> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const pkg = packageName.trim();
  if (!pkg) throw new Error('"package" is required.');
  const res = await execText(bins.adb, ['-s', serial, 'shell', 'am', 'force-stop', shellEscape(pkg)], {
    timeoutMs: 6000,
  });
  if (res.code !== 0) throw new Error(res.stderr.trim() || `Failed to stop ${pkg}`);
  return `Stopped ${pkg}`;
}

export async function clearAppData(
  serial: string,
  packageName: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<string> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const pkg = packageName.trim();
  if (!pkg) throw new Error('"package" is required.');
  const res = await execText(bins.adb, ['-s', serial, 'shell', 'pm', 'clear', shellEscape(pkg)], {
    timeoutMs: 8000,
  });
  const out = `${res.stdout}\n${res.stderr}`.trim();
  if (res.code !== 0 || !out.includes('Success')) {
    throw new Error(out || `Failed to clear data for ${pkg}`);
  }
  return out;
}

export async function openUrl(
  serial: string,
  url: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<string> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const cleanUrl = url.trim();
  if (!cleanUrl) throw new Error('URL is required.');
  const res = await execText(
    bins.adb,
    ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', shellEscape(cleanUrl)],
    { timeoutMs: 10_000 },
  );
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || 'am start failed.');
  }
  return res.stdout.trim() || `Opened ${cleanUrl}`;
}

export async function screencapPng(
  serial: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<Buffer> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const res = await execBuffer(bins.adb, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    timeoutMs: 10_000,
  });
  if (res.code !== 0 || res.stdout.length < 8) {
    throw new Error(res.stderr.trim() || 'screencap failed.');
  }
  return res.stdout;
}

export async function dumpUiXml(
  serial: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<string> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const dumpRes = await execText(
    bins.adb,
    ['-s', serial, 'shell', 'uiautomator', 'dump', '/data/local/tmp/oc_ui_dump.xml'],
    { timeoutMs: 12_000 },
  );
  const readRes = await execText(
    bins.adb,
    ['-s', serial, 'exec-out', 'cat', '/data/local/tmp/oc_ui_dump.xml'],
    { timeoutMs: 6000 },
  );
  const raw = readRes.code === 0 && readRes.stdout.includes('<hierarchy')
    ? readRes.stdout
    : dumpRes.stdout;
  const start = raw.indexOf('<hierarchy');
  const end = raw.lastIndexOf('</hierarchy>');
  if (start === -1 || end === -1) {
    throw new Error(
      dumpRes.stderr.trim() || readRes.stderr.trim() || 'uiautomator dump returned no hierarchy XML.',
    );
  }
  return raw.slice(start, end + '</hierarchy>'.length);
}

export async function queryCurrentFocus(
  serial: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<string | null> {
  if (!bins.adb) return null;
  const res = await execText(
    bins.adb,
    ['-s', serial, 'shell', 'dumpsys', 'window', 'displays'],
    { timeoutMs: 4000 },
  );
  const mFocus = /mCurrentFocus=Window\{[^\s]+\s+[^\s]+\s+([^}\r\n]+)\}/.exec(res.stdout);
  if (mFocus?.[1]) return mFocus[1].trim();
  const mFocused = /mFocusedApp=ActivityRecord\{[^\s]+\s+[^\s]+\s+([^}\s]+)/.exec(res.stdout);
  return mFocused?.[1]?.trim() ?? null;
}

export async function adbTap(
  serial: string,
  x: number,
  y: number,
  bins: BinaryPaths = resolveBinaries(),
): Promise<void> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const res = await execText(
    bins.adb,
    ['-s', serial, 'shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))],
    { timeoutMs: 5000 },
  );
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'adb tap failed.');
}

export async function adbSwipe(
  serial: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs = 300,
  bins: BinaryPaths = resolveBinaries(),
): Promise<void> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const res = await execText(
    bins.adb,
    [
      '-s',
      serial,
      'shell',
      'input',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(Math.max(50, Math.round(durationMs))),
    ],
    { timeoutMs: 8000 },
  );
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'adb swipe failed.');
}

export async function adbText(
  serial: string,
  text: string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<void> {
  if (!bins.adb) throw new Error('adb binary not found.');
  // Android `input text` treats `%s` as space and requires escaping shell special chars.
  const escaped = shellEscape(text.replace(/ /g, '%s'));
  const res = await execText(bins.adb, ['-s', serial, 'shell', 'input', 'text', escaped], {
    timeoutMs: 8000,
  });
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'adb text failed.');
}

export async function adbKey(
  serial: string,
  keycode: number | string,
  bins: BinaryPaths = resolveBinaries(),
): Promise<void> {
  if (!bins.adb) throw new Error('adb binary not found.');
  const res = await execText(
    bins.adb,
    ['-s', serial, 'shell', 'input', 'keyevent', String(keycode)],
    { timeoutMs: 5000 },
  );
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'adb keyevent failed.');
}

export async function adbLogcat(
  serial: string,
  options: { lines?: number; filter?: string; clear?: boolean } = {},
  bins: BinaryPaths = resolveBinaries(),
): Promise<string> {
  if (!bins.adb) throw new Error('adb binary not found.');
  if (options.clear) {
    await execText(bins.adb, ['-s', serial, 'logcat', '-c'], { timeoutMs: 4000 });
    return 'Cleared logcat buffer.';
  }
  const lines = Math.max(10, Math.min(500, options.lines ?? 120));
  const args = ['-s', serial, 'logcat', '-d', '-t', String(lines)];
  if (options.filter && options.filter.trim()) {
    args.push('-s', options.filter.trim());
  }
  const res = await execText(bins.adb, args, { timeoutMs: 8000 });
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'adb logcat failed.');
  return res.stdout;
}

export async function diagnoseEnvironment(
  options: { serial?: string; attemptFix?: boolean } = {},
  bins: BinaryPaths = resolveBinaries(),
): Promise<Record<string, unknown>> {
  const actionsTaken: string[] = [];

  if (options.attemptFix && bins.adb) {
    await execText(bins.adb, ['start-server'], { timeoutMs: 6000 });
    actionsTaken.push('Ensured adb server is running');
  }

  let kvmAccessible: boolean | null = null;
  if (process.platform === 'linux') {
    if (!existsSync('/dev/kvm')) {
      kvmAccessible = false;
    } else {
      try {
        accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
        kvmAccessible = true;
      } catch {
        kvmAccessible = false;
      }
    }
  }

  const [adbVer, emuVer, ffVer] = await Promise.all([
    bins.adb ? execText(bins.adb, ['version'], { timeoutMs: 3000 }) : Promise.resolve(null),
    bins.emulator
      ? execText(bins.emulator, ['-version'], { timeoutMs: 4000, env: androidToolEnv(bins.sdkRoot) })
      : Promise.resolve(null),
    bins.ffmpeg ? execText(bins.ffmpeg, ['-version'], { timeoutMs: 3000 }) : Promise.resolve(null),
  ]);

  const devices = await discoverDevices(new Set(), bins);
  const target = options.serial
    ? devices.find((d) => d.serial === options.serial || d.id === options.serial)
    : devices.find((d) => d.state === 'booted');

  let deviceProbe: Record<string, unknown> | null = null;
  if (target?.serial && target.state === 'booted') {
    if (options.attemptFix && bins.adb) {
      await execText(bins.adb, ['-s', target.serial, 'shell', 'rm', '-f', '/data/local/tmp/oc_ui_dump.xml'], {
        timeoutMs: 3000,
      });
      actionsTaken.push(`Cleared stale uiautomator dump on ${target.serial}`);
    }
    let screencapOk = false;
    let screencapBytes = 0;
    let uiautomatorOk = false;
    let focus: string | null = null;
    let probeError: string | null = null;
    try {
      const png = await screencapPng(target.serial, bins);
      screencapOk = png.length > 8;
      screencapBytes = png.length;
    } catch (err) {
      probeError = err instanceof Error ? err.message : String(err);
    }
    try {
      const xml = await dumpUiXml(target.serial, bins);
      uiautomatorOk = xml.includes('<hierarchy');
      focus = await queryCurrentFocus(target.serial, bins);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      probeError = probeError ? `${probeError}; ${msg}` : msg;
    }
    deviceProbe = {
      serial: target.serial,
      screencapOk,
      screencapBytes,
      uiautomatorOk,
      currentFocus: focus,
      ...(probeError ? { error: probeError } : {}),
    };
  }

  return {
    sdkRoot: bins.sdkRoot,
    kvmAccessible,
    binaries: {
      adb: bins.adb ? { path: bins.adb, version: adbVer?.stdout.split('\n')[0]?.trim() ?? null } : null,
      emulator: bins.emulator
        ? { path: bins.emulator, version: emuVer?.stdout.split('\n')[0]?.trim() ?? null }
        : null,
      scrcpyServer: bins.scrcpyServer ? { path: bins.scrcpyServer } : null,
      ffmpeg: bins.ffmpeg ? { path: bins.ffmpeg, version: ffVer?.stdout.split('\n')[0]?.trim() ?? null } : null,
    },
    devices,
    deviceProbe,
    ...(actionsTaken.length > 0 ? { actionsTaken } : {}),
  };
}
