import type { BlobRef } from './types.ts';

export const SERVICE_DISCOVERY_FILENAME = 'openchamber-android-simulator-service.json';

export interface ServiceDiscoveryRecord {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: number;
}

export interface AgentToolRequest {
  readonly tool: 'android_device' | 'android_input' | 'android_inspect';
  readonly input: Record<string, unknown>;
}

export interface AgentToolResponse {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export function blobUrl(ref: BlobRef, offset: number): string {
  return `/blob?id=${encodeURIComponent(ref.id)}&offset=${offset}`;
}
