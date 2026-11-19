import { describe, expect, test } from 'bun:test';
import { GUEST_STATUS_CONTROL_ID } from '@openchamber/sdk';
import { guestStatusViewSchema } from '@openchamber/sdk/schemas';
import { buildStatusView, resolveStatusAction, statusActionId } from '../src/service/status.ts';
import type { AndroidDevice, SimulatorState } from '../src/shared/types.ts';

function makeState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    devices: [],
    selectedId: null,
    active: null,
    stream: {
      running: false,
      mode: 'off',
      width: 0,
      height: 0,
      fps: 0,
      error: null,
    },
    quality: 'balanced',
    framed: true,
    appearance: 'light',
    rotation: 0,
    agentActive: false,
    toolsAvailable: {
      adb: true,
      emulator: true,
      scrcpyServer: true,
      ffmpeg: true,
    },
    lastAction: null,
    ...overrides,
  };
}

describe('Work Status view (guestStatusViewSchema compliance)', () => {
  test('generates valid control IDs and resolves actions across serials and AVD names', () => {
    const devices: AndroidDevice[] = [
      {
        id: 'emulator-5554',
        serial: 'emulator-5554',
        avdName: 'openchamber_api35',
        label: 'openchamber_api35 (emulator-5554)',
        kind: 'emulator',
        state: 'booted',
        model: 'Pixel 8',
        apiLevel: '35',
        transport: 'local',
        screenWidth: 1080,
        screenHeight: 2400,
      },
      {
        id: '100.64.0.42:5555',
        serial: '100.64.0.42:5555',
        avdName: null,
        label: 'Redroid (100.64.0.42:5555)',
        kind: 'device',
        state: 'booted',
        model: 'Redroid',
        apiLevel: '34',
        transport: 'tcp',
        screenWidth: 720,
        screenHeight: 1280,
      },
      {
        id: 'avd:Pixel_9_Pro_XL_API_35_With_Extra_Long_Suffix_Name_2026',
        serial: null,
        avdName: 'Pixel_9_Pro_XL_API_35_With_Extra_Long_Suffix_Name_2026',
        label: 'Pixel_9_Pro_XL_API_35_With_Extra_Long_Suffix_Name_2026',
        kind: 'avd',
        state: 'off',
        model: 'pixel_9_pro_xl',
        apiLevel: '35',
        transport: 'avd',
        screenWidth: 1344,
        screenHeight: 2992,
      },
      {
        id: 'avd:pixel-9-pro-xl-api-35-with-extra-long-suffix-name-2026',
        serial: null,
        avdName: 'pixel-9-pro-xl-api-35-with-extra-long-suffix-name-2026',
        label: 'pixel-9-pro-xl-api-35-with-extra-long-suffix-name-2026',
        kind: 'avd',
        state: 'off',
        model: 'pixel_9_pro_xl',
        apiLevel: '35',
        transport: 'avd',
        screenWidth: 1344,
        screenHeight: 2992,
      },
    ];

    const emuShutdownId = statusActionId('shutdown', 'emulator-5554');
    const tcpShutdownId = statusActionId('shutdown', '100.64.0.42:5555');
    const avdBootA = statusActionId(
      'boot',
      'Pixel_9_Pro_XL_API_35_With_Extra_Long_Suffix_Name_2026',
    );
    const avdBootB = statusActionId(
      'boot',
      'pixel-9-pro-xl-api-35-with-extra-long-suffix-name-2026',
    );
    const symbolOnlyId = statusActionId('shutdown', '[::1]:5555');

    for (const id of [emuShutdownId, tcpShutdownId, avdBootA, avdBootB, symbolOnlyId]) {
      expect(id).toMatch(GUEST_STATUS_CONTROL_ID);
    }
    expect(avdBootA).not.toBe(avdBootB);

    expect(resolveStatusAction(emuShutdownId, devices)).toEqual({
      kind: 'shutdown',
      serial: 'emulator-5554',
    });
    expect(resolveStatusAction(tcpShutdownId, devices)).toEqual({
      kind: 'shutdown',
      serial: '100.64.0.42:5555',
    });
    expect(resolveStatusAction(avdBootA, devices)).toEqual({
      kind: 'boot',
      avdName: 'Pixel_9_Pro_XL_API_35_With_Extra_Long_Suffix_Name_2026',
    });
    expect(resolveStatusAction(avdBootB, devices)).toEqual({
      kind: 'boot',
      avdName: 'pixel-9-pro-xl-api-35-with-extra-long-suffix-name-2026',
    });
    expect(resolveStatusAction('shutdown-missing-000000', devices)).toBeNull();
  });

  test('passes guestStatusViewSchema for booted emulator with active stream and agent badge', () => {
    const active: AndroidDevice = {
      id: 'emulator-5554',
      serial: 'emulator-5554',
      avdName: 'openchamber_api35',
      label: 'openchamber_api35 (emulator-5554)',
      kind: 'emulator',
      state: 'booted',
      model: 'Android SDK built for x86 64',
      apiLevel: '35',
      transport: 'local',
      screenWidth: 320,
      screenHeight: 640,
    };
    const other: AndroidDevice = {
      ...active,
      id: '100.64.0.42:5555',
      serial: '100.64.0.42:5555',
      avdName: null,
      kind: 'device',
      transport: 'tcp',
    };
    const view = buildStatusView(
      makeState({
        devices: [active, other],
        selectedId: active.id,
        active,
        agentActive: true,
        stream: {
          running: true,
          mode: 'scrcpy',
          width: 320,
          height: 640,
          fps: 29.8,
          error: 'A'.repeat(400),
        },
      }),
    );

    const parsed = guestStatusViewSchema.safeParse(JSON.parse(JSON.stringify(view)));
    expect(parsed.success).toBe(true);

    const streamRow = view.rows.find((r) => r.id === 'stream');
    expect(streamRow?.kind).toBe('line');
    if (streamRow?.kind === 'line') {
      expect(streamRow.badge?.label).toBe('Agent\u00A0active');
    }
  });

  test('passes guestStatusViewSchema for offline AVD with underscores and >60 char name, TCP device, and missing adb', () => {
    const longAvdName = `Enterprise_AVD_${'X'.repeat(80)}`;
    const offAvd: AndroidDevice = {
      id: `avd:${longAvdName}`,
      serial: null,
      avdName: longAvdName,
      label: longAvdName,
      kind: 'avd',
      state: 'off',
      model: null,
      apiLevel: '35',
      transport: 'avd',
      screenWidth: 1080,
      screenHeight: 2400,
    };

    const offView = buildStatusView(
      makeState({
        devices: [offAvd],
        selectedId: offAvd.id,
        active: offAvd,
      }),
    );
    expect(guestStatusViewSchema.safeParse(JSON.parse(JSON.stringify(offView))).success).toBe(true);

    const tcpDev: AndroidDevice = {
      id: '10.0.0.8:5555',
      serial: '10.0.0.8:5555',
      avdName: null,
      label: '10.0.0.8:5555',
      kind: 'device',
      state: 'booted',
      model: '',
      apiLevel: null,
      transport: 'tcp',
      screenWidth: null,
      screenHeight: null,
    };
    const tcpView = buildStatusView(
      makeState({
        devices: [tcpDev],
        selectedId: tcpDev.id,
        active: tcpDev,
      }),
    );
    expect(guestStatusViewSchema.safeParse(JSON.parse(JSON.stringify(tcpView))).success).toBe(true);

    const missingAdbView = buildStatusView(
      makeState({
        toolsAvailable: { adb: false, emulator: false, scrcpyServer: false, ffmpeg: false },
      }),
    );
    expect(guestStatusViewSchema.safeParse(JSON.parse(JSON.stringify(missingAdbView))).success).toBe(
      true,
    );
  });
});
