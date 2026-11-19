// src/core/controller.ts
import { mkdirSync, writeFileSync } from "node:fs";
import path3 from "node:path";

// src/core/adb.ts
import { accessSync, constants, existsSync as existsSync2, openSync, readFileSync } from "node:fs";
import os2 from "node:os";
import path2 from "node:path";

// src/core/exec.ts
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
function existingFile(candidate) {
  if (!candidate)
    return null;
  try {
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
function findInPath(name, extraDirs = []) {
  const pathEnv = process.env.PATH ?? "";
  const dirs = [
    ...pathEnv.split(path.delimiter).filter(Boolean),
    ...extraDirs,
    "/home/linuxbrew/.linuxbrew/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ];
  const seen = new Set;
  for (const dir of dirs) {
    if (seen.has(dir))
      continue;
    seen.add(dir);
    const full = path.join(dir, name);
    if (existingFile(full))
      return full;
  }
  return null;
}
function resolveSdkRoot() {
  const home = os.homedir();
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(home, "Android", "Sdk"),
    path.join(home, "Library", "Android", "sdk"),
    "/opt/android-sdk",
    "/usr/lib/android-sdk"
  ];
  for (const dir of candidates) {
    if (dir && existsSync(dir))
      return dir;
  }
  return null;
}
function resolveScrcpyServer() {
  const envPath = existingFile(process.env.SCRCPY_SERVER_PATH);
  if (envPath)
    return envPath;
  const fixed = [
    "/home/linuxbrew/.linuxbrew/share/scrcpy/scrcpy-server",
    "/opt/homebrew/share/scrcpy/scrcpy-server",
    "/usr/local/share/scrcpy/scrcpy-server",
    "/usr/share/scrcpy/scrcpy-server",
    "/usr/local/lib/scrcpy/scrcpy-server"
  ];
  for (const candidate of fixed) {
    if (existingFile(candidate))
      return candidate;
  }
  const scrcpyBin = findInPath("scrcpy");
  if (scrcpyBin) {
    const prefix = path.resolve(path.dirname(scrcpyBin), "..");
    const direct = path.join(prefix, "share", "scrcpy", "scrcpy-server");
    if (existingFile(direct))
      return direct;
  }
  for (const cellar of ["/home/linuxbrew/.linuxbrew/Cellar/scrcpy", "/opt/homebrew/Cellar/scrcpy"]) {
    try {
      if (!existsSync(cellar))
        continue;
      for (const ver of readdirSync(cellar)) {
        const candidate = path.join(cellar, ver, "share", "scrcpy", "scrcpy-server");
        if (existingFile(candidate))
          return candidate;
      }
    } catch {}
  }
  return null;
}
function resolveBinaries() {
  const sdkRoot = resolveSdkRoot();
  const adb = existingFile(sdkRoot ? path.join(sdkRoot, "platform-tools", "adb") : null) ?? findInPath("adb");
  const emulator = existingFile(sdkRoot ? path.join(sdkRoot, "emulator", "emulator") : null) ?? findInPath("emulator");
  const ffmpeg = findInPath("ffmpeg");
  const scrcpyServer = resolveScrcpyServer();
  return { adb, emulator, ffmpeg, scrcpyServer, sdkRoot };
}
function androidToolEnv(sdkRoot) {
  const env = { ...process.env };
  if (sdkRoot) {
    env.ANDROID_HOME = env.ANDROID_HOME || sdkRoot;
    env.ANDROID_SDK_ROOT = env.ANDROID_SDK_ROOT || sdkRoot;
  }
  return env;
}
function execText(bin, args, options = {}) {
  return new Promise((resolve) => {
    execFile(bin, [...args], {
      timeout: options.timeoutMs ?? 15000,
      env: options.env ?? process.env,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      encoding: "utf8"
    }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? Number(err.code) : err ? 1 : 0;
      resolve({
        stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
        stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
        code
      });
    });
  });
}
function execBuffer(bin, args, options = {}) {
  return new Promise((resolve) => {
    execFile(bin, [...args], {
      timeout: options.timeoutMs ?? 15000,
      env: options.env ?? process.env,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      encoding: "buffer"
    }, (err, stdout, stderr) => {
      const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
      const errStr = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
      const code = err ? 1 : 0;
      resolve({ stdout: outBuf, stderr: errStr, code });
    });
  });
}
function spawnDetachedLog(bin, args, logFd, env) {
  const child = spawn(bin, [...args], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env
  });
  child.unref();
  return child.pid ?? null;
}

// src/core/adb.ts
function expandHomePath(p) {
  if (p === "~")
    return os2.homedir();
  if (p.startsWith("~/"))
    return path2.join(os2.homedir(), p.slice(2));
  return p;
}
function shellEscape(arg) {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
function parseIniKeyValues(text) {
  const map = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";"))
      continue;
    const eq = line.indexOf("=");
    if (eq <= 0)
      continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    map[key] = val;
  }
  return map;
}
function readAvdMetadata(avdName) {
  const avdRoot = process.env.ANDROID_AVD_HOME || path2.join(os2.homedir(), ".android", "avd");
  const iniPath = path2.join(avdRoot, `${avdName}.ini`);
  let avdDir = path2.join(avdRoot, `${avdName}.avd`);
  if (existsSync2(iniPath)) {
    try {
      const ini = parseIniKeyValues(readFileSync(iniPath, "utf8"));
      if (ini.path && existsSync2(ini.path))
        avdDir = ini.path;
    } catch {}
  }
  const configPath = path2.join(avdDir, "config.ini");
  if (!existsSync2(configPath)) {
    return { model: null, apiLevel: null, screenWidth: null, screenHeight: null };
  }
  try {
    const cfg = parseIniKeyValues(readFileSync(configPath, "utf8"));
    const width = Number.parseInt(cfg["hw.lcd.width"] ?? "", 10);
    const height = Number.parseInt(cfg["hw.lcd.height"] ?? "", 10);
    const sysdir = cfg["image.sysdir.1"] ?? "";
    const apiMatch = /android-(\d+)/i.exec(sysdir);
    const model = cfg["hw.device.name"] || null;
    return {
      model,
      apiLevel: apiMatch?.[1] ?? null,
      screenWidth: Number.isFinite(width) && width > 0 ? width : null,
      screenHeight: Number.isFinite(height) && height > 0 ? height : null
    };
  } catch {
    return { model: null, apiLevel: null, screenWidth: null, screenHeight: null };
  }
}
async function listAvds(bins = resolveBinaries()) {
  if (!bins.emulator)
    return [];
  const res = await execText(bins.emulator, ["-list-avds"], {
    timeoutMs: 5000,
    env: androidToolEnv(bins.sdkRoot)
  });
  if (res.code !== 0)
    return [];
  return res.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("INFO") && !line.startsWith("WARNING")).map((avdName) => ({
    avdName,
    ...readAvdMetadata(avdName)
  }));
}
function parseAdbDevicesOutput(stdout) {
  const rows = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("List of devices"))
      continue;
    const parts = line.split(/\s+/);
    const serial = parts[0];
    const rawState = parts[1];
    if (!serial || !rawState)
      continue;
    let model = null;
    for (const part of parts.slice(2)) {
      if (part.startsWith("model:")) {
        model = part.slice("model:".length).replace(/_/g, " ");
      }
    }
    const transport = serial.startsWith("emulator-") ? "local" : serial.includes(":") ? "tcp" : "usb";
    rows.push({ serial, rawState, model, transport });
  }
  return rows;
}
async function queryEmulatorAvdName(serial, bins) {
  if (!bins.adb)
    return null;
  const res = await execText(bins.adb, ["-s", serial, "emu", "avd", "name"], { timeoutMs: 2000 });
  if (res.code !== 0)
    return null;
  const firstLine = res.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0 && l !== "OK");
  return firstLine || null;
}
async function queryScreenSize(serial, bins = resolveBinaries()) {
  if (!bins.adb)
    return null;
  const res = await execText(bins.adb, ["-s", serial, "shell", "wm", "size"], { timeoutMs: 2500 });
  if (res.code !== 0)
    return null;
  const override = /Override size:\s*(\d+)x(\d+)/i.exec(res.stdout);
  const physical = /Physical size:\s*(\d+)x(\d+)/i.exec(res.stdout);
  const match = override ?? physical;
  if (!match)
    return null;
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    return null;
  return { width, height };
}
async function queryDeviceBooted(serial, bins = resolveBinaries()) {
  if (!bins.adb)
    return false;
  const res = await execText(bins.adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 2500 });
  return res.code === 0 && res.stdout.trim() === "1";
}
async function queryApiLevel(serial, bins = resolveBinaries()) {
  if (!bins.adb)
    return null;
  const res = await execText(bins.adb, ["-s", serial, "shell", "getprop", "ro.build.version.sdk"], { timeoutMs: 2500 });
  if (res.code !== 0)
    return null;
  const val = res.stdout.trim();
  return /^\d+$/.test(val) ? val : null;
}
async function discoverDevices(bootingAvds = new Set, bins = resolveBinaries()) {
  const [avds, adbRes] = await Promise.all([
    listAvds(bins),
    bins.adb ? execText(bins.adb, ["devices", "-l"], { timeoutMs: 4000 }) : Promise.resolve(null)
  ]);
  const avdByName = new Map;
  for (const avd of avds)
    avdByName.set(avd.avdName, avd);
  const runningAvdNames = new Set;
  const devices = [];
  const rawRows = adbRes && adbRes.code === 0 ? parseAdbDevicesOutput(adbRes.stdout) : [];
  await Promise.all(rawRows.map(async (row) => {
    const isEmulator = row.serial.startsWith("emulator-");
    let avdName = null;
    let state = "offline";
    let apiLevel = null;
    let screenWidth = null;
    let screenHeight = null;
    if (row.rawState === "unauthorized") {
      state = "unauthorized";
    } else if (row.rawState === "offline") {
      state = "offline";
    } else if (row.rawState === "device") {
      const [booted, size, sdk, emuAvd] = await Promise.all([
        queryDeviceBooted(row.serial, bins),
        queryScreenSize(row.serial, bins),
        queryApiLevel(row.serial, bins),
        isEmulator ? queryEmulatorAvdName(row.serial, bins) : Promise.resolve(null)
      ]);
      state = booted ? "booted" : "booting";
      avdName = emuAvd;
      apiLevel = sdk;
      screenWidth = size?.width ?? null;
      screenHeight = size?.height ?? null;
    }
    if (avdName)
      runningAvdNames.add(avdName);
    const avdMeta = avdName ? avdByName.get(avdName) : undefined;
    const label = avdName ? `${avdName} (${row.serial})` : row.model ? `${row.model} (${row.serial})` : row.serial;
    devices.push({
      id: row.serial,
      serial: row.serial,
      avdName,
      label,
      kind: isEmulator ? "emulator" : "device",
      state,
      model: row.model ?? avdMeta?.model ?? null,
      apiLevel: apiLevel ?? avdMeta?.apiLevel ?? null,
      transport: row.transport,
      screenWidth: screenWidth ?? avdMeta?.screenWidth ?? null,
      screenHeight: screenHeight ?? avdMeta?.screenHeight ?? null
    });
  }));
  for (const avd of avds) {
    if (runningAvdNames.has(avd.avdName))
      continue;
    devices.push({
      id: `avd:${avd.avdName}`,
      serial: null,
      avdName: avd.avdName,
      label: avd.avdName,
      kind: "avd",
      state: bootingAvds.has(avd.avdName) ? "booting" : "off",
      model: avd.model,
      apiLevel: avd.apiLevel,
      transport: "avd",
      screenWidth: avd.screenWidth,
      screenHeight: avd.screenHeight
    });
  }
  const rank = (s) => {
    switch (s) {
      case "booted":
        return 0;
      case "booting":
        return 1;
      case "unauthorized":
        return 2;
      case "offline":
        return 3;
      case "off":
        return 4;
    }
  };
  devices.sort((a, b) => rank(a.state) - rank(b.state) || a.label.localeCompare(b.label));
  return devices;
}
async function bootAvd(avdName, options = {}, bins = resolveBinaries()) {
  if (!bins.emulator) {
    throw new Error("Android emulator binary not found (checked ANDROID_HOME/emulator/emulator).");
  }
  if (!bins.adb) {
    throw new Error("adb binary not found (checked ANDROID_HOME/platform-tools/adb).");
  }
  const existing = (await discoverDevices(new Set, bins)).find((d) => d.avdName === avdName && d.serial);
  if (existing && existing.state === "booted")
    return existing;
  if (!existing) {
    const safeName = avdName.replace(/[^A-Za-z0-9_.-]/g, "_");
    const logPath = path2.join(os2.tmpdir(), `openchamber-android-sim-${safeName}.log`);
    const logFd = openSync(logPath, "a");
    const args = ["-avd", avdName, "-no-audio", "-no-boot-anim", "-gpu", "auto"];
    if (options.headless !== false) {
      args.push("-no-window");
    }
    if (options.cold === true) {
      args.push("-no-snapshot-load");
    }
    spawnDetachedLog(bins.emulator, args, logFd, androidToolEnv(bins.sdkRoot));
  }
  const deadline = Date.now() + (options.waitMs ?? 90000);
  while (Date.now() < deadline) {
    const devices = await discoverDevices(new Set([avdName]), bins);
    const match = devices.find((d) => d.avdName === avdName && d.serial && d.state === "booted");
    if (match)
      return match;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error(`Timed out waiting for AVD "${avdName}" to finish booting.`);
}
async function shutdownDevice(serial, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  if (serial.startsWith("emulator-")) {
    const res = await execText(bins.adb, ["-s", serial, "emu", "kill"], { timeoutMs: 8000 });
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `Failed to shut down ${serial}.`);
    }
    return `Shut down ${serial}`;
  }
  if (serial.includes(":")) {
    const res = await execText(bins.adb, ["disconnect", serial], { timeoutMs: 5000 });
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `Failed to disconnect ${serial}.`);
    }
    return `Disconnected ${serial}`;
  }
  throw new Error(`Cannot power off physical USB device ${serial} via adb.`);
}
async function setAppearance(serial, mode, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const res = await execText(bins.adb, ["-s", serial, "shell", "cmd", "uimode", "night", mode === "dark" ? "yes" : "no"], { timeoutMs: 4000 });
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || "Failed to update night mode.");
  }
  return mode;
}
async function getRotation(serial, bins = resolveBinaries()) {
  if (!bins.adb)
    return 0;
  const res = await execText(bins.adb, ["-s", serial, "shell", "settings", "get", "system", "user_rotation"], { timeoutMs: 3000 });
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
async function setRotation(serial, degrees, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const current = await getRotation(serial, bins);
  const next = degrees !== undefined ? degrees : current === 0 ? 90 : 0;
  const userRot = next === 90 ? "1" : next === 180 ? "2" : next === 270 ? "3" : "0";
  await execText(bins.adb, ["-s", serial, "shell", "settings", "put", "system", "accelerometer_rotation", "0"], { timeoutMs: 3000 });
  const res = await execText(bins.adb, ["-s", serial, "shell", "settings", "put", "system", "user_rotation", userRot], { timeoutMs: 3000 });
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || "Failed to rotate device.");
  }
  return next;
}
async function installApk(serial, apkPathOrPaths, optionsOrBins = {}, maybeBins) {
  const isBins = "adb" in optionsOrBins;
  const options = isBins ? {} : optionsOrBins;
  const bins = isBins ? optionsOrBins : maybeBins ?? resolveBinaries();
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const rawPaths = Array.isArray(apkPathOrPaths) ? apkPathOrPaths : [apkPathOrPaths];
  const resolved = rawPaths.map((p) => path2.resolve(expandHomePath(String(p).trim())));
  if (resolved.length === 0)
    throw new Error("At least one APK path is required.");
  for (const p of resolved) {
    if (!existsSync2(p))
      throw new Error(`APK not found: ${p}`);
  }
  const flags = ["-r", "-d"];
  if (options.grantPermissions)
    flags.push("-g");
  const args = resolved.length > 1 ? ["-s", serial, "install-multiple", ...flags, ...resolved] : ["-s", serial, "install", ...flags, resolved[0]];
  const res = await execText(bins.adb, args, { timeoutMs: 120000 });
  const combined = `${res.stdout}
${res.stderr}`.trim();
  if (res.code !== 0 || !combined.includes("Success")) {
    throw new Error(combined || "adb install failed.");
  }
  return combined;
}
async function connectTcpDevice(address, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const target = address.trim();
  if (!target)
    throw new Error('"address" (host:port) is required.');
  const res = await execText(bins.adb, ["connect", target], { timeoutMs: 1e4 });
  const out = `${res.stdout}
${res.stderr}`.trim();
  if (res.code !== 0 || /failed|unable|refused/i.test(out)) {
    throw new Error(out || `adb connect ${target} failed.`);
  }
  return out;
}
async function launchApp(serial, packageName, activity, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const pkg = packageName.trim();
  if (!pkg)
    throw new Error('"package" is required.');
  if (activity && activity.trim()) {
    const component = activity.includes("/") ? activity.trim() : `${pkg}/${activity.trim()}`;
    const res = await execText(bins.adb, ["-s", serial, "shell", "am", "start", "-n", shellEscape(component)], { timeoutMs: 1e4 });
    const out = `${res.stdout}
${res.stderr}`.trim();
    if (res.code !== 0 || /Error:|Exception/i.test(out)) {
      throw new Error(out || `Failed to launch ${component}`);
    }
    return out || `Launched ${component}`;
  }
  const res = await execText(bins.adb, ["-s", serial, "shell", "monkey", "-p", shellEscape(pkg), "-c", "android.intent.category.LAUNCHER", "1"], { timeoutMs: 1e4 });
  const out = `${res.stdout}
${res.stderr}`.trim();
  if (res.code !== 0 || out.includes("No activities found")) {
    throw new Error(out || `Failed to launch ${pkg}`);
  }
  return out || `Launched ${pkg}`;
}
async function stopApp(serial, packageName, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const pkg = packageName.trim();
  if (!pkg)
    throw new Error('"package" is required.');
  const res = await execText(bins.adb, ["-s", serial, "shell", "am", "force-stop", shellEscape(pkg)], {
    timeoutMs: 6000
  });
  if (res.code !== 0)
    throw new Error(res.stderr.trim() || `Failed to stop ${pkg}`);
  return `Stopped ${pkg}`;
}
async function clearAppData(serial, packageName, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const pkg = packageName.trim();
  if (!pkg)
    throw new Error('"package" is required.');
  const res = await execText(bins.adb, ["-s", serial, "shell", "pm", "clear", shellEscape(pkg)], {
    timeoutMs: 8000
  });
  const out = `${res.stdout}
${res.stderr}`.trim();
  if (res.code !== 0 || !out.includes("Success")) {
    throw new Error(out || `Failed to clear data for ${pkg}`);
  }
  return out;
}
async function openUrl(serial, url, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const cleanUrl = url.trim();
  if (!cleanUrl)
    throw new Error("URL is required.");
  const res = await execText(bins.adb, ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", shellEscape(cleanUrl)], { timeoutMs: 1e4 });
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || "am start failed.");
  }
  return res.stdout.trim() || `Opened ${cleanUrl}`;
}
async function screencapPng(serial, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const res = await execBuffer(bins.adb, ["-s", serial, "exec-out", "screencap", "-p"], {
    timeoutMs: 1e4
  });
  if (res.code !== 0 || res.stdout.length < 8) {
    throw new Error(res.stderr.trim() || "screencap failed.");
  }
  return res.stdout;
}
async function dumpUiXml(serial, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const dumpRes = await execText(bins.adb, ["-s", serial, "shell", "uiautomator", "dump", "/data/local/tmp/oc_ui_dump.xml"], { timeoutMs: 12000 });
  const readRes = await execText(bins.adb, ["-s", serial, "exec-out", "cat", "/data/local/tmp/oc_ui_dump.xml"], { timeoutMs: 6000 });
  const raw = readRes.code === 0 && readRes.stdout.includes("<hierarchy") ? readRes.stdout : dumpRes.stdout;
  const start = raw.indexOf("<hierarchy");
  const end = raw.lastIndexOf("</hierarchy>");
  if (start === -1 || end === -1) {
    throw new Error(dumpRes.stderr.trim() || readRes.stderr.trim() || "uiautomator dump returned no hierarchy XML.");
  }
  return raw.slice(start, end + "</hierarchy>".length);
}
async function queryCurrentFocus(serial, bins = resolveBinaries()) {
  if (!bins.adb)
    return null;
  const res = await execText(bins.adb, ["-s", serial, "shell", "dumpsys", "window", "displays"], { timeoutMs: 4000 });
  const mFocus = /mCurrentFocus=Window\{[^\s]+\s+[^\s]+\s+([^}\r\n]+)\}/.exec(res.stdout);
  if (mFocus?.[1])
    return mFocus[1].trim();
  const mFocused = /mFocusedApp=ActivityRecord\{[^\s]+\s+[^\s]+\s+([^}\s]+)/.exec(res.stdout);
  return mFocused?.[1]?.trim() ?? null;
}
async function adbTap(serial, x, y, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const res = await execText(bins.adb, ["-s", serial, "shell", "input", "tap", String(Math.round(x)), String(Math.round(y))], { timeoutMs: 5000 });
  if (res.code !== 0)
    throw new Error(res.stderr.trim() || "adb tap failed.");
}
async function adbSwipe(serial, x1, y1, x2, y2, durationMs = 300, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const res = await execText(bins.adb, [
    "-s",
    serial,
    "shell",
    "input",
    "swipe",
    String(Math.round(x1)),
    String(Math.round(y1)),
    String(Math.round(x2)),
    String(Math.round(y2)),
    String(Math.max(50, Math.round(durationMs)))
  ], { timeoutMs: 8000 });
  if (res.code !== 0)
    throw new Error(res.stderr.trim() || "adb swipe failed.");
}
async function adbText(serial, text, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const escaped = shellEscape(text.replace(/ /g, "%s"));
  const res = await execText(bins.adb, ["-s", serial, "shell", "input", "text", escaped], {
    timeoutMs: 8000
  });
  if (res.code !== 0)
    throw new Error(res.stderr.trim() || "adb text failed.");
}
async function adbKey(serial, keycode, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  const res = await execText(bins.adb, ["-s", serial, "shell", "input", "keyevent", String(keycode)], { timeoutMs: 5000 });
  if (res.code !== 0)
    throw new Error(res.stderr.trim() || "adb keyevent failed.");
}
async function adbLogcat(serial, options = {}, bins = resolveBinaries()) {
  if (!bins.adb)
    throw new Error("adb binary not found.");
  if (options.clear) {
    await execText(bins.adb, ["-s", serial, "logcat", "-c"], { timeoutMs: 4000 });
    return "Cleared logcat buffer.";
  }
  const lines = Math.max(10, Math.min(500, options.lines ?? 120));
  const args = ["-s", serial, "logcat", "-d", "-t", String(lines)];
  if (options.filter && options.filter.trim()) {
    args.push("-s", options.filter.trim());
  }
  const res = await execText(bins.adb, args, { timeoutMs: 8000 });
  if (res.code !== 0)
    throw new Error(res.stderr.trim() || "adb logcat failed.");
  return res.stdout;
}
async function diagnoseEnvironment(options = {}, bins = resolveBinaries()) {
  const actionsTaken = [];
  if (options.attemptFix && bins.adb) {
    await execText(bins.adb, ["start-server"], { timeoutMs: 6000 });
    actionsTaken.push("Ensured adb server is running");
  }
  let kvmAccessible = null;
  if (process.platform === "linux") {
    if (!existsSync2("/dev/kvm")) {
      kvmAccessible = false;
    } else {
      try {
        accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
        kvmAccessible = true;
      } catch {
        kvmAccessible = false;
      }
    }
  }
  const [adbVer, emuVer, ffVer] = await Promise.all([
    bins.adb ? execText(bins.adb, ["version"], { timeoutMs: 3000 }) : Promise.resolve(null),
    bins.emulator ? execText(bins.emulator, ["-version"], { timeoutMs: 4000, env: androidToolEnv(bins.sdkRoot) }) : Promise.resolve(null),
    bins.ffmpeg ? execText(bins.ffmpeg, ["-version"], { timeoutMs: 3000 }) : Promise.resolve(null)
  ]);
  const devices = await discoverDevices(new Set, bins);
  const target = options.serial ? devices.find((d) => d.serial === options.serial || d.id === options.serial) : devices.find((d) => d.state === "booted");
  let deviceProbe = null;
  if (target?.serial && target.state === "booted") {
    if (options.attemptFix && bins.adb) {
      await execText(bins.adb, ["-s", target.serial, "shell", "rm", "-f", "/data/local/tmp/oc_ui_dump.xml"], {
        timeoutMs: 3000
      });
      actionsTaken.push(`Cleared stale uiautomator dump on ${target.serial}`);
    }
    let screencapOk = false;
    let screencapBytes = 0;
    let uiautomatorOk = false;
    let focus = null;
    let probeError = null;
    try {
      const png = await screencapPng(target.serial, bins);
      screencapOk = png.length > 8;
      screencapBytes = png.length;
    } catch (err) {
      probeError = err instanceof Error ? err.message : String(err);
    }
    try {
      const xml = await dumpUiXml(target.serial, bins);
      uiautomatorOk = xml.includes("<hierarchy");
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
      ...probeError ? { error: probeError } : {}
    };
  }
  return {
    sdkRoot: bins.sdkRoot,
    kvmAccessible,
    binaries: {
      adb: bins.adb ? { path: bins.adb, version: adbVer?.stdout.split(`
`)[0]?.trim() ?? null } : null,
      emulator: bins.emulator ? { path: bins.emulator, version: emuVer?.stdout.split(`
`)[0]?.trim() ?? null } : null,
      scrcpyServer: bins.scrcpyServer ? { path: bins.scrcpyServer } : null,
      ffmpeg: bins.ffmpeg ? { path: bins.ffmpeg, version: ffVer?.stdout.split(`
`)[0]?.trim() ?? null } : null
    },
    devices,
    deviceProbe,
    ...actionsTaken.length > 0 ? { actionsTaken } : {}
  };
}

// src/core/uiautomator.ts
import { spawn as spawn2 } from "node:child_process";
function decodeXmlEntities(value) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, code) => {
    const n = Number.parseInt(code, 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : _;
  });
}
function parseAttributes(raw) {
  const attrs = {};
  const attrRe = /([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(raw)) !== null) {
    const key = m[1];
    const val = m[2];
    if (key)
      attrs[key] = decodeXmlEntities(val ?? "");
  }
  return attrs;
}
function parseBounds(raw) {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(raw.trim());
  if (!m)
    return null;
  const left = Number.parseInt(m[1], 10);
  const top = Number.parseInt(m[2], 10);
  const right = Number.parseInt(m[3], 10);
  const bottom = Number.parseInt(m[4], 10);
  if (right <= left || bottom <= top)
    return null;
  return { left, top, right, bottom };
}
function parseUiHierarchyXml(xml, options = {}) {
  const flatNodes = [];
  const roots = [];
  const stack = [];
  const includeAll = options.includeNonInteractive === true;
  const limit = options.maxNodes ?? 200;
  const screen = options.screen ?? null;
  const tagRe = /<(\/?)node\b([^>]*?)(\/?)>/g;
  let m;
  let nextIndex = 1;
  let xmlDepth = 0;
  while ((m = tagRe.exec(xml)) !== null) {
    const isClosing = m[1] === "/";
    const rawAttrs = m[2] ?? "";
    const isSelfClosing = m[3] === "/";
    if (isClosing) {
      while (stack.length > 0 && stack[stack.length - 1].xmlDepth >= xmlDepth) {
        stack.pop();
      }
      xmlDepth = Math.max(0, xmlDepth - 1);
      continue;
    }
    const curDepth = xmlDepth;
    const attrs = parseAttributes(rawAttrs);
    const bounds = parseBounds(attrs.bounds ?? "");
    let keptMutable = null;
    if (bounds && flatNodes.length < limit) {
      const clickable = attrs.clickable === "true";
      const longClickable = attrs["long-clickable"] === "true";
      const scrollable = attrs.scrollable === "true";
      const checkable = attrs.checkable === "true";
      const checked = attrs.checked === "true";
      const selected = attrs.selected === "true";
      const password = attrs.password === "true";
      const enabled = attrs.enabled !== "false";
      const focused = attrs.focused === "true";
      const hidden = attrs["visible-to-user"] === "false";
      const className = attrs.class ?? "";
      const editable = attrs.editable === "true" || className.endsWith("EditText") || className.includes("TextInput");
      const text = (attrs.text ?? "").trim();
      const contentDesc = (attrs["content-desc"] ?? "").trim();
      const resourceId = (attrs["resource-id"] ?? "").trim();
      const packageName = (attrs.package ?? "").trim();
      const offScreen = screen ? bounds.right <= 0 || bounds.bottom <= 0 || bounds.left >= screen.width || bounds.top >= screen.height : false;
      const isInteractive = clickable || longClickable || scrollable || checkable || editable;
      const hasLabel = text.length > 0 || contentDesc.length > 0;
      if (includeAll || isInteractive || hasLabel) {
        let parentMutable = null;
        for (let i = stack.length - 1;i >= 0; i -= 1) {
          if (stack[i].keptNode) {
            parentMutable = stack[i].keptNode;
            break;
          }
        }
        const baseNode = {
          index: nextIndex,
          depth: parentMutable ? parentMutable.node.depth + 1 : 0,
          parentIndex: parentMutable ? parentMutable.node.index : null,
          text,
          contentDesc,
          resourceId,
          className,
          packageName,
          bounds,
          center: {
            x: Math.round((bounds.left + bounds.right) / 2),
            y: Math.round((bounds.top + bounds.bottom) / 2)
          },
          clickable,
          longClickable,
          scrollable,
          editable,
          checkable,
          checked,
          selected,
          password,
          enabled,
          focused,
          hidden,
          offScreen
        };
        nextIndex += 1;
        flatNodes.push(baseNode);
        keptMutable = { node: baseNode, children: [] };
        if (parentMutable) {
          parentMutable.children.push(keptMutable);
        } else {
          roots.push(keptMutable);
        }
      }
    }
    if (!isSelfClosing) {
      xmlDepth += 1;
      stack.push({ xmlDepth, keptNode: keptMutable });
    }
  }
  if (!options.tree)
    return flatNodes;
  const freezeTree = (item) => item.children.length > 0 ? { ...item.node, children: item.children.map(freezeTree) } : item.node;
  return roots.map(freezeTree);
}
function splitSelectorClauses(raw) {
  const clauses = [];
  let buf = "";
  let inRegex = false;
  let quote = null;
  const flush = () => {
    const trimmed = buf.trim();
    buf = "";
    if (!trimmed)
      return;
    const eq = trimmed.indexOf("=");
    const colon = trimmed.indexOf(":");
    const sep = eq !== -1 && (colon === -1 || eq < colon) ? eq : colon;
    if (sep <= 0) {
      clauses.push({ key: "anytext", value: trimmed });
      return;
    }
    const key = trimmed.slice(0, sep).trim().toLowerCase();
    let val = trimmed.slice(sep + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }
    clauses.push({ key, value: val });
  };
  for (let i = 0;i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote && raw[i - 1] !== "\\")
        quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "/" && buf.includes("=") || ch === "/" && inRegex) {
      inRegex = !inRegex;
      buf += ch;
      continue;
    }
    if (ch === "," && !inRegex) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return clauses;
}
function matchStringField(actual, expected) {
  if (expected === "*")
    return actual.length > 0;
  const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(expected);
  if (regexMatch) {
    try {
      const re = new RegExp(regexMatch[1], regexMatch[2] || "i");
      return re.test(actual);
    } catch {
      return false;
    }
  }
  return actual.toLowerCase().includes(expected.toLowerCase());
}
function parseBool(raw) {
  const low = raw.trim().toLowerCase();
  if (low === "true" || low === "1" || low === "yes")
    return true;
  if (low === "false" || low === "0" || low === "no")
    return false;
  return null;
}
function nodeMatchesClause(node, clause) {
  switch (clause.key) {
    case "text":
    case "txt":
      return matchStringField(node.text, clause.value);
    case "id":
    case "res":
    case "resourceid":
    case "resource-id":
      return matchStringField(node.resourceId, clause.value);
    case "desc":
    case "content":
    case "contentdesc":
    case "content-desc":
      return matchStringField(node.contentDesc, clause.value);
    case "anytext":
      return matchStringField(node.text, clause.value) || matchStringField(node.contentDesc, clause.value);
    case "class":
    case "clazz":
    case "cls":
    case "clz":
    case "classname":
      return matchStringField(node.className, clause.value);
    case "pkg":
    case "package":
      return matchStringField(node.packageName, clause.value);
    case "clickable":
      return parseBool(clause.value) === node.clickable;
    case "longclickable":
    case "long-clickable":
      return parseBool(clause.value) === node.longClickable;
    case "scrollable":
      return parseBool(clause.value) === node.scrollable;
    case "editable":
      return parseBool(clause.value) === node.editable;
    case "checkable":
      return parseBool(clause.value) === node.checkable;
    case "checked":
      return parseBool(clause.value) === node.checked;
    case "selected":
      return parseBool(clause.value) === node.selected;
    case "focused":
      return parseBool(clause.value) === node.focused;
    case "enabled":
      return parseBool(clause.value) === node.enabled;
    case "password":
      return parseBool(clause.value) === node.password;
    case "hidden":
      return parseBool(clause.value) === node.hidden;
    case "offscreen":
      return parseBool(clause.value) === node.offScreen;
    default:
      return false;
  }
}
function matchUiNodes(nodes, selector) {
  const flat = [];
  const collect = (list) => {
    for (const n of list) {
      flat.push(n);
      if (n.children)
        collect(n.children);
    }
  };
  collect(nodes);
  if (typeof selector === "string") {
    const clauses = splitSelectorClauses(selector);
    if (clauses.length === 0)
      return [];
    const allowHidden = clauses.some((c) => c.key === "hidden" || c.key === "offscreen");
    return flat.filter((n) => (allowHidden || !n.hidden && !n.offScreen) && clauses.every((c) => nodeMatchesClause(n, c)));
  }
  return flat.filter((n) => {
    if (!selector.includeHidden && (n.hidden || n.offScreen))
      return false;
    if (selector.text !== undefined && !matchStringField(n.text, selector.text))
      return false;
    if (selector.resourceId !== undefined && !matchStringField(n.resourceId, selector.resourceId))
      return false;
    if (selector.contentDesc !== undefined && !matchStringField(n.contentDesc, selector.contentDesc))
      return false;
    if (selector.className !== undefined && !matchStringField(n.className, selector.className))
      return false;
    if (selector.clickable !== undefined && n.clickable !== selector.clickable)
      return false;
    if (selector.longClickable !== undefined && n.longClickable !== selector.longClickable)
      return false;
    if (selector.scrollable !== undefined && n.scrollable !== selector.scrollable)
      return false;
    if (selector.editable !== undefined && n.editable !== selector.editable)
      return false;
    if (selector.checkable !== undefined && n.checkable !== selector.checkable)
      return false;
    if (selector.checked !== undefined && n.checked !== selector.checked)
      return false;
    if (selector.selected !== undefined && n.selected !== selector.selected)
      return false;
    if (selector.focused !== undefined && n.focused !== selector.focused)
      return false;
    if (selector.enabled !== undefined && n.enabled !== selector.enabled)
      return false;
    return true;
  });
}
var GLYPHS = {
  "#": ["101", "111", "101", "111", "101"],
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"]
};
function setPixel(buf, width, height, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= width || y >= height)
    return;
  const idx = (y * width + x) * 4;
  buf[idx] = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
  buf[idx + 3] = a;
}
function drawRectOutline(buf, width, height, left, top, right, bottom, thickness, color) {
  const [r, g, b] = color;
  for (let t = 0;t < thickness; t += 1) {
    for (let x = left;x <= right; x += 1) {
      setPixel(buf, width, height, x, top + t, r, g, b);
      setPixel(buf, width, height, x, bottom - t, r, g, b);
    }
    for (let y = top;y <= bottom; y += 1) {
      setPixel(buf, width, height, left + t, y, r, g, b);
      setPixel(buf, width, height, right - t, y, r, g, b);
    }
  }
}
function drawBadge(buf, width, height, x, y, label, color) {
  const scale = 2;
  const charW = 3 * scale;
  const gap = 2;
  const pad = 4;
  const textW = label.length * charW + Math.max(0, label.length - 1) * gap;
  const boxW = textW + pad * 2;
  const boxH = 5 * scale + pad * 2;
  const bx = Math.max(0, Math.min(width - boxW, x));
  const by = Math.max(0, Math.min(height - boxH, y));
  for (let py = by;py < by + boxH; py += 1) {
    for (let px = bx;px < bx + boxW; px += 1) {
      setPixel(buf, width, height, px, py, color[0], color[1], color[2], 240);
    }
  }
  let cursorX = bx + pad;
  const cursorY = by + pad;
  for (const ch of label) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (let gy = 0;gy < 5; gy += 1) {
        const row = glyph[gy] ?? "";
        for (let gx = 0;gx < 3; gx += 1) {
          if (row[gx] !== "1")
            continue;
          for (let sy = 0;sy < scale; sy += 1) {
            for (let sx = 0;sx < scale; sx += 1) {
              setPixel(buf, width, height, cursorX + gx * scale + sx, cursorY + gy * scale + sy, 255, 255, 255);
            }
          }
        }
      }
    }
    cursorX += charW + gap;
  }
}
function parsePngDimensions(png) {
  if (png.length < 24)
    return null;
  if (png.readUInt32BE(0) !== 2303741511)
    return null;
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20)
  };
}
function runFfmpegPipe(ffmpeg, args, input) {
  return new Promise((resolve, reject) => {
    const proc = spawn2(ffmpeg, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let errText = "";
    proc.stdout.on("data", (chunk) => chunks.push(chunk));
    proc.stderr.on("data", (chunk) => {
      errText += chunk.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0)
        resolve(Buffer.concat(chunks));
      else
        reject(new Error(errText.trim() || `ffmpeg exited ${code}`));
    });
    proc.stdin.end(input);
  });
}
async function annotateScreenshotPng(png, nodes) {
  const bins = resolveBinaries();
  const dims = parsePngDimensions(png);
  if (!bins.ffmpeg || !dims || nodes.length === 0)
    return png;
  const rgba = await runFfmpegPipe(bins.ffmpeg, ["-v", "error", "-f", "image2pipe", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], png);
  if (rgba.length !== dims.width * dims.height * 4)
    return png;
  const palette = [
    [220, 38, 38],
    [37, 99, 235],
    [5, 150, 105],
    [217, 119, 6],
    [124, 58, 237]
  ];
  const drawNode = (node) => {
    if (!node.hidden && !node.offScreen && (node.clickable || node.editable || node.scrollable || node.checkable)) {
      const color = palette[(node.index - 1) % palette.length];
      drawRectOutline(rgba, dims.width, dims.height, node.bounds.left, node.bounds.top, node.bounds.right, node.bounds.bottom, 3, color);
      drawBadge(rgba, dims.width, dims.height, node.bounds.left, Math.max(0, node.bounds.top - 18), `#${node.index}`, color);
    }
    if (node.children) {
      for (const child of node.children)
        drawNode(child);
    }
  };
  for (const node of nodes)
    drawNode(node);
  return runFfmpegPipe(bins.ffmpeg, [
    "-v",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${dims.width}x${dims.height}`,
    "-i",
    "pipe:0",
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "pipe:1"
  ], rgba);
}

// src/core/controller.ts
var TEMP_DIR = "/tmp/opencode";
var KEYCODE_DEL = 67;
var KEYCODE_ENTER = 66;
var KEYCODE_MOVE_END = 123;
var SAFE_SCREENSHOT_NAME_RE = /^[A-Za-z0-9._-]+$/;
function ensureTempDir() {
  mkdirSync(TEMP_DIR, { recursive: true });
  return TEMP_DIR;
}
function safeSerialTag(serial) {
  return serial.replace(/[^A-Za-z0-9_.-]/g, "_");
}
function resolveScreenshotPath(serial, rawFilename) {
  const dir = ensureTempDir();
  if (rawFilename === undefined || rawFilename === null) {
    return path3.join(dir, `android-sim-${safeSerialTag(serial)}-${Date.now()}.png`);
  }
  if (typeof rawFilename !== "string") {
    throw new Error("filename must be a string when provided.");
  }
  const trimmed = rawFilename.trim();
  if (!trimmed) {
    return path3.join(dir, `android-sim-${safeSerialTag(serial)}-${Date.now()}.png`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\x00") || trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    throw new Error('filename must be a plain file name under /tmp/opencode/ (no path separators or "..").');
  }
  if (!SAFE_SCREENSHOT_NAME_RE.test(trimmed)) {
    throw new Error('filename may only contain letters, digits, ".", "_", and "-".');
  }
  const withExt = trimmed.toLowerCase().endsWith(".png") ? trimmed : `${trimmed}.png`;
  const resolved = path3.resolve(dir, withExt);
  const resolvedDir = path3.resolve(dir);
  if (!resolved.startsWith(`${resolvedDir}${path3.sep}`)) {
    throw new Error("filename resolved outside /tmp/opencode/.");
  }
  return resolved;
}
var deviceLocks = new Map;
async function withDeviceLock(serial, fn) {
  const prev = deviceLocks.get(serial) ?? Promise.resolve();
  let release;
  const gate = new Promise((r) => {
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
var lastLayoutBySerial = new Map;
function resolveKeycodeNumber(raw) {
  if (typeof raw === "number" && Number.isFinite(raw))
    return Math.round(raw);
  if (typeof raw === "string") {
    const upper = raw.trim().toUpperCase().replace(/^KEYCODE_/, "");
    const map = {
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
      RECENTS: 187
    };
    if (upper in map)
      return map[upper];
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed))
      return parsed;
  }
  throw new Error(`Unknown Android keycode: ${String(raw)}`);
}
async function resolveBootedSerial(requestedSerial, preferredSerial) {
  const devices = await discoverDevices();
  const booted = devices.filter((d) => d.state === "booted" && d.serial);
  if (typeof requestedSerial === "string" && requestedSerial.trim()) {
    const wanted = requestedSerial.trim();
    const match = booted.find((d) => d.serial === wanted || d.id === wanted || d.avdName === wanted);
    if (!match?.serial) {
      throw new Error(`Device "${wanted}" is not booted or not found.`);
    }
    return match.serial;
  }
  if (preferredSerial) {
    const pref = booted.find((d) => d.serial === preferredSerial || d.id === preferredSerial);
    if (pref?.serial)
      return pref.serial;
  }
  if (booted.length === 1 && booted[0]?.serial) {
    return booted[0].serial;
  }
  if (booted.length === 0) {
    const offAvds = devices.filter((d) => d.kind === "avd" && d.avdName).map((d) => d.avdName);
    throw new Error(offAvds.length > 0 ? `No Android device is booted. Available AVDs: ${offAvds.join(", ")}. Call android_device with action="boot" first.` : "No booted Android emulator or ADB device found.");
  }
  throw new Error(`Multiple booted Android devices found (${booted.map((d) => d.serial).join(", ")}). Specify "serial".`);
}
function summarizeNode(n) {
  const label = n.text || n.contentDesc || n.resourceId || n.className.split(".").pop() || "node";
  return `#${n.index} "${label.slice(0, 40)}" (${n.center.x},${n.center.y})`;
}
async function captureFreshFlatLayout(serial, bins) {
  const [xml, size] = await Promise.all([
    dumpUiXml(serial, bins),
    queryScreenSize(serial, bins)
  ]);
  const nodes = parseUiHierarchyXml(xml, {
    includeNonInteractive: false,
    maxNodes: 200,
    screen: size,
    tree: false
  });
  lastLayoutBySerial.set(serial, { nodes, screen: size, capturedAt: Date.now() });
  return { nodes, screen: size };
}
function parseNodeIndex(raw) {
  if (typeof raw === "number" && Number.isFinite(raw))
    return Math.round(raw);
  if (typeof raw === "string") {
    const m = /^#?(\d+)$/.exec(raw.trim());
    if (m)
      return Number.parseInt(m[1], 10);
  }
  return null;
}
async function resolveNodeBySelector(serial, selector, options, bins) {
  const waitMs = Math.max(0, Math.min(15000, options.waitMs ?? 0));
  const matchMode = options.match === "first" ? "first" : "single";
  const deadline = Date.now() + waitMs;
  while (true) {
    const { nodes } = await captureFreshFlatLayout(serial, bins);
    const matches = matchUiNodes(nodes, selector);
    if (matches.length === 1)
      return matches[0];
    if (matches.length > 1) {
      if (matchMode === "first")
        return matches[0];
      throw new Error(`Selector matched ${matches.length} nodes (pass match="first" or narrow selector): ${matches.slice(0, 5).map(summarizeNode).join(", ")}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`No UI node matched selector ${JSON.stringify(selector)}.`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
async function resolveTargetPoint(serial, step, bins) {
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
  if (step.selector !== undefined && step.selector !== null && step.selector !== "") {
    const matched = await resolveNodeBySelector(serial, step.selector, {
      match: step.match === "first" ? "first" : "single",
      waitMs: typeof step.waitMs === "number" ? step.waitMs : 0
    }, bins);
    return { x: matched.center.x, y: matched.center.y, matchedNode: matched };
  }
  const nx = Number(step.x);
  const ny = Number(step.y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    throw new Error('Provide "x" & "y", "node", or "selector".');
  }
  const normalized = step.normalized === true;
  if (normalized || nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 && (nx % 1 !== 0 || ny % 1 !== 0)) {
    const size = await queryScreenSize(serial, bins);
    if (!size)
      throw new Error(`Could not query screen size for ${serial}.`);
    return {
      x: Math.round(Math.max(0, Math.min(1, nx)) * (size.width - 1)),
      y: Math.round(Math.max(0, Math.min(1, ny)) * (size.height - 1))
    };
  }
  return { x: Math.round(nx), y: Math.round(ny) };
}
async function runSingleInputStep(serial, step, ctx, bins) {
  const action = String(step.action ?? "");
  switch (action) {
    case "wait": {
      const ms = Math.max(0, Math.min(15000, Number(step.ms ?? step.durationMs ?? 300)));
      await new Promise((r) => setTimeout(r, ms));
      return { action: "wait", ms };
    }
    case "tap": {
      const target = await resolveTargetPoint(serial, step, bins);
      const usedScrcpy = await ctx.onScrcpyTap?.(serial, target.x, target.y) ?? false;
      if (!usedScrcpy)
        await adbTap(serial, target.x, target.y, bins);
      return {
        action: "tap",
        x: target.x,
        y: target.y,
        ...target.matchedNode ? { node: summarizeNode(target.matchedNode) } : {},
        transport: usedScrcpy ? "scrcpy" : "adb"
      };
    }
    case "long_press": {
      const target = await resolveTargetPoint(serial, step, bins);
      const durationMs = Math.max(300, Math.min(5000, Number(step.durationMs ?? 700)));
      const usedScrcpy = await ctx.onScrcpyTap?.(serial, target.x, target.y, durationMs) ?? false;
      if (!usedScrcpy) {
        await adbSwipe(serial, target.x, target.y, target.x, target.y, durationMs, bins);
      }
      return {
        action: "long_press",
        x: target.x,
        y: target.y,
        durationMs,
        ...target.matchedNode ? { node: summarizeNode(target.matchedNode) } : {},
        transport: usedScrcpy ? "scrcpy" : "adb"
      };
    }
    case "swipe": {
      const p1 = await resolveTargetPoint(serial, step, bins);
      const p2 = await resolveTargetPoint(serial, { x: step.x2, y: step.y2, normalized: step.normalized }, bins);
      const durationMs = typeof step.durationMs === "number" ? step.durationMs : 300;
      await adbSwipe(serial, p1.x, p1.y, p2.x, p2.y, durationMs, bins);
      return { action: "swipe", from: { x: p1.x, y: p1.y }, to: { x: p2.x, y: p2.y }, durationMs };
    }
    case "scroll": {
      const direction = String(step.direction ?? "down").toLowerCase();
      if (!["up", "down", "left", "right"].includes(direction)) {
        throw new Error(`Invalid scroll direction: ${direction}`);
      }
      const durationMs = Math.max(120, Math.min(2000, Number(step.durationMs ?? 350)));
      const until = step.until;
      const maxScrolls = Math.max(1, Math.min(15, Number(step.maxScrolls ?? 5)));
      let bounds = null;
      if (step.node !== undefined || step.selector !== undefined) {
        const target = await resolveTargetPoint(serial, step, bins);
        bounds = target.matchedNode?.bounds ?? null;
      }
      const layout = await captureFreshFlatLayout(serial, bins);
      if (until) {
        const already = matchUiNodes(layout.nodes, until);
        if (already.length > 0) {
          return { action: "scroll", direction, scrolls: 0, found: summarizeNode(already[0]) };
        }
      }
      if (!bounds) {
        const scrollables = layout.nodes.filter((n) => n.scrollable && !n.hidden && !n.offScreen).sort((a, b) => (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top) - (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top));
        if (scrollables[0]) {
          bounds = scrollables[0].bounds;
        } else {
          const size = layout.screen ?? await queryScreenSize(serial, bins) ?? { width: 1080, height: 2400 };
          bounds = { left: 0, top: 0, right: size.width, bottom: size.height };
        }
      }
      const cx = Math.round((bounds.left + bounds.right) / 2);
      const cy = Math.round((bounds.top + bounds.bottom) / 2);
      const spanX = Math.max(40, Math.round((bounds.right - bounds.left) * 0.3));
      const spanY = Math.max(40, Math.round((bounds.bottom - bounds.top) * 0.3));
      const [x1, y1, x2, y2] = direction === "down" ? [cx, cy + spanY, cx, cy - spanY] : direction === "up" ? [cx, cy - spanY, cx, cy + spanY] : direction === "right" ? [cx + spanX, cy, cx - spanX, cy] : [cx - spanX, cy, cx + spanX, cy];
      const attempts = until ? maxScrolls : 1;
      for (let i = 1;i <= attempts; i += 1) {
        await adbSwipe(serial, x1, y1, x2, y2, durationMs, bins);
        if (until) {
          await new Promise((r) => setTimeout(r, 250));
          const nextLayout = await captureFreshFlatLayout(serial, bins);
          const found = matchUiNodes(nextLayout.nodes, until);
          if (found.length > 0) {
            return {
              action: "scroll",
              direction,
              scrolls: i,
              found: summarizeNode(found[0])
            };
          }
        }
      }
      return {
        action: "scroll",
        direction,
        scrolls: attempts,
        ...until ? { found: null } : {}
      };
    }
    case "text": {
      const text = String(step.text ?? "");
      if (!text)
        throw new Error('"text" is required for action="text".');
      let focusedNode;
      if (step.node !== undefined || step.selector !== undefined || step.x !== undefined && step.y !== undefined) {
        const target = await resolveTargetPoint(serial, step, bins);
        focusedNode = target.matchedNode;
        const usedTap = await ctx.onScrcpyTap?.(serial, target.x, target.y) ?? false;
        if (!usedTap)
          await adbTap(serial, target.x, target.y, bins);
        await new Promise((r) => setTimeout(r, 120));
      }
      if (step.clearFirst === true) {
        const clearLen = focusedNode?.text ? Math.min(80, focusedNode.text.length + 4) : 40;
        await adbKey(serial, KEYCODE_MOVE_END, bins);
        for (let i = 0;i < Math.min(clearLen, 24); i += 1) {
          await adbKey(serial, KEYCODE_DEL, bins);
        }
      }
      const usedScrcpy = await ctx.onScrcpyText?.(serial, text) ?? false;
      if (!usedScrcpy)
        await adbText(serial, text, bins);
      if (step.submit === true) {
        const sentEnter = await ctx.onScrcpyKey?.(serial, KEYCODE_ENTER) ?? false;
        if (!sentEnter)
          await adbKey(serial, KEYCODE_ENTER, bins);
      }
      return {
        action: "text",
        length: text.length,
        submitted: step.submit === true,
        ...focusedNode ? { node: summarizeNode(focusedNode) } : {},
        transport: usedScrcpy ? "scrcpy" : "adb"
      };
    }
    case "key": {
      const keycode = resolveKeycodeNumber(step.keycode);
      const usedScrcpy = await ctx.onScrcpyKey?.(serial, keycode) ?? false;
      if (!usedScrcpy)
        await adbKey(serial, keycode, bins);
      return { action: "key", keycode, transport: usedScrcpy ? "scrcpy" : "adb" };
    }
    case "back": {
      const usedScrcpy = await ctx.onScrcpyKey?.(serial, 4) ?? false;
      if (!usedScrcpy)
        await adbKey(serial, 4, bins);
      return { action: "back", keycode: 4 };
    }
    case "home": {
      const usedScrcpy = await ctx.onScrcpyKey?.(serial, 3) ?? false;
      if (!usedScrcpy)
        await adbKey(serial, 3, bins);
      return { action: "home", keycode: 3 };
    }
    case "recents": {
      const usedScrcpy = await ctx.onScrcpyKey?.(serial, 187) ?? false;
      if (!usedScrcpy)
        await adbKey(serial, 187, bins);
      return { action: "recents", keycode: 187 };
    }
    case "power": {
      const usedScrcpy = await ctx.onScrcpyKey?.(serial, 26) ?? false;
      if (!usedScrcpy)
        await adbKey(serial, 26, bins);
      return { action: "power", keycode: 26 };
    }
    default:
      throw new Error(`Unsupported android_input action: ${action}`);
  }
}
async function executeAgentTool(tool, input, ctx = {}) {
  const bins = resolveBinaries();
  if (tool === "android_device") {
    const action = String(input.action ?? "list");
    switch (action) {
      case "list": {
        const devices = await discoverDevices(new Set, bins);
        return {
          devices,
          selectedSerial: ctx.preferredSerial ?? null,
          tools: {
            adb: Boolean(bins.adb),
            emulator: Boolean(bins.emulator),
            scrcpyServer: Boolean(bins.scrcpyServer),
            ffmpeg: Boolean(bins.ffmpeg)
          }
        };
      }
      case "select": {
        const id = String(input.serial ?? input.avd ?? "").trim();
        if (!id)
          throw new Error('Provide "serial" or "avd" to select.');
        const devices = await discoverDevices(new Set, bins);
        const match = devices.find((d) => d.id === id || d.serial === id || d.avdName === id);
        if (!match)
          throw new Error(`Device "${id}" not found.`);
        ctx.onSelectDevice?.(match.id);
        return { selected: match };
      }
      case "connect": {
        const address = String(input.address ?? input.serial ?? "").trim();
        const message = await connectTcpDevice(address, bins);
        ctx.onDeviceListChanged?.();
        return { address, message };
      }
      case "boot": {
        const devices = await discoverDevices(new Set, bins);
        let avdName = typeof input.avd === "string" && input.avd.trim() ? input.avd.trim() : null;
        if (!avdName && typeof input.serial === "string" && input.serial.startsWith("avd:")) {
          avdName = input.serial.slice(4);
        }
        if (!avdName) {
          const avds = devices.filter((d) => d.avdName);
          if (avds.length === 1 && avds[0]?.avdName)
            avdName = avds[0].avdName;
          else if (avds.length === 0)
            throw new Error("No Android Virtual Devices (AVDs) configured.");
          else {
            throw new Error(`Multiple AVDs found (${avds.map((d) => d.avdName).join(", ")}). Specify "avd".`);
          }
        }
        const booted = await bootAvd(avdName, { headless: input.headless !== false, cold: input.cold === true }, bins);
        ctx.onSelectDevice?.(booted.id);
        ctx.onDeviceListChanged?.();
        return { device: booted };
      }
      case "shutdown": {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const message = await shutdownDevice(serial, bins);
        lastLayoutBySerial.delete(serial);
        ctx.onDeviceListChanged?.();
        return { serial, message };
      }
      case "diagnose": {
        const serial = typeof input.serial === "string" && input.serial.trim() ? input.serial.trim() : ctx.preferredSerial ?? undefined;
        return diagnoseEnvironment({ serial, attemptFix: input.attemptFix === true }, bins);
      }
      case "rotate": {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        return withDeviceLock(serial, async () => {
          const deg = input.rotation === 0 || input.rotation === 90 || input.rotation === 180 || input.rotation === 270 ? input.rotation : undefined;
          const rotation = await setRotation(serial, deg, bins);
          return { serial, rotation };
        });
      }
      case "appearance": {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        return withDeviceLock(serial, async () => {
          const mode = input.appearance === "dark" || input.appearance === "light" ? input.appearance : "dark";
          const applied = await setAppearance(serial, mode, bins);
          return { serial, appearance: applied };
        });
      }
      case "open_url": {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const url = String(input.url ?? "").trim();
        if (!url)
          throw new Error('"url" is required for action="open_url".');
        return withDeviceLock(serial, async () => {
          const output = await openUrl(serial, url, bins);
          return { serial, url, output };
        });
      }
      case "install_apk": {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const paths = Array.isArray(input.apkPaths) ? input.apkPaths.map((p) => String(p).trim()).filter(Boolean) : String(input.apkPath ?? "").trim();
        const grantPermissions = input.grantPermissions === true;
        return withDeviceLock(serial, async () => {
          const output = await installApk(serial, paths, { grantPermissions }, bins);
          return { serial, output };
        });
      }
      case "launch": {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const pkg = String(input.package ?? "").trim();
        const activity = typeof input.activity === "string" ? input.activity : undefined;
        return withDeviceLock(serial, async () => {
          const output = await launchApp(serial, pkg, activity, bins);
          return { serial, package: pkg, output };
        });
      }
      case "stop_app": {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const pkg = String(input.package ?? "").trim();
        return withDeviceLock(serial, async () => {
          const output = await stopApp(serial, pkg, bins);
          return { serial, package: pkg, output };
        });
      }
      case "clear_data": {
        const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
        const pkg = String(input.package ?? "").trim();
        return withDeviceLock(serial, async () => {
          const output = await clearAppData(serial, pkg, bins);
          return { serial, package: pkg, output };
        });
      }
      default:
        throw new Error(`Unsupported android_device action: ${action}`);
    }
  }
  if (tool === "android_input") {
    const action = String(input.action ?? "");
    const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
    return withDeviceLock(serial, async () => {
      if (action === "sequence") {
        const steps = Array.isArray(input.steps) ? input.steps : [];
        if (steps.length === 0)
          throw new Error('"steps" array is required for action="sequence".');
        if (steps.length > 30)
          throw new Error("Maximum 30 steps per sequence.");
        const results = [];
        for (const rawStep of steps) {
          if (!rawStep || typeof rawStep !== "object") {
            throw new Error("Each sequence step must be an object.");
          }
          results.push(await runSingleInputStep(serial, rawStep, ctx, bins));
        }
        return { serial, action: "sequence", results };
      }
      const result = await runSingleInputStep(serial, input, ctx, bins);
      return { serial, ...result };
    });
  }
  if (tool === "android_inspect") {
    const action = String(input.action ?? "layout");
    const serial = await resolveBootedSerial(input.serial, ctx.preferredSerial);
    return withDeviceLock(serial, async () => {
      switch (action) {
        case "screenshot": {
          const filePath = resolveScreenshotPath(serial, input.filename);
          const [png, size, focus] = await Promise.all([
            screencapPng(serial, bins),
            queryScreenSize(serial, bins),
            queryCurrentFocus(serial, bins)
          ]);
          writeFileSync(filePath, png);
          const width = size?.width ?? (png.length >= 24 ? png.readUInt32BE(16) : 0);
          const height = size?.height ?? (png.length >= 24 ? png.readUInt32BE(20) : 0);
          return { serial, path: filePath, width, height, currentFocus: focus };
        }
        case "layout": {
          const [xml, size, focus] = await Promise.all([
            dumpUiXml(serial, bins),
            queryScreenSize(serial, bins),
            queryCurrentFocus(serial, bins)
          ]);
          const includeAll = input.includeAll === true;
          const maxNodes = typeof input.maxNodes === "number" ? input.maxNodes : 120;
          const flatNodes = parseUiHierarchyXml(xml, {
            includeNonInteractive: includeAll,
            maxNodes,
            screen: size,
            tree: false
          });
          lastLayoutBySerial.set(serial, {
            nodes: flatNodes,
            screen: size,
            capturedAt: Date.now()
          });
          const nodes = input.tree === true ? parseUiHierarchyXml(xml, {
            includeNonInteractive: includeAll,
            maxNodes,
            screen: size,
            tree: true
          }) : flatNodes;
          let annotatedPath = null;
          if (input.annotate === true) {
            const png = await screencapPng(serial, bins);
            const annotated = await annotateScreenshotPng(png, flatNodes);
            const dir = ensureTempDir();
            annotatedPath = path3.join(dir, `android-layout-${safeSerialTag(serial)}-${Date.now()}.png`);
            writeFileSync(annotatedPath, annotated);
          }
          return {
            serial,
            currentFocus: focus,
            screen: size,
            nodeCount: flatNodes.length,
            ...annotatedPath ? { annotatedPath } : {},
            nodes
          };
        }
        case "logcat": {
          const lines = typeof input.lines === "number" ? input.lines : 120;
          const filter = typeof input.filter === "string" ? input.filter : undefined;
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

// src/service/state-file.ts
import { chmodSync, existsSync as existsSync3, readFileSync as readFileSync2, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import os3 from "node:os";
import path4 from "node:path";

// src/shared/protocol.ts
var SERVICE_DISCOVERY_FILENAME = "openchamber-android-simulator-service.json";

// src/service/state-file.ts
function discoveryFilePath() {
  return path4.join(os3.tmpdir(), SERVICE_DISCOVERY_FILENAME);
}
function readServiceDiscovery() {
  const file = discoveryFilePath();
  if (!existsSync3(file))
    return null;
  try {
    const raw = JSON.parse(readFileSync2(file, "utf8"));
    if (typeof raw.port === "number" && raw.port > 0 && typeof raw.token === "string" && raw.token.length > 0 && typeof raw.pid === "number") {
      return raw;
    }
  } catch {}
  return null;
}

// plugin/src/index.ts
function exemptLocalhostFromProxy() {
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const existing = (process.env[key] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const host of ["127.0.0.1", "localhost"]) {
      if (!existing.includes(host))
        existing.push(host);
    }
    process.env[key] = existing.join(",");
  }
}
async function runTool(tool, input) {
  const discovery = readServiceDiscovery();
  if (discovery) {
    const action = String(input.action ?? "");
    const timeoutMs = action === "boot" || action === "install_apk" || action === "sequence" || action === "scroll" ? 125000 : 30000;
    const ctrl = new AbortController;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${discovery.port}/agent/tool`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${discovery.token}`
        },
        body: JSON.stringify({ tool, input }),
        signal: ctrl.signal
      });
      if (res.ok) {
        const body = await res.json();
        if (body.ok) {
          return { content: JSON.stringify(body.data) };
        }
        return { content: JSON.stringify({ ok: false, error: body.error ?? "Tool failed" }) };
      }
      if (res.status !== 401 && res.status !== 404) {
        const errText = await res.text().catch(() => "");
        return { content: JSON.stringify({ ok: false, error: errText || `HTTP ${res.status}` }) };
      }
    } catch {} finally {
      clearTimeout(timer);
    }
  }
  try {
    const data = await executeAgentTool(tool, input);
    return { content: JSON.stringify(data) };
  } catch (err) {
    return {
      content: JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
    };
  }
}
var src_default = {
  id: "android-simulator-plugin",
  setup: async (ctx) => {
    exemptLocalhostFromProxy();
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "android_device",
        description: 'Manage Android emulators (AVDs), ADB devices, and apps (list, select, connect, boot, shutdown, launch, stop_app, clear_data, install_apk, open_url, rotate, appearance, diagnose). Never boots automatically unless action="boot" is requested.',
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "list",
                "select",
                "connect",
                "boot",
                "shutdown",
                "launch",
                "stop_app",
                "clear_data",
                "rotate",
                "appearance",
                "open_url",
                "install_apk",
                "diagnose"
              ],
              description: "Device or app lifecycle action."
            },
            serial: {
              type: "string",
              description: 'Target ADB serial (e.g. "emulator-5554") or AVD id ("avd:name").'
            },
            address: {
              type: "string",
              description: 'For action="connect": host:port of a TCP/Tailscale/Redroid ADB device.'
            },
            avd: {
              type: "string",
              description: 'AVD name for action="boot".'
            },
            headless: {
              type: "boolean",
              description: "For boot: run emulator with -no-window (default true)."
            },
            cold: {
              type: "boolean",
              description: "For boot: cold boot with -no-snapshot-load."
            },
            package: {
              type: "string",
              description: "Android package name for launch, stop_app, or clear_data."
            },
            activity: {
              type: "string",
              description: 'Optional activity name for action="launch".'
            },
            rotation: {
              type: "number",
              enum: [0, 90, 180, 270],
              description: 'Target rotation in degrees for action="rotate" (omit to toggle 0/90).'
            },
            appearance: {
              type: "string",
              enum: ["light", "dark"],
              description: 'Theme mode for action="appearance".'
            },
            url: {
              type: "string",
              description: 'URL or deep link for action="open_url".'
            },
            apkPath: {
              type: "string",
              description: 'Path to .apk file (supports ~/) for action="install_apk".'
            },
            apkPaths: {
              type: "array",
              items: { type: "string" },
              description: "Multiple .apk paths for split-APK install_apk."
            },
            grantPermissions: {
              type: "boolean",
              description: "For install_apk: pass -g to auto-grant runtime permissions."
            },
            attemptFix: {
              type: "boolean",
              description: "For diagnose: restart adb server and clear stale uiautomator dumps."
            }
          },
          required: ["action"],
          additionalProperties: false
        },
        execute: (input) => runTool("android_device", input)
      });
      tools.add({
        name: "android_input",
        description: 'Send touch, long_press, swipe, scroll, text, key, or batched sequence events to a booted Android device. Supports semantic selectors (e.g. "text=Submit,clickable=true"), #N node indices from the latest layout, waitMs polling, and pixel/normalized coordinates.',
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "tap",
                "long_press",
                "swipe",
                "scroll",
                "text",
                "key",
                "back",
                "home",
                "recents",
                "power",
                "sequence"
              ],
              description: "Input event or sequence to send."
            },
            serial: {
              type: "string",
              description: "Target ADB serial (optional when a single device is booted/selected)."
            },
            node: {
              type: ["number", "string"],
              description: 'Target #N node index from the latest layout snapshot (e.g. 5 or "#5").'
            },
            selector: {
              type: ["string", "object"],
              description: 'Semantic UI selector string (e.g. "text=Submit,clickable=true", "id=arm_btn", "desc=/play/i") or object ({ text, resourceId, contentDesc, className, clickable, scrollable, editable, checked, selected, focused }).'
            },
            match: {
              type: "string",
              enum: ["single", "first"],
              description: 'Ambiguity policy for selector (default "single" fails if >1 node matches).'
            },
            waitMs: {
              type: "number",
              description: "Poll for selector up to waitMs milliseconds (max 15000)."
            },
            x: {
              type: "number",
              description: "Tap, long_press, or swipe-start X coordinate (pixels, or 0..1 if normalized=true)."
            },
            y: {
              type: "number",
              description: "Tap, long_press, or swipe-start Y coordinate (pixels, or 0..1 if normalized=true)."
            },
            x2: {
              type: "number",
              description: "Swipe-end X coordinate."
            },
            y2: {
              type: "number",
              description: "Swipe-end Y coordinate."
            },
            direction: {
              type: "string",
              enum: ["up", "down", "left", "right"],
              description: 'For action="scroll": direction of content to reveal (default "down").'
            },
            until: {
              type: ["string", "object"],
              description: 'For action="scroll": scroll repeatedly until this selector appears.'
            },
            maxScrolls: {
              type: "number",
              description: 'For action="scroll" with until: max scroll attempts (default 5, max 15).'
            },
            durationMs: {
              type: "number",
              description: "Duration in ms for swipe/scroll/long_press."
            },
            normalized: {
              type: "boolean",
              description: "Interpret x/y as normalized 0..1 screen fractions."
            },
            text: {
              type: "string",
              description: 'Text string to type for action="text".'
            },
            clearFirst: {
              type: "boolean",
              description: 'For action="text": clear existing field text before typing.'
            },
            submit: {
              type: "boolean",
              description: 'For action="text": press ENTER after typing.'
            },
            keycode: {
              type: ["number", "string"],
              description: 'Android KeyEvent code or name (e.g. "ENTER", "DEL", "VOLUME_UP", 66).'
            },
            steps: {
              type: "array",
              items: { type: "object" },
              description: 'For action="sequence": ordered list of input steps (including { action: "wait", ms }).'
            }
          },
          required: ["action"],
          additionalProperties: false
        },
        execute: (input) => runTool("android_input", input)
      });
      tools.add({
        name: "android_inspect",
        description: "Inspect a booted Android device: dump structured uiautomator UI hierarchy (flat or nested tree with #N indices, center coords, hidden/offScreen flags, and optional #N annotated PNG under /tmp/opencode/), capture a PNG screenshot saved under /tmp/opencode/ (returning { serial, path, width, height, currentFocus }), or read logcat.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["layout", "screenshot", "logcat"],
              description: "Inspection action."
            },
            serial: {
              type: "string",
              description: "Target ADB serial (optional when one device is booted/selected)."
            },
            filename: {
              type: "string",
              description: 'For action="screenshot": optional output file name under /tmp/opencode/ (e.g. "screen_light.png"). Defaults to android-sim-<serial>-<timestamp>.png.'
            },
            annotate: {
              type: "boolean",
              description: 'For action="layout": also write an annotated PNG with #N bounding boxes.'
            },
            tree: {
              type: "boolean",
              description: 'For action="layout": return nested parent/children tree instead of flat list.'
            },
            includeAll: {
              type: "boolean",
              description: 'For action="layout": include non-interactive/unlabeled nodes.'
            },
            maxNodes: {
              type: "number",
              description: 'For action="layout": maximum nodes to return (default 120).'
            },
            lines: {
              type: "number",
              description: 'For action="logcat": number of recent log lines (default 120).'
            },
            filter: {
              type: "string",
              description: 'For action="logcat": optional tag filter spec (e.g. "AndroidRuntime:E *:S").'
            },
            clear: {
              type: "boolean",
              description: 'For action="logcat": clear logcat buffer instead of reading.'
            }
          },
          required: ["action"],
          additionalProperties: false
        },
        execute: (input) => runTool("android_inspect", input)
      });
    });
  }
};
export {
  src_default as default
};
