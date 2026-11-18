import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVICE_DISCOVERY_FILENAME, type ServiceDiscoveryRecord } from '../shared/protocol.ts';

export function discoveryFilePath(): string {
  return path.join(os.tmpdir(), SERVICE_DISCOVERY_FILENAME);
}

export function writeServiceDiscovery(record: ServiceDiscoveryRecord): void {
  const file = discoveryFilePath();
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // ignore chmod failure on restricted fs
  }
}

export function readServiceDiscovery(): ServiceDiscoveryRecord | null {
  const file = discoveryFilePath();
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ServiceDiscoveryRecord>;
    if (
      typeof raw.port === 'number' &&
      raw.port > 0 &&
      typeof raw.token === 'string' &&
      raw.token.length > 0 &&
      typeof raw.pid === 'number'
    ) {
      return raw as ServiceDiscoveryRecord;
    }
  } catch {
    // ignore corrupt discovery file
  }
  return null;
}

export function clearServiceDiscovery(pid: number): void {
  const current = readServiceDiscovery();
  if (current && current.pid !== pid) return;
  try {
    unlinkSync(discoveryFilePath());
  } catch {
    // ignore missing file
  }
}
