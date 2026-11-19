import { executeAgentTool } from '../../src/core/controller.ts';
import { readServiceDiscovery } from '../../src/service/state-file.ts';
import type { AgentToolResponse } from '../../src/shared/protocol.ts';

interface ToolResult {
  content?: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  metadata?: Record<string, unknown>;
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly options?: { readonly codemode: boolean };
  readonly input: Record<string, unknown>;
  readonly execute: (
    input: Record<string, unknown>,
    context: { readonly sessionID: string; readonly signal?: AbortSignal },
  ) => Promise<ToolResult>;
}

interface PluginContext {
  readonly tool: {
    readonly transform: (fn: (editor: { add: (tool: ToolDefinition) => void }) => void) => Promise<void>;
  };
}

function exemptLocalhostFromProxy(): void {
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const existing = (process.env[key] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const host of ['127.0.0.1', 'localhost']) {
      if (!existing.includes(host)) existing.push(host);
    }
    process.env[key] = existing.join(',');
  }
}

async function runTool(
  tool: 'android_device' | 'android_input' | 'android_inspect',
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const discovery = readServiceDiscovery();
  if (discovery) {
    const action = String(input.action ?? '');
    const timeoutMs =
      action === 'boot' || action === 'install_apk' || action === 'sequence' || action === 'scroll'
        ? 125_000
        : 30_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${discovery.port}/agent/tool`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${discovery.token}`,
        },
        body: JSON.stringify({ tool, input }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const body = (await res.json()) as AgentToolResponse;
        if (body.ok) {
          return { content: JSON.stringify(body.data) };
        }
        return { content: JSON.stringify({ ok: false, error: body.error ?? 'Tool failed' }) };
      }
      if (res.status !== 401 && res.status !== 404) {
        const errText = await res.text().catch(() => '');
        return { content: JSON.stringify({ ok: false, error: errText || `HTTP ${res.status}` }) };
      }
    } catch {
      // Service is not currently running or unreachable; fall back to direct local execution.
    } finally {
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
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

export default {
  id: 'android-simulator-plugin',
  setup: async (ctx: PluginContext) => {
    exemptLocalhostFromProxy();

    await ctx.tool.transform((tools) => {
      tools.add({
        name: 'android_device',
        description:
          'Manage Android emulators (AVDs), ADB devices, and apps (list, select, connect, boot, shutdown, launch, stop_app, clear_data, install_apk, open_url, rotate, appearance, diagnose). Never boots automatically unless action="boot" is requested.',
        options: { codemode: false },
        input: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'list',
                'select',
                'connect',
                'boot',
                'shutdown',
                'launch',
                'stop_app',
                'clear_data',
                'rotate',
                'appearance',
                'open_url',
                'install_apk',
                'diagnose',
              ],
              description: 'Device or app lifecycle action.',
            },
            serial: {
              type: 'string',
              description: 'Target ADB serial (e.g. "emulator-5554") or AVD id ("avd:name").',
            },
            address: {
              type: 'string',
              description: 'For action="connect": host:port of a TCP/Tailscale/Redroid ADB device.',
            },
            avd: {
              type: 'string',
              description: 'AVD name for action="boot".',
            },
            headless: {
              type: 'boolean',
              description: 'For boot: run emulator with -no-window (default true).',
            },
            cold: {
              type: 'boolean',
              description: 'For boot: cold boot with -no-snapshot-load.',
            },
            package: {
              type: 'string',
              description: 'Android package name for launch, stop_app, or clear_data.',
            },
            activity: {
              type: 'string',
              description: 'Optional activity name for action="launch".',
            },
            rotation: {
              type: 'number',
              enum: [0, 90, 180, 270],
              description: 'Target rotation in degrees for action="rotate" (omit to toggle 0/90).',
            },
            appearance: {
              type: 'string',
              enum: ['light', 'dark'],
              description: 'Theme mode for action="appearance".',
            },
            url: {
              type: 'string',
              description: 'URL or deep link for action="open_url".',
            },
            apkPath: {
              type: 'string',
              description: 'Path to .apk file (supports ~/) for action="install_apk".',
            },
            apkPaths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Multiple .apk paths for split-APK install_apk.',
            },
            grantPermissions: {
              type: 'boolean',
              description: 'For install_apk: pass -g to auto-grant runtime permissions.',
            },
            attemptFix: {
              type: 'boolean',
              description: 'For diagnose: restart adb server and clear stale uiautomator dumps.',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        execute: (input) => runTool('android_device', input),
      });

      tools.add({
        name: 'android_input',
        description:
          'Send touch, long_press, swipe, scroll, text, key, or batched sequence events to a booted Android device. Supports semantic selectors (e.g. "text=Submit,clickable=true"), #N node indices from the latest layout, waitMs polling, and pixel/normalized coordinates.',
        options: { codemode: false },
        input: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'tap',
                'long_press',
                'swipe',
                'scroll',
                'text',
                'key',
                'back',
                'home',
                'recents',
                'power',
                'sequence',
              ],
              description: 'Input event or sequence to send.',
            },
            serial: {
              type: 'string',
              description: 'Target ADB serial (optional when a single device is booted/selected).',
            },
            node: {
              type: ['number', 'string'],
              description: 'Target #N node index from the latest layout snapshot (e.g. 5 or "#5").',
            },
            selector: {
              type: ['string', 'object'],
              description:
                'Semantic UI selector string (e.g. "text=Submit,clickable=true", "id=arm_btn", "desc=/play/i") or object ({ text, resourceId, contentDesc, className, clickable, scrollable, editable, checked, selected, focused }).',
            },
            match: {
              type: 'string',
              enum: ['single', 'first'],
              description: 'Ambiguity policy for selector (default "single" fails if >1 node matches).',
            },
            waitMs: {
              type: 'number',
              description: 'Poll for selector up to waitMs milliseconds (max 15000).',
            },
            x: {
              type: 'number',
              description: 'Tap, long_press, or swipe-start X coordinate (pixels, or 0..1 if normalized=true).',
            },
            y: {
              type: 'number',
              description: 'Tap, long_press, or swipe-start Y coordinate (pixels, or 0..1 if normalized=true).',
            },
            x2: {
              type: 'number',
              description: 'Swipe-end X coordinate.',
            },
            y2: {
              type: 'number',
              description: 'Swipe-end Y coordinate.',
            },
            direction: {
              type: 'string',
              enum: ['up', 'down', 'left', 'right'],
              description: 'For action="scroll": direction of content to reveal (default "down").',
            },
            until: {
              type: ['string', 'object'],
              description: 'For action="scroll": scroll repeatedly until this selector appears.',
            },
            maxScrolls: {
              type: 'number',
              description: 'For action="scroll" with until: max scroll attempts (default 5, max 15).',
            },
            durationMs: {
              type: 'number',
              description: 'Duration in ms for swipe/scroll/long_press.',
            },
            normalized: {
              type: 'boolean',
              description: 'Interpret x/y as normalized 0..1 screen fractions.',
            },
            text: {
              type: 'string',
              description: 'Text string to type for action="text".',
            },
            clearFirst: {
              type: 'boolean',
              description: 'For action="text": clear existing field text before typing.',
            },
            submit: {
              type: 'boolean',
              description: 'For action="text": press ENTER after typing.',
            },
            keycode: {
              type: ['number', 'string'],
              description: 'Android KeyEvent code or name (e.g. "ENTER", "DEL", "VOLUME_UP", 66).',
            },
            steps: {
              type: 'array',
              items: { type: 'object' },
              description: 'For action="sequence": ordered list of input steps (including { action: "wait", ms }).',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        execute: (input) => runTool('android_input', input),
      });

      tools.add({
        name: 'android_inspect',
        description:
          'Inspect a booted Android device: dump structured uiautomator UI hierarchy (flat or nested tree with #N indices, center coords, hidden/offScreen flags, and optional #N annotated PNG under /tmp/opencode/), capture a PNG screenshot saved under /tmp/opencode/ (returning { serial, path, width, height, currentFocus }), or read logcat.',
        options: { codemode: false },
        input: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['layout', 'screenshot', 'logcat'],
              description: 'Inspection action.',
            },
            serial: {
              type: 'string',
              description: 'Target ADB serial (optional when one device is booted/selected).',
            },
            filename: {
              type: 'string',
              description:
                'For action="screenshot": optional output file name under /tmp/opencode/ (e.g. "screen_light.png"). Defaults to android-sim-<serial>-<timestamp>.png.',
            },
            annotate: {
              type: 'boolean',
              description: 'For action="layout": also write an annotated PNG with #N bounding boxes.',
            },
            tree: {
              type: 'boolean',
              description: 'For action="layout": return nested parent/children tree instead of flat list.',
            },
            includeAll: {
              type: 'boolean',
              description: 'For action="layout": include non-interactive/unlabeled nodes.',
            },
            maxNodes: {
              type: 'number',
              description: 'For action="layout": maximum nodes to return (default 120).',
            },
            lines: {
              type: 'number',
              description: 'For action="logcat": number of recent log lines (default 120).',
            },
            filter: {
              type: 'string',
              description: 'For action="logcat": optional tag filter spec (e.g. "AndroidRuntime:E *:S").',
            },
            clear: {
              type: 'boolean',
              description: 'For action="logcat": clear logcat buffer instead of reading.',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        execute: (input) => runTool('android_inspect', input),
      });
    });
  },
};
