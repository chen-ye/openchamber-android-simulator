// src/service/main.ts
import http from "node:http";
// node_modules/@openchamber/sdk/dist/scrollbar-style.js
var GUEST_SCROLLING_ATTRIBUTE = "data-oc-scrolling";
var GUEST_SCROLLBAR_CSS = `
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;
function installGuestScrollbarActivity(doc) {
  const root = doc.documentElement;
  if (root.hasAttribute("data-oc-scrollbar-activity"))
    return;
  root.setAttribute("data-oc-scrollbar-activity", "");
  const timers = new WeakMap;
  doc.addEventListener("scroll", (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element))
      return;
    if (!target.hasAttribute("data-oc-scrolling"))
      target.setAttribute("data-oc-scrolling", "");
    const pending = timers.get(target);
    if (pending !== undefined)
      clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-oc-scrolling");
    }, 1000));
  }, { capture: true, passive: true });
}
var GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;
// node_modules/@openchamber/sdk/dist/manifest.js
var GUEST_PROVIDER_LOGO_BYTES_MAX = 1024 * 1024;
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);
// node_modules/@openchamber/sdk/dist/session-events.js
var GUEST_SESSION_EVENT_TYPES = [
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
];
var SESSION_EVENTS_IDLE_MS = 10 * 60000;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);
// node_modules/@openchamber/sdk/dist/service-host.js
var SERVICE_HOST_PATH = "/service/call";
var OPENCHAMBER_HOST_CALLBACK_URL_ENV = "OPENCHAMBER_HOST_CALLBACK_URL";
var SERVICE_HOST_TIMEOUT_MS = 30000;
var SERVICE_SCHEDULE_IDLE_MS = 10 * 60000;
var MENTIONS_IDLE_MS = 10 * 60000;
class ServiceHostError extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "ServiceHostError";
    this.code = code;
    this.status = status;
  }
}
var createServiceHost = ({ env }) => {
  const call = async (method, input) => {
    const base = env[OPENCHAMBER_HOST_CALLBACK_URL_ENV];
    const token = env.OPENCHAMBER_SERVICE_TOKEN;
    if (!base || !token)
      throw new ServiceHostError("This service was not started by OpenChamber.", "HOST_UNAVAILABLE", 0);
    let response;
    try {
      response = await fetch(`${base.replace(/\/+$/, "")}${SERVICE_HOST_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, input }),
        signal: AbortSignal.timeout(SERVICE_HOST_TIMEOUT_MS)
      });
    } catch {
      throw new ServiceHostError("OpenChamber did not answer.", "HOST_UNAVAILABLE", 0);
    }
    const body = await response.json().catch(() => null);
    if (response.ok && body?.result !== undefined)
      return body.result;
    throw new ServiceHostError(body?.error?.message ?? `OpenChamber answered HTTP ${response.status}.`, body?.error?.code ?? "HOST_UNAVAILABLE", response.status);
  };
  return {
    sessions: {
      start: (input) => call("sessions.start", input),
      send: (sessionId, prompt) => call("sessions.send", { sessionId, prompt }),
      retry: (sessionId) => call("sessions.retry", { sessionId }),
      status: (sessionId) => call("sessions.status", { sessionId }),
      lastReply: (sessionId) => call("sessions.lastReply", { sessionId }),
      stop: (sessionId) => call("sessions.stop", { sessionId }),
      answerPermission: (sessionId, requestId, answer) => call("sessions.answerPermission", { sessionId, requestId, ...answer }),
      answerForm: (sessionId, formId, values, message) => call("sessions.answerForm", { sessionId, formId, values, ...message === undefined ? {} : { message } })
    },
    setInstructions: (directory, text) => call("instructions.set", { directory, text }),
    emit: (topic, data) => call("panels.emit", { topic, data }),
    readSettings: () => call("settings.read", {}).then(({ settings }) => settings),
    needsConfiguration: (message) => call("status.set", { needsConfiguration: message }),
    setMark: (target, mark) => call("marks.set", { target, mark })
  };
};
// node_modules/@openchamber/sdk/dist/file-editor.js
var patternExpressions = new Map;
// node_modules/@openchamber/sdk/dist/contract.js
var GUEST_FILE_STAT_KINDS = ["file", "directory", "other", "missing"];
var GUEST_GENERATE_LATE_KEEP_MS = 60 * 60000;
var HOST_REQUEST_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "HOST_REJECTED",
  "DISCONNECTED",
  "DISABLED",
  "BAD_PATH",
  "NO_INTEGRATION",
  "NO_SERVICE",
  "SERVICE_FAILED",
  "REQUEST_FAILED",
  "RESPONSE_TOO_LARGE",
  "NO_SESSION",
  "SESSION_BUSY",
  "NOT_GRANTED",
  "NO_DIRECTORY",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "DENIED",
  "NO_MODEL",
  "MODEL_FAILED",
  "UNSUPPORTED"
];
var SERVICE_STATUS_VALUES = ["stopped", "starting", "ready", "failed"];
var hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
var serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
var fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);
var HOST_PUSH_TYPES = new Set([
  "workspace",
  "shells",
  "ready",
  "directory",
  "session",
  "connection",
  "settings",
  "session-lifecycle",
  "item",
  "resolve",
  "action",
  "service-event",
  "status-control-event",
  "popover-closed",
  "file-open",
  "file-snapshot",
  "file-saved",
  "generate-late"
]);
// node_modules/@openchamber/sdk/dist/service-providers.js
var BROWSER_CONTROL_ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
];
var BROWSER_PROVIDER_IDLE_MS = 10 * 60000;
var CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60000;
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
var TRACKER_PROVIDER_IDLE_MS = 10 * 60000;
var QUOTA_PROVIDER_IDLE_MS = 10 * 60000;
// node_modules/@openchamber/sdk/dist/service-surface.js
var SURFACE_FRAME_PATH = "/surface/frame";
var SURFACE_INPUT_PATH = "/surface/input";
var SURFACE_CONTROL_PATH = "/surface/control";
var SURFACE_RESIZE_PATH = "/surface/resize";
var SURFACE_CLIPBOARD_PATH = "/surface/clipboard";
var SURFACE_SEQ_HEADER = "x-surface-seq";
var SURFACE_WIDTH_HEADER = "x-surface-width";
var SURFACE_HEIGHT_HEADER = "x-surface-height";
var SURFACE_TITLE_HEADER = "x-surface-title";
var SURFACE_AGENT_ACTIVE_HEADER = "x-surface-agent-active";
var SURFACE_FRAME_SEQ_HEADER = "x-surface-frame-seq";
var SURFACE_FRAME_WAIT_MS = 25000;
var SURFACE_FRAME_MAX_BYTES = 8000000;
var SURFACE_INPUT_BATCH_MAX = 256;
var SURFACE_TEXT_MAX = 64000;
var SURFACE_TITLE_MAX = 200;
var SURFACE_DIMENSION_MAX = 16384;
var SURFACE_AGENT_HOLD_MS = 30000;
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var isFiniteNumber = (value) => Number(value) === value && Number.isFinite(value);
var isBool = (value) => value === true || value === false;
var isText = (value) => String(value) === value;
var readModifiers = (value) => {
  if (Object(value) !== value || value === null)
    return null;
  const wire = value;
  if (!isBool(wire.alt) || !isBool(wire.ctrl) || !isBool(wire.meta) || !isBool(wire.shift))
    return null;
  return { alt: wire.alt, ctrl: wire.ctrl, meta: wire.meta, shift: wire.shift };
};
var readEvent = (value) => {
  if (value.type === "text") {
    if (!isText(value.text) || value.text.length > SURFACE_TEXT_MAX)
      return null;
    return { type: "text", text: value.text };
  }
  const modifiers = readModifiers(value.modifiers);
  if (!modifiers)
    return null;
  if (value.type === "pointer") {
    if (value.action !== "down" && value.action !== "up" && value.action !== "move")
      return null;
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.button) || !isFiniteNumber(value.buttons))
      return null;
    return { type: "pointer", action: value.action, x: value.x, y: value.y, button: value.button, buttons: value.buttons, modifiers };
  }
  if (value.type === "wheel") {
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.deltaX) || !isFiniteNumber(value.deltaY))
      return null;
    return { type: "wheel", x: value.x, y: value.y, deltaX: value.deltaX, deltaY: value.deltaY, modifiers };
  }
  if (value.type === "key") {
    if (value.action !== "down" && value.action !== "up")
      return null;
    if (!isText(value.key) || !isText(value.code) || value.key.length > 64 || value.code.length > 64)
      return null;
    if (value.keyCode === undefined)
      return { type: "key", action: value.action, key: value.key, code: value.code, modifiers };
    if (!isFiniteNumber(value.keyCode) || !Number.isInteger(value.keyCode) || value.keyCode < 0 || value.keyCode > 255)
      return null;
    return { type: "key", action: value.action, key: value.key, code: value.code, keyCode: value.keyCode, modifiers };
  }
  return null;
};
var readSurfaceInputBatch = (body) => {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (Object(parsed) !== parsed || parsed === null || !Array.isArray(parsed.events))
    return null;
  if (parsed.events.length > SURFACE_INPUT_BATCH_MAX)
    return null;
  const events = [];
  for (const item of parsed.events) {
    if (Object(item) !== item || item === null)
      return null;
    const event = readEvent(item);
    if (!event)
      return null;
    events.push(event);
  }
  return { events };
};
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
var readSurfaceControlNotice = (body) => {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (Object(parsed) !== parsed || parsed === null)
    return null;
  const { controller, viewer } = parsed;
  if (!isText(controller) || !CONTROLLERS.has(controller))
    return null;
  const notice = { controller };
  if (controller === "user" && isText(viewer) && viewer.length > 0)
    notice.viewer = viewer;
  return notice;
};
var readSurfaceResizeRequest = (body) => {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (Object(parsed) !== parsed || parsed === null)
    return null;
  const { width, height } = parsed;
  if (!isFiniteNumber(width) || !isFiniteNumber(height))
    return null;
  if (width < 1 || height < 1 || width > SURFACE_DIMENSION_MAX || height > SURFACE_DIMENSION_MAX)
    return null;
  return { width: Math.round(width), height: Math.round(height) };
};
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
async function getAppearance(serial, bins = resolveBinaries()) {
  if (!bins.adb)
    return null;
  const res = await execText(bins.adb, ["-s", serial, "shell", "cmd", "uimode", "night"], {
    timeoutMs: 3000
  });
  if (res.code !== 0)
    return null;
  const low = res.stdout.toLowerCase();
  if (low.includes("yes"))
    return "dark";
  if (low.includes("no"))
    return "light";
  return null;
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

// src/core/controller.ts
import { mkdirSync, writeFileSync } from "node:fs";
import path3 from "node:path";

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
function ensureTempDir() {
  mkdirSync(TEMP_DIR, { recursive: true });
  return TEMP_DIR;
}
function safeSerialTag(serial) {
  return serial.replace(/[^A-Za-z0-9_.-]/g, "_");
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
          const [png, size, focus] = await Promise.all([
            screencapPng(serial, bins),
            queryScreenSize(serial, bins),
            queryCurrentFocus(serial, bins)
          ]);
          const dir = ensureTempDir();
          const filePath = path3.join(dir, `android-sim-${safeSerialTag(serial)}-${Date.now()}.png`);
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

// src/shared/types.ts
var BLOB_CHUNK = 240000;
function qualityMaxSize(quality) {
  switch (quality) {
    case "full":
      return 0;
    case "balanced":
      return 1080;
    case "fast":
      return 720;
  }
}

// src/service/scrcpy.ts
import { spawn as spawn3 } from "node:child_process";
import { statSync } from "node:fs";
import net from "node:net";
var SCRCPY_SERVER_VERSION = "5.0.1";
var AMOTION_ACTION_DOWN = 0;
var AMOTION_ACTION_UP = 1;
var AMOTION_ACTION_MOVE = 2;
var AMOTION_BUTTON_PRIMARY = 1;
var AKEY_ACTION_DOWN = 0;
var AKEY_ACTION_UP = 1;
var CONTROL_MSG_INJECT_KEYCODE = 0;
var CONTROL_MSG_INJECT_TEXT = 1;
var CONTROL_MSG_INJECT_TOUCH_EVENT = 2;
var CONTROL_MSG_INJECT_SCROLL_EVENT = 3;
var CONTROL_MSG_GET_CLIPBOARD = 8;
var CONTROL_MSG_SET_CLIPBOARD = 9;
function encodeTouchEvent(params) {
  const buf = Buffer.allocUnsafe(32);
  const w = Math.max(1, Math.min(65535, Math.round(params.screenWidth)));
  const h = Math.max(1, Math.min(65535, Math.round(params.screenHeight)));
  const x = Math.max(0, Math.min(w - 1, Math.round(params.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(params.y)));
  const pressure = params.pressure !== undefined ? Math.max(0, Math.min(65535, Math.round(params.pressure * 65535))) : params.action === AMOTION_ACTION_UP ? 0 : 65535;
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
function encodeScrollEvent(params) {
  const buf = Buffer.allocUnsafe(21);
  const w = Math.max(1, Math.min(65535, Math.round(params.screenWidth)));
  const h = Math.max(1, Math.min(65535, Math.round(params.screenHeight)));
  const x = Math.max(0, Math.min(w - 1, Math.round(params.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(params.y)));
  const toFixed16 = (v) => {
    const clamped = Math.max(-1, Math.min(1, v));
    return Math.max(-32768, Math.min(32767, Math.round(clamped * 32767)));
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
function encodeKeycodeEvent(params) {
  const buf = Buffer.allocUnsafe(14);
  buf.writeUInt8(CONTROL_MSG_INJECT_KEYCODE, 0);
  buf.writeUInt8(params.action, 1);
  buf.writeInt32BE(params.keycode, 2);
  buf.writeInt32BE(params.repeat ?? 0, 6);
  buf.writeInt32BE(params.metastate ?? 0, 10);
  return buf;
}
function encodeTextEvent(text) {
  const utf8 = Buffer.from(text, "utf8");
  const buf = Buffer.allocUnsafe(5 + utf8.length);
  buf.writeUInt8(CONTROL_MSG_INJECT_TEXT, 0);
  buf.writeUInt32BE(utf8.length, 1);
  utf8.copy(buf, 5);
  return buf;
}
function encodeSetClipboard(text, paste, sequence) {
  const utf8 = Buffer.from(text, "utf8");
  const buf = Buffer.allocUnsafe(14 + utf8.length);
  buf.writeUInt8(CONTROL_MSG_SET_CLIPBOARD, 0);
  buf.writeBigInt64BE(sequence, 1);
  buf.writeUInt8(paste ? 1 : 0, 9);
  buf.writeUInt32BE(utf8.length, 10);
  utf8.copy(buf, 14);
  return buf;
}
function encodeGetClipboard(copyKey = 1) {
  return Buffer.from([CONTROL_MSG_GET_CLIPBOARD, copyKey]);
}
class ScrcpyVideoParser {
  buf = Buffer.alloc(0);
  stage = "dummy";
  deviceName = "";
  codecId = 0;
  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out = [];
    while (true) {
      if (this.stage === "dummy") {
        if (this.buf.length < 1)
          break;
        this.buf = this.buf.subarray(1);
        this.stage = "deviceMeta";
      }
      if (this.stage === "deviceMeta") {
        if (this.buf.length < 64)
          break;
        const rawName = this.buf.subarray(0, 64);
        const nul = rawName.indexOf(0);
        this.deviceName = rawName.subarray(0, nul === -1 ? 64 : nul).toString("utf8");
        this.buf = this.buf.subarray(64);
        this.stage = "codecMeta";
      }
      if (this.stage === "codecMeta") {
        if (this.buf.length < 4)
          break;
        this.codecId = this.buf.readUInt32BE(0);
        this.buf = this.buf.subarray(4);
        this.stage = "packets";
      }
      if (this.stage === "packets") {
        if (this.buf.length < 12)
          break;
        const hi = this.buf.readUInt32BE(0);
        const lo = this.buf.readUInt32BE(4);
        const size = this.buf.readInt32BE(8);
        if ((hi & 2147483648) !== 0) {
          this.buf = this.buf.subarray(12);
          out.push({ kind: "session", width: lo, height: size });
          continue;
        }
        if (size < 0 || size > 32 * 1024 * 1024) {
          throw new Error(`Invalid scrcpy frame size: ${size}`);
        }
        if (this.buf.length < 12 + size)
          break;
        const payload = Buffer.from(this.buf.subarray(12, 12 + size));
        this.buf = this.buf.subarray(12 + size);
        const config = (hi & 1073741824) !== 0;
        const keyframe = (hi & 536870912) !== 0;
        const pts = BigInt(hi & 536870911) << 32n | BigInt(lo);
        out.push({ kind: "frame", config, keyframe, pts, payload });
      }
    }
    return out;
  }
  info() {
    return { deviceName: this.deviceName, codecId: this.codecId };
  }
}

class JpegFrameSplitter {
  buf = Buffer.alloc(0);
  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames = [];
    while (true) {
      const soi = this.buf.indexOf(Buffer.from([255, 216]));
      if (soi === -1) {
        if (this.buf.length > 1)
          this.buf = this.buf.subarray(this.buf.length - 1);
        break;
      }
      if (soi > 0)
        this.buf = this.buf.subarray(soi);
      const eoi = this.buf.indexOf(Buffer.from([255, 217]), 2);
      if (eoi === -1)
        break;
      const frame = Buffer.from(this.buf.subarray(0, eoi + 2));
      this.buf = this.buf.subarray(eoi + 2);
      frames.push(frame);
    }
    return frames;
  }
}
async function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => {
        if (err)
          reject(err);
        else
          resolve(port);
      });
    });
  });
}
async function connectVideoSocketWithDummyRetry(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const result = await new Promise((resolve, reject) => {
        const s = net.createConnection({ host: "127.0.0.1", port });
        let settled = false;
        const finishErr = (err) => {
          if (settled)
            return;
          settled = true;
          s.destroy();
          reject(err);
        };
        s.once("error", finishErr);
        s.once("close", () => {
          finishErr(new Error("adb forward closed before scrcpy-server dummy byte"));
        });
        s.once("data", (chunk) => {
          if (settled)
            return;
          settled = true;
          s.off("error", finishErr);
          s.setNoDelay(true);
          resolve({ sock: s, initialChunk: chunk });
        });
      });
      return result;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, 90));
    }
  }
  throw lastErr ?? new Error(`Timed out waiting for scrcpy video socket on port ${port}`);
}
async function connectSocketWithRetry(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const sock = await new Promise((resolve, reject) => {
        const s = net.createConnection({ host: "127.0.0.1", port });
        const onErr = (err) => {
          s.destroy();
          reject(err);
        };
        s.once("error", onErr);
        s.once("connect", () => {
          s.off("error", onErr);
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
var pushedServerSizeCache = new Map;

class ScrcpySession {
  serial;
  maxSize;
  bins;
  callbacks;
  serverProc = null;
  ffmpegProc = null;
  videoSock = null;
  controlSock = null;
  localPort = 0;
  closed = false;
  streamWidth = 0;
  streamHeight = 0;
  controlReadBuf = Buffer.alloc(0);
  clipboardWaiters = [];
  latestClipboard = null;
  configHeader = null;
  constructor(serial, maxSize, callbacks, bins = resolveBinaries()) {
    this.serial = serial;
    this.maxSize = maxSize;
    this.callbacks = callbacks;
    this.bins = bins;
  }
  dimensions() {
    return { width: this.streamWidth, height: this.streamHeight };
  }
  async start() {
    if (!this.bins.adb || !this.bins.scrcpyServer || !this.bins.ffmpeg) {
      throw new Error("adb, scrcpy-server, and ffmpeg are all required for scrcpy streaming.");
    }
    const serverSize = statSync(this.bins.scrcpyServer).size;
    if (pushedServerSizeCache.get(this.serial) !== serverSize) {
      const pushRes = await execText(this.bins.adb, ["-s", this.serial, "push", this.bins.scrcpyServer, "/data/local/tmp/scrcpy-server.jar"], { timeoutMs: 15000 });
      if (pushRes.code !== 0) {
        throw new Error(pushRes.stderr.trim() || "Failed to push scrcpy-server.jar");
      }
      pushedServerSizeCache.set(this.serial, serverSize);
    }
    const scid = Math.floor(Math.random() * 2147483647);
    const scidHex = scid.toString(16).padStart(8, "0");
    const port = await allocateFreePort();
    this.localPort = port;
    const fwdRes = await execText(this.bins.adb, ["-s", this.serial, "forward", `tcp:${port}`, `localabstract:scrcpy_${scidHex}`], { timeoutMs: 5000 });
    if (fwdRes.code !== 0) {
      throw new Error(fwdRes.stderr.trim() || "adb forward failed");
    }
    const serverArgs = [
      "-s",
      this.serial,
      "shell",
      `CLASSPATH=/data/local/tmp/scrcpy-server.jar`,
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      SCRCPY_SERVER_VERSION,
      `scid=${scidHex}`,
      "tunnel_forward=true",
      "video=true",
      "audio=false",
      "control=true",
      "video_codec=h264",
      `max_size=${this.maxSize}`,
      "max_fps=30",
      "video_bit_rate=4000000",
      "send_dummy_byte=true",
      "send_device_meta=true",
      "send_stream_meta=true",
      "send_frame_meta=true",
      "stay_awake=true",
      "power_on=false",
      "cleanup=true"
    ];
    const proc = spawn3(this.bins.adb, serverArgs, { stdio: ["pipe", "pipe", "pipe"] });
    this.serverProc = proc;
    let stderrTail = "";
    proc.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString("utf8")).slice(-1000);
    });
    proc.on("exit", (code) => {
      if (!this.closed) {
        this.callbacks.onError?.(new Error(stderrTail.trim() || `scrcpy-server exited (${code ?? "signal"})`));
        this.stop();
      }
    });
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
  restartDecoder(width, height) {
    if (this.ffmpegProc) {
      try {
        this.ffmpegProc.stdin.end();
        this.ffmpegProc.kill("SIGKILL");
      } catch {}
      this.ffmpegProc = null;
    }
    if (this.closed || !this.bins.ffmpeg)
      return null;
    const proc = spawn3(this.bins.ffmpeg, [
      "-v",
      "error",
      "-flags",
      "low_delay",
      "-probesize",
      "4096",
      "-analyzeduration",
      "100000",
      "-threads",
      "1",
      "-f",
      "h264",
      "-i",
      "pipe:0",
      "-strict",
      "unofficial",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-q:v",
      "5",
      "-flush_packets",
      "1",
      "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.ffmpegProc = proc;
    const splitter = new JpegFrameSplitter;
    proc.stdout.on("data", (chunk) => {
      for (const jpeg of splitter.push(chunk)) {
        if (this.closed)
          return;
        this.callbacks.onFrame({
          jpeg,
          width: this.streamWidth || width,
          height: this.streamHeight || height
        });
      }
    });
    proc.stdin.on("error", () => {});
    proc.on("error", (err) => {
      if (!this.closed)
        this.callbacks.onError?.(err);
    });
    return proc;
  }
  wireVideoReader(sock, initialChunk) {
    const parser = new ScrcpyVideoParser;
    const handleChunk = (chunk) => {
      if (this.closed)
        return;
      try {
        const packets = parser.push(chunk);
        for (const pkt of packets) {
          if (pkt.kind === "session") {
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
        this.stop();
      }
    };
    if (initialChunk && initialChunk.length > 0) {
      handleChunk(initialChunk);
    }
    sock.on("data", handleChunk);
    sock.on("error", (err) => {
      if (!this.closed)
        this.callbacks.onError?.(err);
    });
    sock.on("close", () => {
      if (!this.closed)
        this.stop();
    });
  }
  wireControlReader(sock) {
    sock.on("data", (chunk) => {
      this.controlReadBuf = this.controlReadBuf.length === 0 ? chunk : Buffer.concat([this.controlReadBuf, chunk]);
      while (this.controlReadBuf.length >= 1) {
        const type = this.controlReadBuf.readUInt8(0);
        if (type === 0) {
          if (this.controlReadBuf.length < 5)
            break;
          const len = this.controlReadBuf.readUInt32BE(1);
          if (this.controlReadBuf.length < 5 + len)
            break;
          const text = this.controlReadBuf.subarray(5, 5 + len).toString("utf8");
          this.controlReadBuf = this.controlReadBuf.subarray(5 + len);
          this.latestClipboard = text;
          this.callbacks.onClipboard?.(text);
          while (this.clipboardWaiters.length > 0) {
            const w = this.clipboardWaiters.shift();
            w?.(text);
          }
        } else if (type === 1) {
          if (this.controlReadBuf.length < 9)
            break;
          this.controlReadBuf = this.controlReadBuf.subarray(9);
        } else if (type === 2) {
          if (this.controlReadBuf.length < 5)
            break;
          const size = this.controlReadBuf.readUInt16BE(3);
          if (this.controlReadBuf.length < 5 + size)
            break;
          this.controlReadBuf = this.controlReadBuf.subarray(5 + size);
        } else {
          this.controlReadBuf = Buffer.alloc(0);
          break;
        }
      }
    });
    sock.on("error", () => {});
  }
  sendControl(buf) {
    if (this.closed || !this.controlSock || this.controlSock.destroyed)
      return false;
    try {
      this.controlSock.write(buf);
      return true;
    } catch {
      return false;
    }
  }
  async fetchClipboard(timeoutMs = 800) {
    if (this.closed || !this.controlSock || this.controlSock.destroyed)
      return this.latestClipboard;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.clipboardWaiters.indexOf(onClip);
        if (idx !== -1)
          this.clipboardWaiters.splice(idx, 1);
        resolve(this.latestClipboard);
      }, timeoutMs);
      const onClip = (text) => {
        clearTimeout(timer);
        resolve(text);
      };
      this.clipboardWaiters.push(onClip);
      this.sendControl(encodeGetClipboard(1));
    });
  }
  async stop() {
    if (this.closed)
      return;
    this.closed = true;
    try {
      this.videoSock?.destroy();
    } catch {}
    try {
      this.controlSock?.destroy();
    } catch {}
    try {
      this.ffmpegProc?.stdin.end();
      this.ffmpegProc?.kill("SIGKILL");
    } catch {}
    try {
      this.serverProc?.kill("SIGKILL");
    } catch {}
    if (this.localPort > 0 && this.bins.adb) {
      await execText(this.bins.adb, ["-s", this.serial, "forward", "--remove", `tcp:${this.localPort}`], {
        timeoutMs: 2000
      }).catch(() => {
        return;
      });
    }
    this.callbacks.onClose?.();
  }
}

// src/service/input.ts
var KEYCODE_HOME = 3;
var KEYCODE_BACK = 4;
var KEYCODE_POWER = 26;
var KEYCODE_VOLUME_UP = 24;
var KEYCODE_VOLUME_DOWN = 25;
var KEYCODE_APP_SWITCH = 187;
var KEYCODE_DEL2 = 67;
var KEYCODE_FORWARD_DEL = 112;
var KEYCODE_ENTER2 = 66;
var KEYCODE_TAB = 61;
var KEYCODE_ESCAPE = 111;
var KEYCODE_SPACE = 62;
var KEYCODE_DPAD_UP = 19;
var KEYCODE_DPAD_DOWN = 20;
var KEYCODE_DPAD_LEFT = 21;
var KEYCODE_DPAD_RIGHT = 22;
var KEYCODE_MOVE_HOME = 122;
var KEYCODE_MOVE_END2 = 123;
var KEYCODE_PAGE_UP = 92;
var KEYCODE_PAGE_DOWN = 93;
var KEYCODE_COPY = 278;
var AMETA_SHIFT_ON = 1;
var AMETA_ALT_ON = 2;
var AMETA_CTRL_ON = 4096;
var AMETA_META_ON = 65536;
function androidMetaState(mod) {
  let state = 0;
  if (mod.shift)
    state |= AMETA_SHIFT_ON;
  if (mod.alt)
    state |= AMETA_ALT_ON;
  if (mod.ctrl)
    state |= AMETA_CTRL_ON;
  if (mod.meta)
    state |= AMETA_META_ON;
  return state;
}
function mapWebKeyToAndroidKeycode(ev) {
  switch (ev.key) {
    case "Backspace":
      return KEYCODE_DEL2;
    case "Delete":
      return KEYCODE_FORWARD_DEL;
    case "Enter":
      return KEYCODE_ENTER2;
    case "Tab":
      return KEYCODE_TAB;
    case "Escape":
      return KEYCODE_ESCAPE;
    case " ":
      return KEYCODE_SPACE;
    case "ArrowUp":
      return KEYCODE_DPAD_UP;
    case "ArrowDown":
      return KEYCODE_DPAD_DOWN;
    case "ArrowLeft":
      return KEYCODE_DPAD_LEFT;
    case "ArrowRight":
      return KEYCODE_DPAD_RIGHT;
    case "Home":
      return KEYCODE_MOVE_HOME;
    case "End":
      return KEYCODE_MOVE_END2;
    case "PageUp":
      return KEYCODE_PAGE_UP;
    case "PageDown":
      return KEYCODE_PAGE_DOWN;
    case "BrowserBack":
    case "GoBack":
      return KEYCODE_BACK;
    default:
      break;
  }
  if (/^Key([A-Z])$/.test(ev.code)) {
    const ch = ev.code.charCodeAt(3);
    return 29 + (ch - 65);
  }
  if (/^Digit([0-9])$/.test(ev.code)) {
    const ch = ev.code.charCodeAt(5);
    return 7 + (ch - 48);
  }
  return null;
}
function isAsciiPrintable(text) {
  for (let i = 0;i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 || code > 126)
      return false;
  }
  return text.length > 0;
}

class DeviceInputState {
  touching = false;
  lastX = 0;
  lastY = 0;
  lastCopyAt = 0;
  resetTouch(session, screenW, screenH) {
    if (!this.touching)
      return;
    this.touching = false;
    if (session && screenW > 0 && screenH > 0) {
      session.sendControl(encodeTouchEvent({
        action: AMOTION_ACTION_UP,
        pointerId: 1n,
        x: this.lastX,
        y: this.lastY,
        screenWidth: screenW,
        screenHeight: screenH
      }));
    }
  }
}
async function dispatchSurfaceEvents(params) {
  const { events, session, serial, screenWidth, screenHeight, state } = params;
  const w = Math.max(1, screenWidth);
  const h = Math.max(1, screenHeight);
  for (const ev of events) {
    if (ev.type === "pointer") {
      const x = Math.max(0, Math.min(w - 1, Math.round(ev.x)));
      const y = Math.max(0, Math.min(h - 1, Math.round(ev.y)));
      state.lastX = x;
      state.lastY = y;
      if (ev.action === "down") {
        if (ev.button !== 0 && (ev.buttons & 1) === 0)
          continue;
        state.touching = true;
        if (session) {
          session.sendControl(encodeTouchEvent({
            action: AMOTION_ACTION_DOWN,
            pointerId: 1n,
            x,
            y,
            screenWidth: w,
            screenHeight: h
          }));
        }
      } else if (ev.action === "move") {
        if (!state.touching)
          continue;
        if (session) {
          session.sendControl(encodeTouchEvent({
            action: AMOTION_ACTION_MOVE,
            pointerId: 1n,
            x,
            y,
            screenWidth: w,
            screenHeight: h
          }));
        }
      } else if (ev.action === "up") {
        if (!state.touching)
          continue;
        state.touching = false;
        if (session) {
          session.sendControl(encodeTouchEvent({
            action: AMOTION_ACTION_UP,
            pointerId: 1n,
            x,
            y,
            screenWidth: w,
            screenHeight: h
          }));
        }
      }
      continue;
    }
    if (ev.type === "wheel") {
      const x = Math.max(0, Math.min(w - 1, Math.round(ev.x)));
      const y = Math.max(0, Math.min(h - 1, Math.round(ev.y)));
      const hScroll = Math.max(-1, Math.min(1, -ev.deltaX / 120));
      const vScroll = Math.max(-1, Math.min(1, -ev.deltaY / 120));
      if (session) {
        session.sendControl(encodeScrollEvent({
          x,
          y,
          screenWidth: w,
          screenHeight: h,
          hScroll,
          vScroll
        }));
      }
      continue;
    }
    if (ev.type === "text") {
      if (!ev.text)
        continue;
      if (session) {
        if (isAsciiPrintable(ev.text) && !ev.text.includes(`
`) && ev.text.length <= 200) {
          session.sendControl(encodeTextEvent(ev.text));
        } else {
          session.sendControl(encodeSetClipboard(ev.text, true, BigInt(Date.now())));
        }
      } else {
        await adbText(serial, ev.text);
      }
      continue;
    }
    if (ev.type === "key") {
      const hasShortcutMod = ev.modifiers.ctrl || ev.modifiers.meta;
      const lower = ev.key.toLowerCase();
      if (ev.action === "down" && hasShortcutMod && lower === "c") {
        state.lastCopyAt = Date.now();
        if (session) {
          session.sendControl(encodeKeycodeEvent({ action: AKEY_ACTION_DOWN, keycode: KEYCODE_COPY }));
          session.sendControl(encodeKeycodeEvent({ action: AKEY_ACTION_UP, keycode: KEYCODE_COPY }));
        } else {
          await adbKey(serial, KEYCODE_COPY);
        }
        continue;
      }
      const keycode = mapWebKeyToAndroidKeycode(ev);
      if (keycode === null)
        continue;
      const isSpecialNav = keycode === KEYCODE_DEL2 || keycode === KEYCODE_FORWARD_DEL || keycode === KEYCODE_ENTER2 || keycode === KEYCODE_TAB || keycode === KEYCODE_ESCAPE || keycode === KEYCODE_DPAD_UP || keycode === KEYCODE_DPAD_DOWN || keycode === KEYCODE_DPAD_LEFT || keycode === KEYCODE_DPAD_RIGHT || keycode === KEYCODE_MOVE_HOME || keycode === KEYCODE_MOVE_END2 || keycode === KEYCODE_PAGE_UP || keycode === KEYCODE_PAGE_DOWN || keycode === KEYCODE_BACK;
      if (!isSpecialNav && !hasShortcutMod && !ev.modifiers.alt) {
        continue;
      }
      if (session) {
        session.sendControl(encodeKeycodeEvent({
          action: ev.action === "down" ? AKEY_ACTION_DOWN : AKEY_ACTION_UP,
          keycode,
          metastate: androidMetaState(ev.modifiers)
        }));
      } else if (ev.action === "down") {
        await adbKey(serial, keycode);
      }
    }
  }
}
async function injectAndroidKey(serial, keycode, session) {
  if (session) {
    const okDown = session.sendControl(encodeKeycodeEvent({ action: AKEY_ACTION_DOWN, keycode }));
    const okUp = session.sendControl(encodeKeycodeEvent({ action: AKEY_ACTION_UP, keycode }));
    if (okDown && okUp)
      return;
  }
  await adbKey(serial, keycode);
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
function writeServiceDiscovery(record) {
  const file = discoveryFilePath();
  writeFileSync2(file, JSON.stringify(record), { mode: 384 });
  try {
    chmodSync(file, 384);
  } catch {}
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
function clearServiceDiscovery(pid) {
  const current = readServiceDiscovery();
  if (current && current.pid !== pid)
    return;
  try {
    unlinkSync(discoveryFilePath());
  } catch {}
}

// src/service/status.ts
function buildStatusView(state) {
  const rows = [];
  if (!state.toolsAvailable.adb) {
    rows.push({
      kind: "note",
      id: "missing-adb",
      tone: "error",
      text: "adb not found. Set ANDROID_HOME or install Android platform-tools."
    });
    return { rows };
  }
  const active = state.active;
  if (active) {
    const dot = active.state === "booted" ? "success" : active.state === "booting" ? "info" : active.state === "unauthorized" ? "warning" : "muted";
    const actions = [];
    if (active.state === "off" && active.avdName) {
      actions.push({ kind: "button", id: `boot:${active.avdName}`, label: "Boot", variant: "outline" });
    } else if (active.state === "booted" && active.serial && (active.kind === "emulator" || active.transport === "tcp")) {
      actions.push({
        kind: "button",
        id: `shutdown:${active.serial}`,
        label: active.kind === "emulator" ? "Power off" : "Disconnect",
        variant: "outline",
        confirm: active.kind === "emulator" ? `Shut down ${active.avdName ?? active.serial}?` : undefined
      });
    }
    rows.push({
      kind: "line",
      id: "active-device",
      label: active.avdName ?? active.model ?? active.label,
      dot,
      value: active.apiLevel ? `${active.state} · API ${active.apiLevel}` : active.state,
      ...actions.length > 0 ? { actions } : {}
    });
  } else {
    rows.push({
      kind: "note",
      id: "no-device",
      tone: "muted",
      text: state.devices.length === 0 ? "No AVDs or ADB devices found." : "Pick a device in the Android Simulator panel."
    });
  }
  if (active?.state === "booted") {
    rows.push({
      kind: "line",
      id: "stream",
      label: "Stream",
      dot: state.stream.running ? state.agentActive ? "info" : "success" : "muted",
      value: state.stream.running ? `${state.stream.mode} · ${state.stream.width}x${state.stream.height} · ${state.stream.fps} fps` : "idle",
      ...state.agentActive ? { badge: { label: "Agent active", tone: "info" } } : {}
    });
  }
  if (state.stream.error) {
    rows.push({
      kind: "note",
      id: "stream-error",
      tone: "warning",
      text: state.stream.error.slice(0, 280)
    });
  }
  const bootedCount = state.devices.filter((d) => d.state === "booted").length;
  if (bootedCount > 1) {
    rows.push({
      kind: "line",
      id: "other-booted",
      label: "Connected",
      value: `${bootedCount} online`,
      dot: "info"
    });
  }
  return { rows };
}

// src/service/stream.ts
import { deflateSync } from "node:zlib";
var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0;i < 256; i += 1) {
    let c = i;
    for (let k = 0;k < 8; k += 1) {
      c = (c & 1) !== 0 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let crc = 4294967295;
  for (let i = 0;i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 255] ^ crc >>> 8;
  }
  return (crc ^ 4294967295) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}
function buildSolidPng(width, height, rgbHex) {
  const r = rgbHex >> 16 & 255;
  const g = rgbHex >> 8 & 255;
  const b = rgbHex & 255;
  const stride = 1 + width * 4;
  const raw = Buffer.allocUnsafe(stride * height);
  for (let y = 0;y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0;x < width; x += 1) {
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
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}
var DEFAULT_PLACEHOLDER = buildSolidPng(360, 780, 1579035);

class DeviceStream {
  serial;
  allocSeq;
  quality;
  title;
  scrcpy = null;
  fallbackTimer = null;
  idleTimer = null;
  mode = "off";
  error = null;
  running = false;
  latest = null;
  waiters = new Set;
  frameTimestamps = [];
  lastViewerPollAt = 0;
  startingPromise = null;
  constructor(serial, quality, title, allocSeq) {
    this.serial = serial;
    this.quality = quality;
    this.title = title;
    this.allocSeq = allocSeq;
  }
  getScrcpySession() {
    return this.scrcpy;
  }
  getQuality() {
    return this.quality;
  }
  setTitle(title) {
    this.title = title;
  }
  current() {
    return this.latest;
  }
  status() {
    const now = Date.now();
    const recent = this.frameTimestamps.filter((t) => now - t <= 2000);
    this.frameTimestamps = recent;
    const fps = recent.length > 0 ? Math.round(recent.length / 2 * 10) / 10 : 0;
    return {
      running: this.running,
      mode: this.mode,
      width: this.latest?.width ?? 0,
      height: this.latest?.height ?? 0,
      fps,
      error: this.error
    };
  }
  touchViewer() {
    this.lastViewerPollAt = Date.now();
    this.ensureIdleCheck();
  }
  ensureIdleCheck() {
    if (this.idleTimer)
      return;
    this.idleTimer = setInterval(() => {
      if (this.running && this.lastViewerPollAt > 0 && Date.now() - this.lastViewerPollAt > 45000) {
        this.stop();
      }
    }, 1e4);
    this.idleTimer.unref();
  }
  async ensureStarted(quality) {
    this.touchViewer();
    if (quality && quality !== this.quality) {
      this.quality = quality;
      await this.stop();
    }
    if (this.running)
      return;
    if (this.startingPromise)
      return this.startingPromise;
    this.startingPromise = this.startInternal().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }
  async startInternal() {
    this.error = null;
    const bins = resolveBinaries();
    if (bins.adb && bins.scrcpyServer && bins.ffmpeg) {
      try {
        const session = new ScrcpySession(this.serial, qualityMaxSize(this.quality), {
          onFrame: ({ jpeg, width, height }) => {
            this.mode = "scrcpy";
            this.running = true;
            this.error = null;
            this.publishFrame("image/jpeg", jpeg, width, height, false);
          },
          onError: (err) => {
            this.error = err.message;
          },
          onClose: () => {
            if (this.scrcpy === session) {
              this.scrcpy = null;
              this.running = false;
              this.mode = "off";
            }
          }
        }, bins);
        this.scrcpy = session;
        this.running = true;
        this.mode = "scrcpy";
        await session.start();
        setTimeout(() => {
          if (this.running && !this.latest) {
            this.captureSingleFallbackFrame();
          }
        }, 450);
        return;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        await this.scrcpy?.stop();
        this.scrcpy = null;
      }
    }
    this.startScreencapFallback();
  }
  async captureSingleFallbackFrame() {
    try {
      const [png, size] = await Promise.all([
        screencapPng(this.serial),
        queryScreenSize(this.serial)
      ]);
      const w = size?.width ?? (png.length >= 24 ? png.readUInt32BE(16) : 1080);
      const h = size?.height ?? (png.length >= 24 ? png.readUInt32BE(20) : 2400);
      if (!this.latest) {
        this.publishFrame("image/png", png, w, h, false);
      }
    } catch {}
  }
  startScreencapFallback() {
    if (this.fallbackTimer)
      return;
    this.running = true;
    this.mode = "screencap";
    let inFlight = false;
    const tick = async () => {
      if (inFlight || !this.running)
        return;
      inFlight = true;
      try {
        const png = await screencapPng(this.serial);
        const w = png.length >= 24 ? png.readUInt32BE(16) : 1080;
        const h = png.length >= 24 ? png.readUInt32BE(20) : 2400;
        this.error = null;
        this.publishFrame("image/png", png, w, h, false);
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        inFlight = false;
      }
    };
    tick();
    this.fallbackTimer = setInterval(() => void tick(), 450);
    this.fallbackTimer.unref();
  }
  publishFrame(mime, bytes, width, height, placeholder) {
    const seq = this.allocSeq();
    this.frameTimestamps.push(Date.now());
    this.latest = {
      seq,
      mime,
      bytes,
      width,
      height,
      title: this.title,
      placeholder
    };
    for (const wake of this.waiters)
      wake();
    this.waiters.clear();
  }
  async waitForFrame(afterSeq, waitMs, abortSignal) {
    this.touchViewer();
    if (this.latest && this.latest.seq > afterSeq) {
      return this.latest;
    }
    if (waitMs <= 0)
      return null;
    return new Promise((resolve) => {
      const done = (frame) => {
        clearTimeout(timer);
        this.waiters.delete(onWake);
        abortSignal?.removeEventListener("abort", onAbort);
        resolve(frame);
      };
      const onWake = () => {
        if (this.latest && this.latest.seq > afterSeq)
          done(this.latest);
      };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), waitMs);
      this.waiters.add(onWake);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  async stop() {
    this.running = false;
    this.mode = "off";
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

class StreamManager {
  streams = new Map;
  nextSeq = 0;
  allocSeq = () => {
    this.nextSeq += 1;
    return this.nextSeq;
  };
  get(serial) {
    return this.streams.get(serial) ?? null;
  }
  getOrCreate(serial, quality, title) {
    let stream = this.streams.get(serial);
    if (!stream) {
      stream = new DeviceStream(serial, quality, title, this.allocSeq);
      this.streams.set(serial, stream);
    } else {
      stream.setTitle(title);
    }
    return stream;
  }
  placeholderFrame(title) {
    return {
      seq: this.allocSeq(),
      mime: "image/png",
      bytes: DEFAULT_PLACEHOLDER,
      width: 360,
      height: 780,
      title,
      placeholder: true
    };
  }
  async stopAllExcept(keepSerials) {
    for (const [serial, stream] of this.streams) {
      if (!keepSerials.has(serial)) {
        this.streams.delete(serial);
        await stream.stop();
      }
    }
  }
  async stop(serial) {
    const stream = this.streams.get(serial);
    if (!stream)
      return;
    this.streams.delete(serial);
    await stream.stop();
  }
  async stopAll() {
    const all = [...this.streams.values()];
    this.streams.clear();
    await Promise.all(all.map((s) => s.stop()));
  }
}

// src/service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? "0");
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var host = createServiceHost({ env: process.env });
var streams = new StreamManager;
var surfaceInputState = new DeviceInputState;
var pageInputStates = new Map;
var bootingAvds = new Set;
var devicesCache = [];
var selectedId = null;
var quality = "balanced";
var framed = true;
var cachedAppearance = null;
var cachedRotation = 0;
var surfaceController = "none";
var agentActiveUntil = 0;
var lastAction = null;
var lastInstructionsText = "";
var placeholderWaiters = new Set;
var lastPlaceholderKey = "";
var lastPlaceholderSeq = 0;
var blobs = new Map;
var BLOBS_MAX = 8;
function putBlob(id, base64) {
  blobs.delete(id);
  blobs.set(id, base64);
  while (blobs.size > BLOBS_MAX) {
    const oldest = blobs.keys().next().value;
    if (!oldest)
      break;
    blobs.delete(oldest);
  }
  return { id, length: base64.length };
}
function pageInputOf(serial) {
  let st = pageInputStates.get(serial);
  if (!st) {
    st = new DeviceInputState;
    pageInputStates.set(serial, st);
  }
  return st;
}
function wakePlaceholderWaiters() {
  lastPlaceholderKey = "";
  for (const wake of placeholderWaiters)
    wake();
  placeholderWaiters.clear();
}
function noteAction(message) {
  lastAction = { message, at: Date.now() };
}
function pickActiveDevice(devices) {
  if (selectedId) {
    const match = devices.find((d) => d.id === selectedId || d.serial === selectedId);
    if (match)
      return match;
    if (selectedId.startsWith("avd:")) {
      const avd = selectedId.slice(4);
      const running = devices.find((d) => d.avdName === avd);
      if (running) {
        selectedId = running.id;
        return running;
      }
    }
  }
  const booted = devices.find((d) => d.state === "booted");
  if (booted) {
    selectedId = booted.id;
    return booted;
  }
  const first = devices[0] ?? null;
  if (first)
    selectedId = first.id;
  return first;
}
async function refreshDevices(syncMetadata = false) {
  const next = await discoverDevices(bootingAvds);
  devicesCache = next;
  const active = pickActiveDevice(next);
  if (syncMetadata && active?.state === "booted" && active.serial) {
    const [app, rot] = await Promise.all([
      getAppearance(active.serial),
      getRotation(active.serial)
    ]);
    cachedAppearance = app;
    cachedRotation = rot;
  }
  const bootedIds = new Set(next.filter((d) => d.state === "booted" && d.serial).map((d) => d.serial));
  for (const d of next) {
    if (d.state === "booted" && d.serial) {
      streams.get(d.serial)?.setTitle(d.label);
    }
  }
  for (const existing of [...pageInputStates.keys()]) {
    if (!bootedIds.has(existing))
      pageInputStates.delete(existing);
  }
  updateAgentInstructions(next);
  return next;
}
async function updateAgentInstructions(devices) {
  const summary = devices.length === 0 ? "Android Simulator extension active; no AVDs or ADB devices currently detected." : `Android Simulator devices (${devices.map((d) => `${d.avdName ?? d.serial ?? d.id} [${d.state}${d.serial ? `, ${d.serial}` : ""}]`).join("; ")}). Use android_device, android_input, and android_inspect tools.`;
  const text = summary.slice(0, 4000);
  if (text === lastInstructionsText)
    return;
  lastInstructionsText = text;
  await host.setInstructions(null, text).catch(() => {
    return;
  });
}
function buildStateSnapshot(targetId) {
  const bins = resolveBinaries();
  const active = targetId ? devicesCache.find((d) => d.id === targetId || d.serial === targetId) ?? null : pickActiveDevice(devicesCache);
  const stream = active?.serial ? streams.get(active.serial) : null;
  return {
    devices: devicesCache,
    selectedId: active?.id ?? selectedId,
    active,
    stream: stream?.status() ?? {
      running: false,
      mode: "off",
      width: active?.screenWidth ?? 0,
      height: active?.screenHeight ?? 0,
      fps: 0,
      error: null
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
      ffmpeg: Boolean(bins.ffmpeg)
    },
    lastAction
  };
}
function resolveSerialTarget(bodySerial) {
  if (typeof bodySerial === "string" && bodySerial.trim()) {
    const wanted = bodySerial.trim();
    const match = devicesCache.find((d) => d.id === wanted || d.serial === wanted);
    if (match?.serial)
      return match.serial;
    if (!wanted.startsWith("avd:"))
      return wanted;
  }
  const active = pickActiveDevice(devicesCache);
  if (!active?.serial || active.state !== "booted") {
    throw new Error("No booted Android device selected.");
  }
  return active.serial;
}
function sanitizeTitle(title) {
  return title.replace(/[^\x20-\x7e]/g, "").slice(0, SURFACE_TITLE_MAX) || "Android";
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(text);
}
async function handleSurfaceFrame(req, res, url) {
  const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
  const reqWait = Number.parseInt(url.searchParams.get("wait") ?? "0", 10) || 0;
  const waitMs = Math.max(0, Math.min(SURFACE_FRAME_WAIT_MS, reqWait));
  if (devicesCache.length === 0) {
    await refreshDevices(false);
  }
  const active = pickActiveDevice(devicesCache);
  const abortCtrl = new AbortController;
  res.on("close", () => abortCtrl.abort());
  if (!active || active.state !== "booted" || !active.serial) {
    const title = active ? `${active.label} (${active.state})` : "No Android device";
    const key = `${active?.id ?? "none"}:${active?.state ?? "none"}`;
    if (after === 0 || key !== lastPlaceholderKey || after < lastPlaceholderSeq) {
      const frame = streams.placeholderFrame(title);
      lastPlaceholderKey = key;
      lastPlaceholderSeq = frame.seq;
      const headers = {
        "Content-Type": frame.mime,
        "Content-Length": frame.bytes.length,
        "Cache-Control": "no-store",
        [SURFACE_SEQ_HEADER]: String(frame.seq),
        [SURFACE_WIDTH_HEADER]: String(frame.width),
        [SURFACE_HEIGHT_HEADER]: String(frame.height),
        [SURFACE_TITLE_HEADER]: sanitizeTitle(frame.title)
      };
      res.writeHead(200, headers);
      res.end(frame.bytes);
      return;
    }
    if (waitMs > 0) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          placeholderWaiters.delete(done);
          abortCtrl.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(waitMs, 4000));
        placeholderWaiters.add(done);
        abortCtrl.signal.addEventListener("abort", done, { once: true });
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
  const headers = {
    "Content-Type": frame.mime,
    "Content-Length": frame.bytes.length,
    "Cache-Control": "no-store",
    [SURFACE_SEQ_HEADER]: String(frame.seq),
    [SURFACE_WIDTH_HEADER]: String(frame.width),
    [SURFACE_HEIGHT_HEADER]: String(frame.height),
    [SURFACE_TITLE_HEADER]: sanitizeTitle(frame.title)
  };
  if (Date.now() < agentActiveUntil) {
    headers[SURFACE_AGENT_ACTIVE_HEADER] = "1";
  }
  res.writeHead(200, headers);
  res.end(frame.bytes);
}
async function handleSurfaceInput(req, res) {
  const raw = await readBody(req);
  const batch = readSurfaceInputBatch(raw);
  if (!batch) {
    json(res, 400, { error: "Invalid input batch" });
    return;
  }
  const active = pickActiveDevice(devicesCache);
  if (!active || active.state !== "booted" || !active.serial) {
    json(res, 409, { error: "No booted Android device" });
    return;
  }
  const stream = streams.get(active.serial);
  const current = stream?.current();
  if (!stream || !current || current.placeholder) {
    json(res, 409, { error: "No simulator picture yet" });
    return;
  }
  const clientSeqHeader = req.headers[SURFACE_FRAME_SEQ_HEADER];
  const clientSeq = typeof clientSeqHeader === "string" ? Number.parseInt(clientSeqHeader, 10) : 0;
  if (clientSeq > 0 && current.seq > 0 && Math.abs(current.seq - clientSeq) > 120) {
    json(res, 409, { error: "Stale frame" });
    return;
  }
  await dispatchSurfaceEvents({
    events: batch.events,
    session: stream.getScrcpySession(),
    serial: active.serial,
    screenWidth: current.width,
    screenHeight: current.height,
    state: surfaceInputState
  });
  res.writeHead(204).end();
}
async function handlePageFrame(res, url) {
  const serialParam = url.searchParams.get("serial") ?? "";
  const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
  const reqWait = Number.parseInt(url.searchParams.get("wait") ?? "0", 10) || 0;
  const waitMs = Math.max(0, Math.min(1e4, reqWait));
  if (devicesCache.length === 0) {
    await refreshDevices(false);
  }
  const target = devicesCache.find((d) => d.id === serialParam || d.serial === serialParam);
  if (!target || target.state !== "booted" || !target.serial) {
    res.writeHead(204).end();
    return;
  }
  const abortCtrl = new AbortController;
  res.on("close", () => abortCtrl.abort());
  const stream = streams.getOrCreate(target.serial, quality, target.label);
  await stream.ensureStarted(quality);
  const frame = await stream.waitForFrame(after, waitMs, abortCtrl.signal);
  if (!frame) {
    res.writeHead(204).end();
    return;
  }
  const base64 = frame.bytes.toString("base64");
  const data = putBlob(`page-${target.serial}-${frame.seq}`, base64);
  const payload = {
    seq: frame.seq,
    mime: frame.mime,
    width: frame.width,
    height: frame.height,
    rotation: cachedRotation,
    data
  };
  json(res, 200, payload);
}
async function handlePageInput(req, res) {
  const raw = await readBody(req);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }
  const batch = readSurfaceInputBatch(JSON.stringify({ events: parsed.events }));
  if (!batch) {
    json(res, 400, { error: "Invalid input batch" });
    return;
  }
  const serial = typeof parsed.serial === "string" ? parsed.serial : "";
  const dev = devicesCache.find((d) => d.id === serial || d.serial === serial);
  if (!dev?.serial || dev.state !== "booted") {
    json(res, 409, { error: "Device is not booted" });
    return;
  }
  const stream = streams.get(dev.serial);
  const current = stream?.current();
  if (!stream || !current) {
    json(res, 409, { error: "No stream frame" });
    return;
  }
  const w = typeof parsed.width === "number" && parsed.width > 0 ? parsed.width : current.width;
  const h = typeof parsed.height === "number" && parsed.height > 0 ? parsed.height : current.height;
  if (w !== current.width || h !== current.height) {
    json(res, 409, { error: "Stale frame dimensions" });
    return;
  }
  await dispatchSurfaceEvents({
    events: batch.events,
    session: stream.getScrcpySession(),
    serial: dev.serial,
    screenWidth: current.width,
    screenHeight: current.height,
    state: pageInputOf(dev.serial)
  });
  res.writeHead(204).end();
}
async function route(req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const method = req.method ?? "GET";
  if (pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }
  if (method === "GET" && pathname === SURFACE_FRAME_PATH) {
    await handleSurfaceFrame(req, res, url);
    return;
  }
  if (method === "POST" && pathname === SURFACE_INPUT_PATH) {
    await handleSurfaceInput(req, res);
    return;
  }
  if (method === "POST" && pathname === SURFACE_CONTROL_PATH) {
    const raw = await readBody(req);
    const notice = readSurfaceControlNotice(raw);
    if (!notice) {
      json(res, 400, { error: "Invalid control notice" });
      return;
    }
    surfaceController = notice.controller;
    if (notice.controller !== "user") {
      const active = pickActiveDevice(devicesCache);
      const cur = active?.serial ? streams.get(active.serial)?.current() : null;
      surfaceInputState.resetTouch(active?.serial ? streams.get(active.serial)?.getScrcpySession() ?? null : null, cur?.width ?? 0, cur?.height ?? 0);
    }
    res.writeHead(204).end();
    return;
  }
  if (method === "POST" && pathname === SURFACE_RESIZE_PATH) {
    const raw = await readBody(req);
    if (!readSurfaceResizeRequest(raw)) {
      json(res, 400, { error: "Invalid resize request" });
      return;
    }
    json(res, 400, { error: "fixed size" });
    return;
  }
  if (method === "GET" && pathname === SURFACE_CLIPBOARD_PATH) {
    const active = pickActiveDevice(devicesCache);
    const session = active?.serial ? streams.get(active.serial)?.getScrcpySession() ?? null : null;
    if (!session) {
      json(res, 404, { error: "No active scrcpy session" });
      return;
    }
    const elapsed = Date.now() - surfaceInputState.lastCopyAt;
    if (elapsed >= 0 && elapsed < 150) {
      await new Promise((r) => setTimeout(r, 150 - elapsed));
    }
    const text = await session.fetchClipboard(700);
    if (!text) {
      json(res, 404, { error: "Clipboard empty" });
      return;
    }
    json(res, 200, { text });
    return;
  }
  if (method === "GET" && pathname === "/page/frame") {
    await handlePageFrame(res, url);
    return;
  }
  if (method === "POST" && pathname === "/page/input") {
    await handlePageInput(req, res);
    return;
  }
  if (method === "GET" && pathname === "/blob") {
    const id = url.searchParams.get("id") ?? "";
    const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;
    const blob = blobs.get(id);
    if (!blob || offset < 0 || offset >= blob.length) {
      json(res, 404, { error: "gone" });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(blob.slice(offset, offset + BLOB_CHUNK));
    return;
  }
  if (method === "GET" && pathname === "/state") {
    const refresh = url.searchParams.get("refresh") === "1";
    if (refresh || devicesCache.length === 0) {
      await refreshDevices(true);
    }
    json(res, 200, buildStateSnapshot(url.searchParams.get("id")));
    return;
  }
  if (method === "POST" && pathname === "/select") {
    const body = JSON.parse(await readBody(req));
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
      if (match.state === "booted" && match.serial) {
        const [app, rot] = await Promise.all([
          getAppearance(match.serial),
          getRotation(match.serial)
        ]);
        cachedAppearance = app;
        cachedRotation = rot;
      }
    }
    json(res, 200, buildStateSnapshot());
    return;
  }
  if (method === "POST" && pathname === "/boot") {
    const body = JSON.parse(await readBody(req));
    await refreshDevices(false);
    let avdName = body.avdName?.trim() || null;
    if (!avdName && body.id) {
      const match = devicesCache.find((d) => d.id === body.id || d.avdName === body.id);
      avdName = match?.avdName ?? (body.id.startsWith("avd:") ? body.id.slice(4) : null);
    }
    if (!avdName) {
      const active = pickActiveDevice(devicesCache);
      avdName = active?.avdName ?? null;
    }
    if (!avdName) {
      json(res, 400, { error: "Select an AVD to boot." });
      return;
    }
    bootingAvds.add(avdName);
    try {
      const booted = await bootAvd(avdName, { headless: true });
      if (body.select !== false)
        selectedId = booted.id;
      noteAction(`Booted ${booted.label}`);
      await refreshDevices(true);
      wakePlaceholderWaiters();
      json(res, 200, buildStateSnapshot());
    } finally {
      bootingAvds.delete(avdName);
    }
    return;
  }
  if (method === "POST" && pathname === "/shutdown") {
    const body = JSON.parse(await readBody(req));
    const serial = resolveSerialTarget(body.id);
    await streams.stop(serial);
    const msg = await shutdownDevice(serial);
    noteAction(msg);
    await refreshDevices(false);
    wakePlaceholderWaiters();
    json(res, 200, buildStateSnapshot());
    return;
  }
  if (method === "POST" && pathname === "/button") {
    const body = JSON.parse(await readBody(req));
    const serial = resolveSerialTarget(body.id);
    const session = streams.get(serial)?.getScrcpySession() ?? null;
    const keyMap = {
      back: KEYCODE_BACK,
      home: KEYCODE_HOME,
      recents: KEYCODE_APP_SWITCH,
      power: KEYCODE_POWER,
      lock: KEYCODE_POWER,
      volume_up: KEYCODE_VOLUME_UP,
      volume_down: KEYCODE_VOLUME_DOWN
    };
    const keycode = keyMap[String(body.name ?? "").toLowerCase()];
    if (!keycode) {
      json(res, 400, { error: `Unknown button: ${String(body.name)}` });
      return;
    }
    await injectAndroidKey(serial, keycode, session);
    noteAction(`Pressed ${body.name}`);
    json(res, 200, buildStateSnapshot(body.id));
    return;
  }
  if (method === "POST" && pathname === "/rotate") {
    const body = JSON.parse(await readBody(req) || "{}");
    const serial = resolveSerialTarget(body.id);
    cachedRotation = await setRotation(serial, body.rotation);
    noteAction(`Rotated to ${cachedRotation}°`);
    json(res, 200, buildStateSnapshot(body.id));
    return;
  }
  if (method === "POST" && pathname === "/appearance") {
    const body = JSON.parse(await readBody(req) || "{}");
    const serial = resolveSerialTarget(body.id);
    const nextMode = body.mode ?? (cachedAppearance === "dark" ? "light" : "dark");
    cachedAppearance = await setAppearance(serial, nextMode);
    noteAction(`Appearance: ${cachedAppearance}`);
    json(res, 200, buildStateSnapshot(body.id));
    return;
  }
  if (method === "POST" && pathname === "/quality") {
    const body = JSON.parse(await readBody(req) || "{}");
    if (body.value === "full" || body.value === "balanced" || body.value === "fast") {
      quality = body.value;
      const active = pickActiveDevice(devicesCache);
      if (active?.serial) {
        const s = streams.get(active.serial);
        if (s)
          await s.ensureStarted(quality);
      }
      noteAction(`Stream quality: ${quality}`);
    }
    json(res, 200, buildStateSnapshot());
    return;
  }
  if (method === "POST" && pathname === "/frame") {
    const body = JSON.parse(await readBody(req) || "{}");
    framed = body.on !== false;
    json(res, 200, buildStateSnapshot());
    return;
  }
  if (method === "POST" && pathname === "/open-url") {
    const body = JSON.parse(await readBody(req));
    const serial = resolveSerialTarget(body.id);
    const msg = await openUrl(serial, String(body.url ?? ""));
    noteAction(`Opened ${body.url}`);
    json(res, 200, { ...buildStateSnapshot(body.id), detail: msg });
    return;
  }
  if (method === "POST" && pathname === "/install-apk") {
    const body = JSON.parse(await readBody(req));
    const serial = resolveSerialTarget(body.id);
    const msg = await installApk(serial, String(body.apkPath ?? ""));
    noteAction("Installed APK");
    json(res, 200, { ...buildStateSnapshot(body.id), detail: msg });
    return;
  }
  if (method === "GET" && pathname === "/status") {
    await refreshDevices(false);
    json(res, 200, buildStatusView(buildStateSnapshot()));
    return;
  }
  if (method === "POST" && pathname === "/status") {
    const body = JSON.parse(await readBody(req) || "{}");
    const actionId = String(body.id ?? "");
    if (actionId.startsWith("boot:")) {
      const avd = actionId.slice(5);
      bootingAvds.add(avd);
      try {
        const booted = await bootAvd(avd, { headless: true });
        selectedId = booted.id;
        wakePlaceholderWaiters();
      } finally {
        bootingAvds.delete(avd);
      }
    } else if (actionId.startsWith("shutdown:")) {
      const serial = actionId.slice(9);
      await streams.stop(serial);
      await shutdownDevice(serial);
      wakePlaceholderWaiters();
    }
    await refreshDevices(true);
    json(res, 200, buildStatusView(buildStateSnapshot()));
    return;
  }
  if (method === "POST" && pathname === "/agent/tool") {
    const reqBody = JSON.parse(await readBody(req));
    agentActiveUntil = Date.now() + SURFACE_AGENT_HOLD_MS;
    const active = pickActiveDevice(devicesCache);
    const data = await executeAgentTool(reqBody.tool, reqBody.input ?? {}, {
      preferredSerial: active?.serial ?? null,
      onSelectDevice: (id) => {
        selectedId = id;
        wakePlaceholderWaiters();
      },
      onDeviceListChanged: () => {
        refreshDevices(true);
      },
      onScrcpyTap: async (serial, x, y, holdMs = 45) => {
        const stream = streams.get(serial);
        const session = stream?.getScrcpySession();
        const cur = stream?.current();
        if (!session || !cur || cur.width <= 0 || cur.height <= 0)
          return false;
        const dev = devicesCache.find((d) => d.serial === serial);
        const sx = dev?.screenWidth && dev.screenWidth > 0 ? Math.round(x / dev.screenWidth * cur.width) : x;
        const sy = dev?.screenHeight && dev.screenHeight > 0 ? Math.round(y / dev.screenHeight * cur.height) : y;
        const ok1 = session.sendControl(encodeTouchEvent({
          action: AMOTION_ACTION_DOWN,
          pointerId: 1n,
          x: sx,
          y: sy,
          screenWidth: cur.width,
          screenHeight: cur.height
        }));
        await new Promise((r) => setTimeout(r, Math.max(40, holdMs)));
        const ok2 = session.sendControl(encodeTouchEvent({
          action: AMOTION_ACTION_UP,
          pointerId: 1n,
          x: sx,
          y: sy,
          screenWidth: cur.width,
          screenHeight: cur.height
        }));
        return ok1 && ok2;
      },
      onScrcpyText: async (serial, text) => {
        const session = streams.get(serial)?.getScrcpySession();
        if (!session)
          return false;
        return session.sendControl(encodeTextEvent(text));
      },
      onScrcpyKey: async (serial, keycode) => {
        const session = streams.get(serial)?.getScrcpySession();
        if (!session)
          return false;
        await injectAndroidKey(serial, keycode, session);
        return true;
      }
    });
    json(res, 200, { ok: true, data });
    return;
  }
  json(res, 404, { error: `Not found: ${pathname}` });
}
var server = http.createServer((req, res) => {
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
var pollTimer = setInterval(() => {
  refreshDevices(false);
}, 8000);
pollTimer.unref();
var cleanup = async () => {
  clearInterval(pollTimer);
  clearServiceDiscovery(process.pid);
  await streams.stopAll();
  server.close();
};
process.on("SIGTERM", () => {
  cleanup().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  cleanup().finally(() => process.exit(0));
});
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  if (actualPort > 0 && token) {
    writeServiceDiscovery({
      port: actualPort,
      token,
      pid: process.pid,
      startedAt: Date.now()
    });
  }
  refreshDevices(true);
});
