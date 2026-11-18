import { spawn } from 'node:child_process';
import type { UiNode } from '../shared/types.ts';
import { resolveBinaries } from './exec.ts';

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number.parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    });
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(raw)) !== null) {
    const key = m[1];
    const val = m[2];
    if (key) attrs[key] = decodeXmlEntities(val ?? '');
  }
  return attrs;
}

function parseBounds(
  raw: string,
): { left: number; top: number; right: number; bottom: number } | null {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(raw.trim());
  if (!m) return null;
  const left = Number.parseInt(m[1]!, 10);
  const top = Number.parseInt(m[2]!, 10);
  const right = Number.parseInt(m[3]!, 10);
  const bottom = Number.parseInt(m[4]!, 10);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

export interface ParseHierarchyOptions {
  readonly includeNonInteractive?: boolean;
  readonly maxNodes?: number;
  readonly screen?: { readonly width: number; readonly height: number } | null;
  readonly tree?: boolean;
}

interface MutableNode {
  node: Omit<UiNode, 'children'>;
  children: MutableNode[];
}

export function parseUiHierarchyXml(
  xml: string,
  options: ParseHierarchyOptions = {},
): UiNode[] {
  const flatNodes: UiNode[] = [];
  const roots: MutableNode[] = [];
  const stack: Array<{ xmlDepth: number; keptNode: MutableNode | null }> = [];

  const includeAll = options.includeNonInteractive === true;
  const limit = options.maxNodes ?? 200;
  const screen = options.screen ?? null;

  const tagRe = /<(\/?)node\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let nextIndex = 1;
  let xmlDepth = 0;

  while ((m = tagRe.exec(xml)) !== null) {
    const isClosing = m[1] === '/';
    const rawAttrs = m[2] ?? '';
    const isSelfClosing = m[3] === '/';

    if (isClosing) {
      while (stack.length > 0 && stack[stack.length - 1]!.xmlDepth >= xmlDepth) {
        stack.pop();
      }
      xmlDepth = Math.max(0, xmlDepth - 1);
      continue;
    }

    const curDepth = xmlDepth;
    const attrs = parseAttributes(rawAttrs);
    const bounds = parseBounds(attrs.bounds ?? '');

    let keptMutable: MutableNode | null = null;
    if (bounds && flatNodes.length < limit) {
      const clickable = attrs.clickable === 'true';
      const longClickable = attrs['long-clickable'] === 'true';
      const scrollable = attrs.scrollable === 'true';
      const checkable = attrs.checkable === 'true';
      const checked = attrs.checked === 'true';
      const selected = attrs.selected === 'true';
      const password = attrs.password === 'true';
      const enabled = attrs.enabled !== 'false';
      const focused = attrs.focused === 'true';
      const hidden = attrs['visible-to-user'] === 'false';
      const className = attrs.class ?? '';
      const editable =
        attrs.editable === 'true' ||
        className.endsWith('EditText') ||
        className.includes('TextInput');
      const text = (attrs.text ?? '').trim();
      const contentDesc = (attrs['content-desc'] ?? '').trim();
      const resourceId = (attrs['resource-id'] ?? '').trim();
      const packageName = (attrs.package ?? '').trim();

      const offScreen = screen
        ? bounds.right <= 0 ||
          bounds.bottom <= 0 ||
          bounds.left >= screen.width ||
          bounds.top >= screen.height
        : false;

      const isInteractive = clickable || longClickable || scrollable || checkable || editable;
      const hasLabel = text.length > 0 || contentDesc.length > 0;

      if (includeAll || isInteractive || hasLabel) {
        let parentMutable: MutableNode | null = null;
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i]!.keptNode) {
            parentMutable = stack[i]!.keptNode;
            break;
          }
        }

        const baseNode: Omit<UiNode, 'children'> = {
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
            y: Math.round((bounds.top + bounds.bottom) / 2),
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
          offScreen,
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

  if (!options.tree) return flatNodes;

  const freezeTree = (item: MutableNode): UiNode =>
    item.children.length > 0
      ? { ...item.node, children: item.children.map(freezeTree) }
      : item.node;

  return roots.map(freezeTree);
}

export interface SelectorObject {
  readonly text?: string;
  readonly resourceId?: string;
  readonly contentDesc?: string;
  readonly className?: string;
  readonly clickable?: boolean;
  readonly longClickable?: boolean;
  readonly scrollable?: boolean;
  readonly editable?: boolean;
  readonly checkable?: boolean;
  readonly checked?: boolean;
  readonly selected?: boolean;
  readonly focused?: boolean;
  readonly enabled?: boolean;
  readonly includeHidden?: boolean;
}

export type UiSelector = string | SelectorObject;

interface Clause {
  readonly key: string;
  readonly value: string;
}

function splitSelectorClauses(raw: string): Clause[] {
  const clauses: Clause[] = [];
  let buf = '';
  let inRegex = false;
  let quote: string | null = null;

  const flush = () => {
    const trimmed = buf.trim();
    buf = '';
    if (!trimmed) return;
    const eq = trimmed.indexOf('=');
    const colon = trimmed.indexOf(':');
    const sep =
      eq !== -1 && (colon === -1 || eq < colon)
        ? eq
        : colon;
    if (sep <= 0) {
      // Bare string acts as text/contentDesc match
      clauses.push({ key: 'anytext', value: trimmed });
      return;
    }
    const key = trimmed.slice(0, sep).trim().toLowerCase();
    let val = trimmed.slice(sep + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    clauses.push({ key, value: val });
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote && raw[i - 1] !== '\\') quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '/' && buf.includes('=') || (ch === '/' && inRegex)) {
      inRegex = !inRegex;
      buf += ch;
      continue;
    }
    if (ch === ',' && !inRegex) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return clauses;
}

function matchStringField(actual: string, expected: string): boolean {
  if (expected === '*') return actual.length > 0;
  const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(expected);
  if (regexMatch) {
    try {
      const re = new RegExp(regexMatch[1]!, regexMatch[2] || 'i');
      return re.test(actual);
    } catch {
      return false;
    }
  }
  return actual.toLowerCase().includes(expected.toLowerCase());
}

function parseBool(raw: string): boolean | null {
  const low = raw.trim().toLowerCase();
  if (low === 'true' || low === '1' || low === 'yes') return true;
  if (low === 'false' || low === '0' || low === 'no') return false;
  return null;
}

function nodeMatchesClause(node: UiNode, clause: Clause): boolean {
  switch (clause.key) {
    case 'text':
    case 'txt':
      return matchStringField(node.text, clause.value);
    case 'id':
    case 'res':
    case 'resourceid':
    case 'resource-id':
      return matchStringField(node.resourceId, clause.value);
    case 'desc':
    case 'content':
    case 'contentdesc':
    case 'content-desc':
      return matchStringField(node.contentDesc, clause.value);
    case 'anytext':
      return (
        matchStringField(node.text, clause.value) ||
        matchStringField(node.contentDesc, clause.value)
      );
    case 'class':
    case 'clazz':
    case 'cls':
    case 'clz':
    case 'classname':
      return matchStringField(node.className, clause.value);
    case 'pkg':
    case 'package':
      return matchStringField(node.packageName, clause.value);
    case 'clickable':
      return parseBool(clause.value) === node.clickable;
    case 'longclickable':
    case 'long-clickable':
      return parseBool(clause.value) === node.longClickable;
    case 'scrollable':
      return parseBool(clause.value) === node.scrollable;
    case 'editable':
      return parseBool(clause.value) === node.editable;
    case 'checkable':
      return parseBool(clause.value) === node.checkable;
    case 'checked':
      return parseBool(clause.value) === node.checked;
    case 'selected':
      return parseBool(clause.value) === node.selected;
    case 'focused':
      return parseBool(clause.value) === node.focused;
    case 'enabled':
      return parseBool(clause.value) === node.enabled;
    case 'password':
      return parseBool(clause.value) === node.password;
    case 'hidden':
      return parseBool(clause.value) === node.hidden;
    case 'offscreen':
      return parseBool(clause.value) === node.offScreen;
    default:
      return false;
  }
}

export function matchUiNodes(nodes: readonly UiNode[], selector: UiSelector): UiNode[] {
  const flat: UiNode[] = [];
  const collect = (list: readonly UiNode[]) => {
    for (const n of list) {
      flat.push(n);
      if (n.children) collect(n.children);
    }
  };
  collect(nodes);

  if (typeof selector === 'string') {
    const clauses = splitSelectorClauses(selector);
    if (clauses.length === 0) return [];
    const allowHidden = clauses.some((c) => c.key === 'hidden' || c.key === 'offscreen');
    return flat.filter(
      (n) =>
        (allowHidden || (!n.hidden && !n.offScreen)) &&
        clauses.every((c) => nodeMatchesClause(n, c)),
    );
  }

  return flat.filter((n) => {
    if (!selector.includeHidden && (n.hidden || n.offScreen)) return false;
    if (selector.text !== undefined && !matchStringField(n.text, selector.text)) return false;
    if (selector.resourceId !== undefined && !matchStringField(n.resourceId, selector.resourceId)) return false;
    if (selector.contentDesc !== undefined && !matchStringField(n.contentDesc, selector.contentDesc)) return false;
    if (selector.className !== undefined && !matchStringField(n.className, selector.className)) return false;
    if (selector.clickable !== undefined && n.clickable !== selector.clickable) return false;
    if (selector.longClickable !== undefined && n.longClickable !== selector.longClickable) return false;
    if (selector.scrollable !== undefined && n.scrollable !== selector.scrollable) return false;
    if (selector.editable !== undefined && n.editable !== selector.editable) return false;
    if (selector.checkable !== undefined && n.checkable !== selector.checkable) return false;
    if (selector.checked !== undefined && n.checked !== selector.checked) return false;
    if (selector.selected !== undefined && n.selected !== selector.selected) return false;
    if (selector.focused !== undefined && n.focused !== selector.focused) return false;
    if (selector.enabled !== undefined && n.enabled !== selector.enabled) return false;
    return true;
  });
}

// Minimal 3x5 bitmap glyphs for digits 0-9 and '#'
const GLYPHS: Record<string, readonly string[]> = {
  '#': ['101', '111', '101', '111', '101'],
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

function setPixel(
  buf: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const idx = (y * width + x) * 4;
  buf[idx] = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
  buf[idx + 3] = a;
}

function drawRectOutline(
  buf: Buffer,
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  thickness: number,
  color: readonly [number, number, number],
): void {
  const [r, g, b] = color;
  for (let t = 0; t < thickness; t += 1) {
    for (let x = left; x <= right; x += 1) {
      setPixel(buf, width, height, x, top + t, r, g, b);
      setPixel(buf, width, height, x, bottom - t, r, g, b);
    }
    for (let y = top; y <= bottom; y += 1) {
      setPixel(buf, width, height, left + t, y, r, g, b);
      setPixel(buf, width, height, right - t, y, r, g, b);
    }
  }
}

function drawBadge(
  buf: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  label: string,
  color: readonly [number, number, number],
): void {
  const scale = 2;
  const charW = 3 * scale;
  const gap = 2;
  const pad = 4;
  const textW = label.length * charW + Math.max(0, label.length - 1) * gap;
  const boxW = textW + pad * 2;
  const boxH = 5 * scale + pad * 2;
  const bx = Math.max(0, Math.min(width - boxW, x));
  const by = Math.max(0, Math.min(height - boxH, y));

  for (let py = by; py < by + boxH; py += 1) {
    for (let px = bx; px < bx + boxW; px += 1) {
      setPixel(buf, width, height, px, py, color[0], color[1], color[2], 240);
    }
  }

  let cursorX = bx + pad;
  const cursorY = by + pad;
  for (const ch of label) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (let gy = 0; gy < 5; gy += 1) {
        const row = glyph[gy] ?? '';
        for (let gx = 0; gx < 3; gx += 1) {
          if (row[gx] !== '1') continue;
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              setPixel(buf, width, height, cursorX + gx * scale + sx, cursorY + gy * scale + sy, 255, 255, 255);
            }
          }
        }
      }
    }
    cursorX += charW + gap;
  }
}

function parsePngDimensions(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24) return null;
  if (png.readUInt32BE(0) !== 0x89504e47) return null;
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

function runFfmpegPipe(ffmpeg: string, args: readonly string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let errText = '';
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      errText += chunk.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(errText.trim() || `ffmpeg exited ${code}`));
    });
    proc.stdin.end(input);
  });
}

export async function annotateScreenshotPng(
  png: Buffer,
  nodes: readonly UiNode[],
): Promise<Buffer> {
  const bins = resolveBinaries();
  const dims = parsePngDimensions(png);
  if (!bins.ffmpeg || !dims || nodes.length === 0) return png;

  const rgba = await runFfmpegPipe(
    bins.ffmpeg,
    ['-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    png,
  );
  if (rgba.length !== dims.width * dims.height * 4) return png;

  const palette: ReadonlyArray<readonly [number, number, number]> = [
    [220, 38, 38],
    [37, 99, 235],
    [5, 150, 105],
    [217, 119, 6],
    [124, 58, 237],
  ];

  const drawNode = (node: UiNode) => {
    if (!node.hidden && !node.offScreen && (node.clickable || node.editable || node.scrollable || node.checkable)) {
      const color = palette[(node.index - 1) % palette.length]!;
      drawRectOutline(
        rgba,
        dims.width,
        dims.height,
        node.bounds.left,
        node.bounds.top,
        node.bounds.right,
        node.bounds.bottom,
        3,
        color,
      );
      drawBadge(
        rgba,
        dims.width,
        dims.height,
        node.bounds.left,
        Math.max(0, node.bounds.top - 18),
        `#${node.index}`,
        color,
      );
    }
    if (node.children) {
      for (const child of node.children) drawNode(child);
    }
  };
  for (const node of nodes) drawNode(node);

  return runFfmpegPipe(
    bins.ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${dims.width}x${dims.height}`,
      '-i',
      'pipe:0',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ],
    rgba,
  );
}
