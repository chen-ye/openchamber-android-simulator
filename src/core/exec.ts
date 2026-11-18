import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface BinaryPaths {
  readonly adb: string | null;
  readonly emulator: string | null;
  readonly ffmpeg: string | null;
  readonly scrcpyServer: string | null;
  readonly sdkRoot: string | null;
}

function existingFile(candidate: string | undefined | null): string | null {
  if (!candidate) return null;
  try {
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function findInPath(name: string, extraDirs: readonly string[] = []): string | null {
  const pathEnv = process.env.PATH ?? '';
  const dirs = [
    ...pathEnv.split(path.delimiter).filter(Boolean),
    ...extraDirs,
    '/home/linuxbrew/.linuxbrew/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const full = path.join(dir, name);
    if (existingFile(full)) return full;
  }
  return null;
}

export function resolveSdkRoot(): string | null {
  const home = os.homedir();
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(home, 'Android', 'Sdk'),
    path.join(home, 'Library', 'Android', 'sdk'),
    '/opt/android-sdk',
    '/usr/lib/android-sdk',
  ];
  for (const dir of candidates) {
    if (dir && existsSync(dir)) return dir;
  }
  return null;
}

export function resolveScrcpyServer(): string | null {
  const envPath = existingFile(process.env.SCRCPY_SERVER_PATH);
  if (envPath) return envPath;

  const fixed = [
    '/home/linuxbrew/.linuxbrew/share/scrcpy/scrcpy-server',
    '/opt/homebrew/share/scrcpy/scrcpy-server',
    '/usr/local/share/scrcpy/scrcpy-server',
    '/usr/share/scrcpy/scrcpy-server',
    '/usr/local/lib/scrcpy/scrcpy-server',
  ];
  for (const candidate of fixed) {
    if (existingFile(candidate)) return candidate;
  }

  const scrcpyBin = findInPath('scrcpy');
  if (scrcpyBin) {
    const prefix = path.resolve(path.dirname(scrcpyBin), '..');
    const direct = path.join(prefix, 'share', 'scrcpy', 'scrcpy-server');
    if (existingFile(direct)) return direct;
  }

  for (const cellar of ['/home/linuxbrew/.linuxbrew/Cellar/scrcpy', '/opt/homebrew/Cellar/scrcpy']) {
    try {
      if (!existsSync(cellar)) continue;
      for (const ver of readdirSync(cellar)) {
        const candidate = path.join(cellar, ver, 'share', 'scrcpy', 'scrcpy-server');
        if (existingFile(candidate)) return candidate;
      }
    } catch {
      // ignore unreadable cellar dir
    }
  }

  return null;
}

export function resolveBinaries(): BinaryPaths {
  const sdkRoot = resolveSdkRoot();
  const adb =
    existingFile(sdkRoot ? path.join(sdkRoot, 'platform-tools', 'adb') : null) ??
    findInPath('adb');
  const emulator =
    existingFile(sdkRoot ? path.join(sdkRoot, 'emulator', 'emulator') : null) ??
    findInPath('emulator');
  const ffmpeg = findInPath('ffmpeg');
  const scrcpyServer = resolveScrcpyServer();
  return { adb, emulator, ffmpeg, scrcpyServer, sdkRoot };
}

export function androidToolEnv(sdkRoot: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (sdkRoot) {
    env.ANDROID_HOME = env.ANDROID_HOME || sdkRoot;
    env.ANDROID_SDK_ROOT = env.ANDROID_SDK_ROOT || sdkRoot;
  }
  return env;
}

export function execText(
  bin: string,
  args: readonly string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      {
        timeout: options.timeoutMs ?? 15_000,
        env: options.env ?? process.env,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { status?: unknown }).code === 'number'
            ? Number((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
          code,
        });
      },
    );
  });
}

export function execBuffer(
  bin: string,
  args: readonly string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      {
        timeout: options.timeoutMs ?? 15_000,
        env: options.env ?? process.env,
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        encoding: 'buffer',
      },
      (err, stdout, stderr) => {
        const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
        const errStr = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
        const code = err ? 1 : 0;
        resolve({ stdout: outBuf, stderr: errStr, code });
      },
    );
  });
}

export function spawnDetachedLog(
  bin: string,
  args: readonly string[],
  logFd: number,
  env: NodeJS.ProcessEnv,
): number | null {
  const child = spawn(bin, [...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  });
  child.unref();
  return child.pid ?? null;
}
