import type { SurfaceInputEvent } from '@openchamber/sdk';
import { GUEST_UI_LOOK_CSS, mountEmpty } from '@openchamber/sdk/ui';
import { blobUrl } from '../../shared/protocol.ts';
import { BLOB_CHUNK, type AndroidDevice, type BlobRef, type PageFrame, type SimulatorState } from '../../shared/types.ts';
import { startFrame, type FrameController } from '../host.ts';
import { createToolbar, type ToolbarHandle } from '../toolbar.ts';

const style = document.createElement('style');
style.textContent = GUEST_UI_LOOK_CSS;
document.head.append(style);

const MAX_TILES = 4;
const STORAGE_TILES_KEY = 'pageTiles';

const root = document.querySelector<HTMLElement>('#root')!;
const barEl = document.createElement('div');
barEl.className = 'oc-page-bar';
const tilesEl = document.createElement('div');
tilesEl.className = 'oc-tiles';
root.append(barEl, tilesEl);

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = window.atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

async function readBlobBytes(ctrl: FrameController, ref: BlobRef): Promise<Uint8Array> {
  const offsets: number[] = [];
  for (let off = 0; off < ref.length; off += BLOB_CHUNK) {
    offsets.push(off);
  }
  const chunks = await Promise.all(
    offsets.map(async (off) => {
      const res = await ctrl.host.serviceRequest({
        method: 'GET',
        path: blobUrl(ref, off),
      });
      if (res.status !== 200) throw new Error(`Blob read failed (${res.status})`);
      return res.body;
    }),
  );
  return base64ToUint8Array(chunks.join(''));
}

interface TileHandle {
  readonly element: HTMLElement;
  readonly getDeviceId: () => string;
  readonly setDeviceId: (id: string) => void;
  readonly setFocused: (focused: boolean) => void;
  readonly updateState: (state: SimulatorState) => void;
  readonly dispose: () => void;
}

function createTile(params: {
  initialDeviceId: string;
  ctrl: FrameController;
  onFocus: (tile: TileHandle) => void;
  onAdd: () => void;
  onClose: (tile: TileHandle) => void;
  canAdd: () => boolean;
  canClose: () => boolean;
}): TileHandle {
  const { ctrl } = params;
  let deviceId = params.initialDeviceId;
  let latestState: SimulatorState | null = null;
  let disposed = false;
  let seq = 0;
  let frameWidth = 0;
  let frameHeight = 0;
  let queue: SurfaceInputEvent[] = [];
  let flushScheduled = false;
  let dragging = false;

  const el = document.createElement('div');
  el.className = 'oc-tile';
  el.tabIndex = 0;

  const titleEl = document.createElement('div');
  titleEl.className = 'oc-tile-title';

  const corner = document.createElement('div');
  corner.className = 'oc-tile-corner';
  const addBtn = document.createElement('button');
  addBtn.className = 'oc-mini-btn';
  addBtn.type = 'button';
  addBtn.textContent = '+';
  addBtn.title = 'Add simulator tile';
  addBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    params.onAdd();
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'oc-mini-btn';
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close tile';
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    params.onClose(handle);
  });
  corner.append(addBtn, closeBtn);

  const stage = document.createElement('div');
  stage.className = 'oc-device-stage';

  const bezel = document.createElement('div');
  bezel.className = 'oc-bezel is-framed';

  const canvas = document.createElement('canvas');
  canvas.className = 'oc-screen-canvas';

  const hwSide = document.createElement('div');
  hwSide.className = 'oc-hw-side';
  const makeHwBtn = (cls: string, name: string, title: string) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `oc-hw-key ${cls}`;
    btn.title = title;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void ctrl.act('/button', { id: deviceId, name });
    });
    return btn;
  };
  hwSide.append(
    makeHwBtn('vol', 'volume_up', 'Volume Up'),
    makeHwBtn('vol', 'volume_down', 'Volume Down'),
    makeHwBtn('power', 'power', 'Power / Lock'),
  );

  bezel.append(canvas, hwSide);
  const emptyWrap = document.createElement('div');
  emptyWrap.className = 'oc-tile-empty';
  stage.append(bezel, emptyWrap);
  el.append(titleEl, corner, stage);

  let emptyMount: ReturnType<typeof mountEmpty> | null = null;

  function layoutCanvas(): void {
    if (frameWidth <= 0 || frameHeight <= 0) return;
    const rect = stage.getBoundingClientRect();
    const padX = bezel.classList.contains('is-framed') ? 38 : 16;
    const padY = bezel.classList.contains('is-framed') ? 54 : 24;
    const availW = Math.max(80, rect.width - padX);
    const availH = Math.max(80, rect.height - padY);
    const scale = Math.min(availW / frameWidth, availH / frameHeight);
    canvas.style.width = `${Math.max(1, Math.floor(frameWidth * scale))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(frameHeight * scale))}px`;
  }

  new ResizeObserver(() => layoutCanvas()).observe(stage);

  function flushInput(): void {
    flushScheduled = false;
    if (disposed || queue.length === 0 || frameWidth <= 0 || frameHeight <= 0) {
      queue = [];
      return;
    }
    const batch = queue.slice(0, 256);
    queue = queue.slice(256);
    void ctrl.host.serviceRequest({
      method: 'POST',
      path: '/page/input',
      body: JSON.stringify({
        serial: deviceId,
        width: frameWidth,
        height: frameHeight,
        events: batch,
      }),
    });
    if (queue.length > 0 && !flushScheduled) {
      flushScheduled = true;
      window.requestAnimationFrame(flushInput);
    }
  }

  function enqueueInput(ev: SurfaceInputEvent): void {
    queue.push(ev);
    if (!flushScheduled) {
      flushScheduled = true;
      window.requestAnimationFrame(flushInput);
    }
  }

  function toFrameCoords(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const rx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const ry = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    return {
      x: Math.max(0, Math.min(frameWidth - 1, Math.round(rx * frameWidth))),
      y: Math.max(0, Math.min(frameHeight - 1, Math.round(ry * frameHeight))),
    };
  }

  function modsOf(ev: MouseEvent | WheelEvent | KeyboardEvent) {
    return { alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey };
  }

  el.addEventListener('pointerdown', () => params.onFocus(handle));

  canvas.addEventListener('pointerdown', (ev) => {
    params.onFocus(handle);
    el.focus();
    if (ev.button !== 0 || frameWidth <= 0) return;
    dragging = true;
    canvas.setPointerCapture(ev.pointerId);
    const pt = toFrameCoords(ev.clientX, ev.clientY);
    enqueueInput({
      type: 'pointer',
      action: 'down',
      x: pt.x,
      y: pt.y,
      button: ev.button,
      buttons: ev.buttons,
      modifiers: modsOf(ev),
    });
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!dragging || frameWidth <= 0) return;
    const pt = toFrameCoords(ev.clientX, ev.clientY);
    enqueueInput({
      type: 'pointer',
      action: 'move',
      x: pt.x,
      y: pt.y,
      button: -1,
      buttons: ev.buttons,
      modifiers: modsOf(ev),
    });
  });

  const endDrag = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    const pt = toFrameCoords(ev.clientX, ev.clientY);
    enqueueInput({
      type: 'pointer',
      action: 'up',
      x: pt.x,
      y: pt.y,
      button: ev.button,
      buttons: ev.buttons,
      modifiers: modsOf(ev),
    });
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      if (frameWidth <= 0) return;
      const pt = toFrameCoords(ev.clientX, ev.clientY);
      enqueueInput({
        type: 'wheel',
        x: pt.x,
        y: pt.y,
        deltaX: ev.deltaX,
        deltaY: ev.deltaY,
        modifiers: modsOf(ev),
      });
    },
    { passive: false },
  );

  el.addEventListener('keydown', (ev) => {
    if (ev.target !== el) return;
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      enqueueInput({ type: 'text', text: ev.key });
      ev.preventDefault();
      return;
    }
    enqueueInput({
      type: 'key',
      action: 'down',
      key: ev.key,
      code: ev.code,
      keyCode: ev.keyCode,
      modifiers: modsOf(ev),
    });
  });

  el.addEventListener('keyup', (ev) => {
    if (ev.target !== el) return;
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) return;
    enqueueInput({
      type: 'key',
      action: 'up',
      key: ev.key,
      code: ev.code,
      keyCode: ev.keyCode,
      modifiers: modsOf(ev),
    });
  });

  el.addEventListener('paste', (ev) => {
    const text = ev.clipboardData?.getData('text/plain');
    if (text) {
      ev.preventDefault();
      enqueueInput({ type: 'text', text });
    }
  });

  async function pump(): Promise<void> {
    while (!disposed) {
      if (document.visibilityState === 'hidden') {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      const dev = latestState?.devices.find((d) => d.id === deviceId || d.serial === deviceId);
      if (!dev || dev.state !== 'booted') {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      try {
        const res = await ctrl.host.serviceRequest({
          method: 'GET',
          path: `/page/frame?serial=${encodeURIComponent(dev.serial ?? deviceId)}&after=${seq}&wait=8000`,
        });
        if (disposed) break;
        if (res.status === 204) continue;
        if (res.status !== 200) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        const frame = JSON.parse(res.body) as PageFrame;
        const bytes = await readBlobBytes(ctrl, frame.data);
        if (disposed) break;
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: frame.mime });
        const bitmap = await window.createImageBitmap(blob);
        if (disposed) {
          bitmap.close();
          break;
        }
        seq = frame.seq;
        if (canvas.width !== frame.width || canvas.height !== frame.height) {
          canvas.width = frame.width;
          canvas.height = frame.height;
        }
        frameWidth = frame.width;
        frameHeight = frame.height;
        const ctx2d = canvas.getContext('2d');
        ctx2d?.drawImage(bitmap, 0, 0, frame.width, frame.height);
        bitmap.close();
        layoutCanvas();
      } catch {
        await new Promise((r) => setTimeout(r, 450));
      }
    }
  }

  void pump();

  function renderDevicePlaceholder(dev: AndroidDevice | null): void {
    const booted = dev?.state === 'booted';
    bezel.style.display = booted ? 'flex' : 'none';
    emptyWrap.style.display = booted ? 'none' : 'block';
    titleEl.textContent = dev ? dev.avdName ?? dev.model ?? dev.label : deviceId;
    addBtn.style.display = params.canAdd() ? '' : 'none';
    closeBtn.style.display = params.canClose() ? '' : 'none';

    if (!booted) {
      const title = dev ? `${dev.avdName ?? dev.label} is ${dev.state}` : 'No device selected';
      const body =
        dev?.state === 'booting'
          ? 'Waiting for Android to finish booting…'
          : dev?.avdName
            ? 'Click Boot to start this emulator.'
            : 'Pick another device from the toolbar.';
      const action =
        dev?.state === 'off' && dev.avdName
          ? {
              label: 'Boot',
              onClick: () => {
                void ctrl.act('/boot', { id: dev.id, avdName: dev.avdName, select: false });
              },
            }
          : undefined;
      if (!emptyMount) {
        emptyMount = mountEmpty(emptyWrap, { title, body, action });
      } else {
        emptyMount.update({ title, body, action });
      }
    }
  }

  const handle: TileHandle = {
    element: el,
    getDeviceId: () => deviceId,
    setDeviceId: (id: string) => {
      deviceId = id;
      seq = 0;
      frameWidth = 0;
      frameHeight = 0;
      if (latestState) renderDevicePlaceholder(
        latestState.devices.find((d) => d.id === deviceId || d.serial === deviceId) ?? null,
      );
    },
    setFocused: (focused: boolean) => {
      el.classList.toggle('is-focused', focused);
    },
    updateState: (state: SimulatorState) => {
      latestState = state;
      bezel.classList.toggle('is-framed', state.framed);
      const dev = state.devices.find((d) => d.id === deviceId || d.serial === deviceId) ?? null;
      renderDevicePlaceholder(dev);
      layoutCanvas();
    },
    dispose: () => {
      disposed = true;
      emptyMount?.dispose();
      el.remove();
    },
  };

  return handle;
}

const tiles: TileHandle[] = [];
let focusedTile: TileHandle | null = null;
let toolbar: ToolbarHandle | null = null;
let initializedTiles = false;

function persistTiles(ctrl: FrameController): void {
  void ctrl.host.storage.set(
    STORAGE_TILES_KEY,
    tiles.map((t) => t.getDeviceId()),
  );
}

function setFocus(tile: TileHandle, ctrl: FrameController): void {
  focusedTile = tile;
  for (const t of tiles) t.setFocused(t === tile);
  void ctrl.refresh();
}

function addTile(deviceId: string, ctrl: FrameController, state: SimulatorState | null): void {
  if (tiles.length >= MAX_TILES) return;
  const tile = createTile({
    initialDeviceId: deviceId,
    ctrl,
    onFocus: (t) => setFocus(t, ctrl),
    onAdd: () => {
      const s = ctrl.getState();
      const used = new Set(tiles.map((t) => t.getDeviceId()));
      const next =
        s?.devices.find((d) => !used.has(d.id))?.id ??
        s?.devices[0]?.id ??
        deviceId;
      addTile(next, ctrl, s);
      persistTiles(ctrl);
    },
    onClose: (t) => {
      if (tiles.length <= 1) return;
      const idx = tiles.indexOf(t);
      if (idx === -1) return;
      tiles.splice(idx, 1);
      t.dispose();
      if (focusedTile === t && tiles[0]) {
        setFocus(tiles[0], ctrl);
      }
      const s = ctrl.getState();
      if (s) for (const remaining of tiles) remaining.updateState(s);
      persistTiles(ctrl);
    },
    canAdd: () => tiles.length < MAX_TILES,
    canClose: () => tiles.length > 1,
  });
  tiles.push(tile);
  tilesEl.append(tile.element);
  if (!focusedTile) setFocus(tile, ctrl);
  if (state) {
    for (const t of tiles) t.updateState(state);
  }
}

const ctrl = startFrame({
  targetId: () => focusedTile?.getDeviceId() ?? null,
  onReady: (ctx) => {
    if (ctx.surface === 'popover') return;
    if (!toolbar) {
      toolbar = createToolbar(barEl, ctrl, {
        showFrameToggle: true,
        onPickDevice: (id) => {
          focusedTile?.setDeviceId(id);
          persistTiles(ctrl);
          void ctrl.refresh();
        },
      });
    }
  },
  onState: (state) => {
    if (ctrl.getReady()?.surface === 'popover') return;
    if (!initializedTiles) {
      initializedTiles = true;
      void ctrl.host.storage.get(STORAGE_TILES_KEY).then((saved: unknown) => {
        const ids = Array.isArray(saved)
          ? saved.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, MAX_TILES)
          : [];
        const initial = ids.length > 0 ? ids : [state.active?.id ?? state.devices[0]?.id ?? 'default'];
        for (const id of initial) addTile(id, ctrl, state);
      });
    }
    toolbar?.update(state);
    for (const t of tiles) t.updateState(state);
  },
});
