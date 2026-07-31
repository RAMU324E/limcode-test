import type { RootBinding, RuntimeCommitResult, SnapshotBarrier } from './contracts';
import type { DomainRow, RepositoryListRead, RepositoryRead, RepositoryTransactionStep } from './repositories';
import type { DatabaseFoundationInspection } from './databaseSchema';

export interface DatabaseWorkerData {
  mode: 'initialize' | 'runtime';
  binding: RootBinding;
  hostBootId: string;
}

export type DatabaseWorkerRequestPayload =
  | { kind: 'transaction'; steps: RepositoryTransactionStep[] }
  | { kind: 'snapshot'; reads: RepositoryRead[] }
  | { kind: 'snapshotAll'; read: RepositoryListRead }
  | { kind: 'inspect' }
  | { kind: 'close' };

export type DatabaseWorkerRequest = DatabaseWorkerRequestPayload & { id: number };

export interface DatabaseWorkerDiagnostics extends DatabaseFoundationInspection {
  workerThreadId: number;
  hostBootId: string;
  writerConnectionCount: 1;
  readerConnectionCount: 1;
  readerJournalMode: string;
  readerForeignKeys: bigint;
  readerBusyTimeoutMs: bigint;
  currentCommitSeq: string;
}

export type DatabaseWorkerResponse =
  | { type: 'ready'; workerThreadId: number; mode: DatabaseWorkerData['mode'] }
  | { type: 'response'; id: number; ok: true; result: RuntimeCommitResult | SnapshotBarrier<Array<DomainRow | DomainRow[] | null>> | SnapshotBarrier<DomainRow[]> | DatabaseWorkerDiagnostics | null }
  | { type: 'response'; id: number; ok: false; error: SerializedWorkerError }
  | { type: 'commit'; result: RuntimeCommitResult }
  | { type: 'fatal'; error: SerializedWorkerError };

export interface SerializedWorkerError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}
