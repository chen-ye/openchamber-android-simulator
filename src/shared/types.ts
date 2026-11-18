export type DeviceKind = 'avd' | 'emulator' | 'device';
export type DeviceState = 'booted' | 'booting' | 'off' | 'unauthorized' | 'offline';
export type QualityPreset = 'full' | 'balanced' | 'fast';
export type AppearanceMode = 'light' | 'dark';
export type RotationDegrees = 0 | 90 | 180 | 270;

export interface AndroidDevice {
  readonly id: string;
  readonly serial: string | null;
  readonly avdName: string | null;
  readonly label: string;
  readonly kind: DeviceKind;
  readonly state: DeviceState;
  readonly model: string | null;
  readonly apiLevel: string | null;
  readonly transport: 'avd' | 'local' | 'usb' | 'tcp';
  readonly screenWidth: number | null;
  readonly screenHeight: number | null;
}

export interface StreamStatus {
  readonly running: boolean;
  readonly mode: 'scrcpy' | 'screencap' | 'off';
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly error: string | null;
}

export interface ToolAvailability {
  readonly adb: boolean;
  readonly emulator: boolean;
  readonly scrcpyServer: boolean;
  readonly ffmpeg: boolean;
}

export interface SimulatorState {
  readonly devices: readonly AndroidDevice[];
  readonly selectedId: string | null;
  readonly active: AndroidDevice | null;
  readonly stream: StreamStatus;
  readonly quality: QualityPreset;
  readonly framed: boolean;
  readonly appearance: AppearanceMode | null;
  readonly rotation: RotationDegrees;
  readonly agentActive: boolean;
  readonly toolsAvailable: ToolAvailability;
  readonly lastAction: { readonly message: string; readonly at: number } | null;
}

export interface BlobRef {
  readonly id: string;
  readonly length: number;
}

export interface PageFrame {
  readonly seq: number;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly rotation: RotationDegrees;
  readonly data: BlobRef;
}

export const BLOB_CHUNK = 240_000;

export function qualityMaxSize(quality: QualityPreset): number {
  switch (quality) {
    case 'full':
      return 0;
    case 'balanced':
      return 1080;
    case 'fast':
      return 720;
  }
}

export function qualityDivisor(quality: QualityPreset): number {
  switch (quality) {
    case 'full':
      return 1;
    case 'balanced':
      return 2;
    case 'fast':
      return 3;
  }
}

export interface UiNode {
  readonly index: number;
  readonly depth: number;
  readonly parentIndex: number | null;
  readonly text: string;
  readonly contentDesc: string;
  readonly resourceId: string;
  readonly className: string;
  readonly packageName: string;
  readonly bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly center: { readonly x: number; readonly y: number };
  readonly clickable: boolean;
  readonly longClickable: boolean;
  readonly scrollable: boolean;
  readonly editable: boolean;
  readonly checkable: boolean;
  readonly checked: boolean;
  readonly selected: boolean;
  readonly password: boolean;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly hidden: boolean;
  readonly offScreen: boolean;
  readonly children?: readonly UiNode[];
}
