import {
  GUEST_STATUS_CONTROL_LABEL_MAX,
  GUEST_STATUS_CONTROL_VALUE_MAX,
  GUEST_STATUS_VIEW_NOTE_MAX,
  GUEST_STATUS_VIEW_TEXT_MAX,
  type GuestStatusAction,
  type GuestStatusRow,
  type GuestStatusView,
} from '@openchamber/sdk';
import type { AndroidDevice, SimulatorState } from '../shared/types.ts';

export type StatusActionTarget =
  | { readonly kind: 'boot'; readonly avdName: string }
  | { readonly kind: 'shutdown'; readonly serial: string };

function fnv1aHex6(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

/**
 * Encodes a device action into an OpenChamber Work Status control ID
 * matching `GUEST_STATUS_CONTROL_ID` (`/^[a-z][a-z0-9-]{0,39}$/`).
 */
export function statusActionId(kind: 'boot' | 'shutdown', target: string): string {
  const slug = target
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 22)
    .replace(/-+$/g, '');
  const hash = fnv1aHex6(target);
  return slug ? `${kind}-${slug}-${hash}` : `${kind}-${hash}`;
}

export function resolveStatusAction(
  actionId: string,
  devices: readonly AndroidDevice[],
): StatusActionTarget | null {
  for (const d of devices) {
    if (d.avdName && statusActionId('boot', d.avdName) === actionId) {
      return { kind: 'boot', avdName: d.avdName };
    }
    if (d.serial && statusActionId('shutdown', d.serial) === actionId) {
      return { kind: 'shutdown', serial: d.serial };
    }
  }
  return null;
}

function clampText(raw: string, maxLen: number, fallback = '-'): string {
  const trimmed = raw.trim() || fallback;
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, Math.max(1, maxLen - 1))}…`;
}

export function buildStatusView(state: SimulatorState): GuestStatusView {
  const rows: GuestStatusRow[] = [];

  if (!state.toolsAvailable.adb) {
    rows.push({
      kind: 'note',
      id: 'missing-adb',
      tone: 'error',
      text: 'adb not found. Set ANDROID_HOME or install Android platform-tools.',
    });
    return { rows };
  }

  const active = state.active;
  if (active) {
    const dot =
      active.state === 'booted'
        ? 'success'
        : active.state === 'booting'
          ? 'info'
          : active.state === 'unauthorized'
            ? 'warning'
            : 'muted';
    const actions: GuestStatusAction[] = [];
    if (active.state === 'off' && active.avdName) {
      actions.push({
        kind: 'button',
        id: statusActionId('boot', active.avdName),
        label: 'Boot',
        variant: 'outline',
      });
    } else if (
      active.state === 'booted' &&
      active.serial &&
      (active.kind === 'emulator' || active.transport === 'tcp')
    ) {
      actions.push({
        kind: 'button',
        id: statusActionId('shutdown', active.serial),
        label: active.kind === 'emulator' ? 'Power off' : 'Disconnect',
        variant: 'outline',
        ...(active.kind === 'emulator' ? { confirm: 'Power off?' } : {}),
      });
    }
    const rawValue =
      active.state === 'booted'
        ? active.apiLevel
          ? `API ${active.apiLevel}`
          : 'booted'
        : active.apiLevel
          ? `${active.state} · API ${active.apiLevel}`
          : active.state;
    const detailParts = [
      active.label,
      active.apiLevel ? `API ${active.apiLevel}` : null,
      active.screenWidth && active.screenHeight ? `${active.screenWidth}×${active.screenHeight}` : null,
      active.state,
    ].filter(Boolean);
    rows.push({
      kind: 'line',
      id: 'active-device',
      label: clampText(
        active.avdName ?? active.model ?? active.label,
        GUEST_STATUS_CONTROL_LABEL_MAX,
        'Android device',
      ),
      dot,
      value: clampText(rawValue, GUEST_STATUS_CONTROL_VALUE_MAX),
      tooltip: clampText(detailParts.join(' · '), GUEST_STATUS_VIEW_TEXT_MAX),
      ...(actions.length > 0 ? { actions } : {}),
    });
  } else {
    rows.push({
      kind: 'note',
      id: 'no-device',
      tone: 'muted',
      text:
        state.devices.length === 0
          ? 'No AVDs or ADB devices found.'
          : 'Pick a device in the Android Simulator panel.',
    });
  }

  if (active?.state === 'booted') {
    const streamValue = state.stream.running
      ? state.stream.width > 0 && state.stream.height > 0
        ? `${state.stream.width}×${state.stream.height} · ${Math.round(state.stream.fps)}fps`
        : `${Math.round(state.stream.fps)} fps`
      : 'idle';
    rows.push({
      kind: 'line',
      id: 'stream',
      label: state.stream.running ? `Stream · ${state.stream.mode}` : 'Stream',
      dot: state.stream.running ? (state.agentActive ? 'info' : 'success') : 'muted',
      value: clampText(streamValue, GUEST_STATUS_CONTROL_VALUE_MAX),
      ...(state.stream.running
        ? {
            tooltip: clampText(
              `${state.stream.mode} · ${state.stream.width}×${state.stream.height} · ${state.stream.fps} fps`,
              GUEST_STATUS_VIEW_TEXT_MAX,
            ),
          }
        : {}),
      ...(state.agentActive
        ? { badge: { label: 'Agent\u00A0active', tone: 'info' } }
        : {}),
    });
  }

  const streamError = state.stream.error?.trim();
  if (streamError) {
    rows.push({
      kind: 'note',
      id: 'stream-error',
      tone: 'warning',
      text: clampText(streamError, GUEST_STATUS_VIEW_NOTE_MAX),
    });
  }

  const bootedCount = state.devices.filter((d) => d.state === 'booted').length;
  if (bootedCount > 1) {
    rows.push({
      kind: 'line',
      id: 'other-booted',
      label: 'Connected',
      value: `${bootedCount} online`,
      dot: 'info',
    });
  }

  return { rows };
}
