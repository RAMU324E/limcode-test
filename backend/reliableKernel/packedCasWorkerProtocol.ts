import type { CasObjectIdentity } from './casObjectAccess';
import type { RootBinding } from './contracts';
import type { HistoricalRootBinding } from './rootAuthority';

export const PACKED_CAS_FILE = 'limcode.cas-small.sqlite';
export const PACKED_CAS_MAX_BODY_BYTES = 8_192;
/** Includes an allowance for every identity, so empty bodies cannot make an unbounded batch. */
export const PACKED_CAS_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
export const PACKED_CAS_MAX_QUEUED_REQUESTS = 128;
export const PACKED_CAS_ENTRY_CHARGE = 256;

export interface PackedCasOpenOptions { readOnly?: boolean }
export interface PackedCasWorkerData { binding: HistoricalRootBinding; options: PackedCasOpenOptions }
export interface PackedCasIdentity { dataSetId: string; rootInstanceId: string; rootGeneration: number }
/** Offline epoch maintenance and its read-only startup probe never publish body rows. */
export type PackedCasMaintenanceWorkerData =
  | { kind: 'inspectIdentity'; binding: HistoricalRootBinding }
  | { kind: 'migrateEpochIdentity'; previous: HistoricalRootBinding; next: RootBinding; allowPrevious: boolean };
export type PackedCasMaintenanceWorkerResponse =
  | { ok: true; identity?: PackedCasIdentity }
  | { ok: false; error: PackedCasWorkerError };
export interface PackedCasPublication { object: CasObjectIdentity; bytes: Uint8Array }
export type PackedCasPlacement = 'packed' | 'loose';

export type PackedCasOperation =
  | { kind: 'readBytes'; object: CasObjectIdentity }
  | { kind: 'inspectByteLength'; object: CasObjectIdentity }
  | { kind: 'publishBatch'; entries: PackedCasPublication[] }
  | { kind: 'snapshot'; destination: string }
  | { kind: 'close' };
export type PackedCasWorkerRequest = PackedCasOperation & { id: number };

export interface PackedCasWorkerError { name: string; message: string; code?: string }
export type PackedCasWorkerResponse =
  | { type: 'ready' }
  | { type: 'fatal'; error: PackedCasWorkerError }
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: PackedCasWorkerError };

export function packedCasRequestCharge(operation: PackedCasOperation): number {
  return operation.kind === 'publishBatch'
    ? operation.entries.reduce((total, entry) => total + entry.bytes.byteLength + PACKED_CAS_ENTRY_CHARGE, 0)
    : PACKED_CAS_ENTRY_CHARGE + (operation.kind === 'readBytes' ? PACKED_CAS_MAX_BODY_BYTES : 0);
}
