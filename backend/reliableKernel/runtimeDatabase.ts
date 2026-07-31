import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  ROOT_BINDING_POINTER_FILE,
  type RootBinding,
  type RuntimeCommitResult,
  type SnapshotBarrier
} from './contracts';
import type {
  DatabaseWorkerData,
  DatabaseWorkerDiagnostics,
  DatabaseWorkerRequest,
  DatabaseWorkerRequestPayload,
  DatabaseWorkerResponse,
  SerializedWorkerError
} from './databaseWorkerProtocol';
import type { DomainRow, RepositoryRead, RepositoryTransactionStep } from './repositories';
import { RootAuthority } from './rootAuthority';

export interface SnapshotSubscription<T> {
  barrier: SnapshotBarrier<T>;
  unsubscribe(): void;
}

export class RuntimeDatabaseWorkerError extends Error {
  public constructor(error: SerializedWorkerError) {
    super(error.message);
    this.name = error.name || 'RuntimeDatabaseWorkerError';
    if (error.stack) this.stack = error.stack;
    if (error.code) (this as Error & { code?: string }).code = error.code;
  }
}

const OPEN_ROOT_POINTERS = new Set<string>();

export class RuntimeDatabase {
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }>();
  private readonly commitListeners = new Set<(result: RuntimeCommitResult) => void>();
  private nextRequestId = 1;
  private closed = false;

  private constructor(
    private readonly authority: RootAuthority,
    public readonly binding: RootBinding,
    public readonly hostBootId: string,
    private readonly worker: Worker,
    public readonly workerThreadId: number,
    private readonly registryKey: string
  ) {
    worker.on('message', (message: DatabaseWorkerResponse) => this.onMessage(message));
    worker.on('error', (error) => this.failPending(error));
    worker.on('exit', (code) => {
      OPEN_ROOT_POINTERS.delete(this.registryKey);
      if (!this.closed && code !== 0) this.failPending(new Error(`SQLite database worker exited with code ${code}.`));
    });
  }

  public static async open(
    authority: RootAuthority,
    options: { hostBootId?: string } = {}
  ): Promise<RuntimeDatabase> {
    const binding = await authority.current();
    const hostBootId = options.hostBootId ?? randomUUID();
    const registryKey = binding.paths.rootPointerPath;
    if (OPEN_ROOT_POINTERS.has(registryKey)) {
      throw new Error(`A Runtime database worker is already open for ${registryKey}.`);
    }
    OPEN_ROOT_POINTERS.add(registryKey);
    const worker = createWorker({ mode: 'runtime', binding, hostBootId });
    try {
      const ready = await waitForReady(worker, 'runtime');
      return new RuntimeDatabase(authority, binding, hostBootId, worker, ready.workerThreadId, registryKey);
    } catch (error) {
      OPEN_ROOT_POINTERS.delete(registryKey);
      await worker.terminate();
      throw error;
    }
  }

  public async transaction(steps: RepositoryTransactionStep[]): Promise<RuntimeCommitResult> {
    return this.request<RuntimeCommitResult>({ kind: 'transaction', steps });
  }

  public async snapshot(
    reads: RepositoryRead[]
  ): Promise<SnapshotBarrier<Array<DomainRow | DomainRow[] | null>>> {
    return this.request<SnapshotBarrier<Array<DomainRow | DomainRow[] | null>>>({ kind: 'snapshot', reads });
  }

  /**
   * Registers before requesting the writer barrier, buffers concurrent commits, discards those
   * already visible in the snapshot, then switches to live delivery without a gap.
   */
  public async snapshotAndSubscribe(
    reads: RepositoryRead[],
    onCommit: (result: RuntimeCommitResult) => void
  ): Promise<SnapshotSubscription<Array<DomainRow | DomainRow[] | null>>> {
    const buffered: RuntimeCommitResult[] = [];
    let live = false;
    const listener = (result: RuntimeCommitResult) => {
      if (live) onCommit(result);
      else buffered.push(result);
    };
    this.commitListeners.add(listener);
    try {
      const barrier = await this.snapshot(reads);
      const visible = BigInt(barrier.snapshotCommitSeq);
      for (const result of buffered) {
        if (BigInt(result.commitSeq) > visible) onCommit(result);
      }
      live = true;
      return {
        barrier,
        unsubscribe: () => this.commitListeners.delete(listener)
      };
    } catch (error) {
      this.commitListeners.delete(listener);
      throw error;
    }
  }

  public onCommit(listener: (result: RuntimeCommitResult) => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  public async inspect(): Promise<DatabaseWorkerDiagnostics> {
    return this.request<DatabaseWorkerDiagnostics>({ kind: 'inspect' });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.sendRequest<null>({ kind: 'close' });
    } finally {
      this.closed = true;
      OPEN_ROOT_POINTERS.delete(this.registryKey);
      this.commitListeners.clear();
      await this.worker.terminate();
    }
  }

  private async request<T>(request: DatabaseWorkerRequestPayload): Promise<T> {
    if (this.closed) throw new Error('RuntimeDatabase is closed.');
    await this.authority.validate(this.binding);
    return this.sendRequest<T>(request);
  }

  private sendRequest<T>(request: DatabaseWorkerRequestPayload): Promise<T> {
    if (this.closed) return Promise.reject(new Error('RuntimeDatabase is closed.'));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
      this.worker.postMessage({ ...request, id } as DatabaseWorkerRequest);
    });
  }

  private onMessage(message: DatabaseWorkerResponse): void {
    if (message.type === 'commit') {
      for (const listener of this.commitListeners) listener(message.result);
      return;
    }
    if (message.type === 'fatal') {
      this.failPending(new RuntimeDatabaseWorkerError(message.error));
      return;
    }
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new RuntimeDatabaseWorkerError(message.error));
  }

  private failPending(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export async function initializeEmptyRuntimeRoot(authority: RootAuthority): Promise<RootBinding> {
  return authority.initializeEmptyRoot(initializeBindingStorage);
}

export async function resetCandidateRuntimeRoot(candidateParentPath: string): Promise<{
  authority: RootAuthority;
  binding: RootBinding;
}> {
  const pointerPath = path.join(path.resolve(candidateParentPath), ROOT_BINDING_POINTER_FILE);
  if (OPEN_ROOT_POINTERS.has(pointerPath)) {
    throw new Error('Candidate root reset requires the current Runtime database worker to be closed first.');
  }
  return RootAuthority.resetCandidateRoot(candidateParentPath, initializeBindingStorage);
}

async function initializeBindingStorage(binding: RootBinding): Promise<void> {
  const worker = createWorker({ mode: 'initialize', binding, hostBootId: randomUUID() });
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    worker.on('message', (message: DatabaseWorkerResponse) => {
      if (message.type === 'fatal') reject(new RuntimeDatabaseWorkerError(message.error));
      else if (message.type === 'ready') ready = message.mode === 'initialize';
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0 && ready) resolve();
      else reject(new Error(`SQLite initialization worker exited with code ${code}${ready ? '' : ' before ready'}.`));
    });
  });
}

function createWorker(data: DatabaseWorkerData): Worker {
  return new Worker(path.join(__dirname, 'databaseWorker.js'), { workerData: data });
}

function waitForReady(
  worker: Worker,
  expectedMode: DatabaseWorkerData['mode']
): Promise<{ workerThreadId: number }> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: DatabaseWorkerResponse) => {
      if (message.type === 'fatal') {
        cleanup();
        reject(new RuntimeDatabaseWorkerError(message.error));
      } else if (message.type === 'ready') {
        cleanup();
        if (message.mode !== expectedMode) reject(new Error(`Unexpected database worker mode: ${message.mode}`));
        else resolve({ workerThreadId: message.workerThreadId });
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      if (code === 0) return;
      cleanup();
      reject(new Error(`SQLite database worker exited before ready with code ${code}.`));
    };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}
