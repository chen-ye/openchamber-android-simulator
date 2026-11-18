import type { GuestStatusAction, GuestStatusRow, GuestStatusView } from '@openchamber/sdk';
import type { SimulatorState } from '../shared/types.ts';

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
      actions.push({ kind: 'button', id: `boot:${active.avdName}`, label: 'Boot', variant: 'outline' });
    } else if (active.state === 'booted' && active.serial && (active.kind === 'emulator' || active.transport === 'tcp')) {
      actions.push({
        kind: 'button',
        id: `shutdown:${active.serial}`,
        label: active.kind === 'emulator' ? 'Power off' : 'Disconnect',
        variant: 'outline',
        confirm: active.kind === 'emulator' ? `Shut down ${active.avdName ?? active.serial}?` : undefined,
      });
    }
    rows.push({
      kind: 'line',
      id: 'active-device',
      label: active.avdName ?? active.model ?? active.label,
      dot,
      value: active.apiLevel ? `${active.state} · API ${active.apiLevel}` : active.state,
      ...(actions.length > 0 ? { actions } : {}),
    });
  } else {
    rows.push({
      kind: 'note',
      id: 'no-device',
      tone: 'muted',
      text: state.devices.length === 0
        ? 'No AVDs or ADB devices found.'
        : 'Pick a device in the Android Simulator panel.',
    });
  }

  if (active?.state === 'booted') {
    rows.push({
      kind: 'line',
      id: 'stream',
      label: 'Stream',
      dot: state.stream.running ? (state.agentActive ? 'info' : 'success') : 'muted',
      value: state.stream.running
        ? `${state.stream.mode} · ${state.stream.width}x${state.stream.height} · ${state.stream.fps} fps`
        : 'idle',
      ...(state.agentActive
        ? { badge: { label: 'Agent active', tone: 'info' } }
        : {}),
    });
  }

  if (state.stream.error) {
    rows.push({
      kind: 'note',
      id: 'stream-error',
      tone: 'warning',
      text: state.stream.error.slice(0, 280),
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
