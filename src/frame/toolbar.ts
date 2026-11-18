import { mountBadge, mountButton, mountSelect, mountTextField } from '@openchamber/sdk/ui';
import type { QualityPreset, SimulatorState } from '../shared/types.ts';
import type { FrameController } from './host.ts';

export interface ToolbarOptions {
  readonly showFrameToggle?: boolean;
  readonly onPickDevice?: (id: string) => void;
  readonly onExtrasToggle?: (open: boolean) => void;
}

export interface ToolbarHandle {
  readonly update: (state: SimulatorState) => void;
  readonly isExtrasOpen: () => boolean;
}

export function createToolbar(
  container: HTMLElement,
  ctrl: FrameController,
  options: ToolbarOptions = {},
): ToolbarHandle {
  const wrap = document.createElement('div');
  wrap.className = 'oc-bar-wrap';

  const row = document.createElement('div');
  row.className = 'oc-bar-row';

  const deviceBox = document.createElement('div');
  deviceBox.className = 'oc-slot-device';
  const powerBox = document.createElement('div');
  powerBox.className = 'oc-slot-btn';
  const navGroup = document.createElement('div');
  navGroup.className = 'oc-slot-group';
  const backBox = document.createElement('div');
  const homeBox = document.createElement('div');
  const recentsBox = document.createElement('div');
  navGroup.append(backBox, homeBox, recentsBox);

  const actGroup = document.createElement('div');
  actGroup.className = 'oc-slot-group';
  const rotateBox = document.createElement('div');
  const darkBox = document.createElement('div');
  const lockBox = document.createElement('div');
  const frameBox = document.createElement('div');
  const qualityBox = document.createElement('div');
  const extrasToggleBox = document.createElement('div');
  actGroup.append(rotateBox, darkBox, lockBox);
  if (options.showFrameToggle) actGroup.append(frameBox);
  actGroup.append(qualityBox, extrasToggleBox);

  const badgeBox = document.createElement('div');
  badgeBox.className = 'oc-slot-badge';

  row.append(deviceBox, powerBox, navGroup, actGroup, badgeBox);

  // Expandable inline row for APK Install & Open URL / Deep Link
  const extrasRow = document.createElement('div');
  extrasRow.className = 'oc-extras-row';
  extrasRow.style.display = 'none';

  const apkInputBox = document.createElement('div');
  apkInputBox.className = 'oc-extra-field';
  const apkBtnBox = document.createElement('div');
  const urlInputBox = document.createElement('div');
  urlInputBox.className = 'oc-extra-field';
  const urlBtnBox = document.createElement('div');

  extrasRow.append(apkInputBox, apkBtnBox, urlInputBox, urlBtnBox);
  wrap.append(row, extrasRow);
  container.append(wrap);

  let latest: SimulatorState | null = null;
  let extrasOpen = false;
  let apkValue = '';
  let urlValue = '';
  let restoredStorage = false;

  const targetBody = (extra: Record<string, unknown> = {}) => {
    const id = latest?.active?.id;
    return id ? { id, ...extra } : extra;
  };

  const deviceSelect = mountSelect(deviceBox, {
    value: null,
    options: [],
    placeholder: 'No devices',
    onChange: (id) => {
      void ctrl.host.storage.set('selectedDevice', id);
      if (options.onPickDevice) {
        options.onPickDevice(id);
      } else {
        void ctrl.act('/select', { id });
      }
    },
  });

  const powerBtn = mountButton(powerBox, {
    label: 'Boot',
    variant: 'outline',
    size: 'xs',
    onClick: () => {
      const dev = latest?.active;
      if (!dev) return;
      if (dev.state === 'off' && dev.avdName) {
        void ctrl.act('/boot', { id: dev.id, avdName: dev.avdName });
      } else if (dev.state === 'booted' && dev.serial) {
        void ctrl.act('/shutdown', { id: dev.id });
      }
    },
  });

  const backBtn = mountButton(backBox, {
    label: 'Back',
    variant: 'ghost',
    size: 'xs',
    onClick: () => void ctrl.act('/button', targetBody({ name: 'back' })),
  });
  const homeBtn = mountButton(homeBox, {
    label: 'Home',
    variant: 'ghost',
    size: 'xs',
    onClick: () => void ctrl.act('/button', targetBody({ name: 'home' })),
  });
  const recentsBtn = mountButton(recentsBox, {
    label: 'Recents',
    variant: 'ghost',
    size: 'xs',
    onClick: () => void ctrl.act('/button', targetBody({ name: 'recents' })),
  });
  const rotateBtn = mountButton(rotateBox, {
    label: 'Rotate',
    variant: 'ghost',
    size: 'xs',
    onClick: () => void ctrl.act('/rotate', targetBody()),
  });
  const darkBtn = mountButton(darkBox, {
    label: 'Theme',
    variant: 'ghost',
    size: 'xs',
    onClick: () => void ctrl.act('/appearance', targetBody()),
  });
  const lockBtn = mountButton(lockBox, {
    label: 'Power',
    variant: 'ghost',
    size: 'xs',
    onClick: () => void ctrl.act('/button', targetBody({ name: 'power' })),
  });
  const frameBtn = options.showFrameToggle
    ? mountButton(frameBox, {
        label: 'Frame',
        variant: 'outline',
        size: 'xs',
        onClick: () => {
          const next = !(latest?.framed ?? true);
          void ctrl.host.storage.set('framed', next);
          void ctrl.act('/frame', { on: next });
        },
      })
    : null;

  const qualityNext: Record<QualityPreset, QualityPreset> = {
    full: 'balanced',
    balanced: 'fast',
    fast: 'full',
  };
  const qualityLabel: Record<QualityPreset, string> = {
    full: '1:1',
    balanced: '1:2',
    fast: '1:3',
  };
  const qualityBtn = mountButton(qualityBox, {
    label: '1:2',
    variant: 'outline',
    size: 'xs',
    onClick: () => {
      const q = qualityNext[latest?.quality ?? 'balanced'];
      void ctrl.host.storage.set('quality', q);
      void ctrl.act('/quality', { value: q });
    },
  });

  const extrasToggleBtn = mountButton(extrasToggleBox, {
    label: 'APK / URL',
    variant: 'ghost',
    size: 'xs',
    onClick: () => {
      extrasOpen = !extrasOpen;
      extrasRow.style.display = extrasOpen ? 'flex' : 'none';
      extrasToggleBtn.update({ variant: extrasOpen ? 'secondary' : 'ghost' });
      options.onExtrasToggle?.(extrasOpen);
    },
  });

  const badge = mountBadge(badgeBox, { label: 'idle', tone: 'neutral' });

  const apkField = mountTextField(apkInputBox, {
    value: '',
    placeholder: '~/path/to/app-debug.apk',
    onChange: (val) => {
      apkValue = val;
    },
  });
  const apkInstallBtn = mountButton(apkBtnBox, {
    label: 'Install APK',
    variant: 'outline',
    size: 'xs',
    onClick: () => {
      if (!apkValue.trim()) return;
      void ctrl.act('/install-apk', targetBody({ apkPath: apkValue.trim() }));
    },
  });

  const urlField = mountTextField(urlInputBox, {
    value: '',
    placeholder: 'https://... or myapp://deeplink',
    onChange: (val) => {
      urlValue = val;
    },
  });
  const urlOpenBtn = mountButton(urlBtnBox, {
    label: 'Open URL',
    variant: 'outline',
    size: 'xs',
    onClick: () => {
      if (!urlValue.trim()) return;
      void ctrl.act('/open-url', targetBody({ url: urlValue.trim() }));
    },
  });

  const restorePreferences = async (state: SimulatorState) => {
    if (restoredStorage) return;
    restoredStorage = true;
    try {
      const savedQuality = await ctrl.host.storage.get('quality');
      if (
        (savedQuality === 'full' || savedQuality === 'balanced' || savedQuality === 'fast') &&
        savedQuality !== state.quality
      ) {
        await ctrl.act('/quality', { value: savedQuality });
      }
      if (options.showFrameToggle) {
        const savedFramed = await ctrl.host.storage.get('framed');
        if (typeof savedFramed === 'boolean' && savedFramed !== state.framed) {
          await ctrl.act('/frame', { on: savedFramed });
        }
      }
    } catch {
      // ignore storage failure
    }
  };

  return {
    isExtrasOpen: () => extrasOpen,
    update: (state: SimulatorState) => {
      latest = state;
      void restorePreferences(state);

      deviceSelect.update({
        value: state.active?.id ?? state.selectedId,
        options: state.devices.map((d) => ({
          id: d.id,
          label: d.avdName ?? d.model ?? d.label,
          hint: d.apiLevel ? `${d.state} · API ${d.apiLevel}` : d.state,
        })),
      });

      const active = state.active;
      const booted = active?.state === 'booted';
      const booting = active?.state === 'booting';
      const canBoot = active?.state === 'off' && Boolean(active.avdName);
      const canStop = booted && (active?.kind === 'emulator' || active?.transport === 'tcp');

      powerBtn.update({
        label: booting ? 'Booting…' : canStop ? (active?.kind === 'emulator' ? 'Off' : 'Unplug') : 'Boot',
        variant: canBoot ? 'default' : 'outline',
        disabled: !canBoot && !canStop,
        loading: booting,
      });

      backBtn.update({ disabled: !booted });
      homeBtn.update({ disabled: !booted });
      recentsBtn.update({ disabled: !booted });
      rotateBtn.update({ disabled: !booted });
      darkBtn.update({
        disabled: !booted,
        label: state.appearance === 'dark' ? 'Light' : 'Dark',
      });
      lockBtn.update({ disabled: !booted });
      frameBtn?.update({
        variant: state.framed ? 'secondary' : 'outline',
      });
      qualityBtn.update({ label: qualityLabel[state.quality] });
      apkInstallBtn.update({ disabled: !booted });
      urlOpenBtn.update({ disabled: !booted });
      void apkField;
      void urlField;

      if (state.agentActive) {
        badge.update({ label: 'Agent', tone: 'info' });
      } else if (!state.toolsAvailable.adb) {
        badge.update({ label: 'No adb', tone: 'error' });
      } else if (booted && state.stream.running) {
        badge.update({ label: `${state.stream.fps} fps`, tone: 'success' });
      } else if (booting) {
        badge.update({ label: 'Booting', tone: 'info' });
      } else if (active) {
        badge.update({ label: active.state, tone: 'neutral' });
      } else {
        badge.update({ label: 'None', tone: 'neutral' });
      }
    },
  };
}
