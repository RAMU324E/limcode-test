import * as fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { parentPort, threadId, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { RuntimeAllocatedSequence, RuntimeChange, RuntimeCommitResult, SnapshotBarrier } from './contracts';
import {
  assertCurrentSchema,
  assertDatabaseBinding,
  configureReaderConnection,
  configureWriterConnection,
  initializeCurrentSchema,
  inspectDatabaseFoundation
} from './databaseSchema';
import type {
  DatabaseWorkerData,
  DatabaseWorkerDiagnostics,
  DatabaseWorkerRequest,
  DatabaseWorkerResponse,
  SerializedWorkerError
} from './databaseWorkerProtocol';
import {
  DOMAIN_REPOSITORIES,
  type DomainRepository,
  type DomainRow,
  type EncodedRow,
  type RepositoryInsertMutation,
  type RepositoryMutation,
  type RepositoryRead,
  type RepositoryTransactionStep
} from './repositories';

const port = requireParentPort();
const data = workerData as DatabaseWorkerData;

void start().catch((error) => {
  post({ type: 'fatal', error: serializeError(error) });
  process.exitCode = 1;
});

async function start(): Promise<void> {
  if (data.mode === 'initialize') {
    await mkdir(data.binding.paths.casRootPath, { recursive: false });
    const database = new Database(data.binding.paths.databasePath, { fileMustExist: false });
    try {
      configureWriterConnection(database);
      initializeCurrentSchema(database, data.binding);
    } finally {
      database.close();
    }
    post({ type: 'ready', workerThreadId: threadId, mode: data.mode });
    port.close();
    return;
  }

  const writer = new Database(data.binding.paths.databasePath, { fileMustExist: true });
  configureWriterConnection(writer);
  assertCurrentSchema(writer, data.binding);
  configureTransactionChangeCapture(writer);
  const reader = new Database(data.binding.paths.databasePath, { readonly: true, fileMustExist: true });
  configureReaderConnection(reader);
  assertCurrentSchema(reader, data.binding);
  let commitSeq = 0n;
  let closed = false;

  post({ type: 'ready', workerThreadId: threadId, mode: data.mode });
  port.on('message', (request: DatabaseWorkerRequest) => {
    if (closed) return;
    try {
      if (request.kind === 'transaction') {
        assertDatabaseBinding(writer, data.binding);
        const result = executeTransaction(writer, request.steps, commitSeq + 1n);
        commitSeq += 1n;
        post({ type: 'commit', result });
        post({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'snapshot') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeSnapshot(reader, request.reads, commitSeq);
        post({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'inspect') {
        assertDatabaseBinding(writer, data.binding);
        const result: DatabaseWorkerDiagnostics = {
          ...inspectDatabaseFoundation(writer),
          workerThreadId: threadId,
          hostBootId: data.hostBootId,
          writerConnectionCount: 1,
          readerConnectionCount: 1,
          readerJournalMode: String(reader.pragma('journal_mode', { simple: true })),
          readerForeignKeys: BigInt(reader.pragma('foreign_keys', { simple: true }) as number | bigint),
          readerBusyTimeoutMs: BigInt(reader.pragma('busy_timeout', { simple: true }) as number | bigint),
          currentCommitSeq: commitSeq.toString()
        };
        post({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      assertDatabaseBinding(writer, data.binding);
      closed = true;
      reader.close();
      writer.close();
      post({ type: 'response', id: request.id, ok: true, result: null });
      port.close();
    } catch (error) {
      post({ type: 'response', id: request.id, ok: false, error: serializeError(error) });
    }
  });
}

function configureTransactionChangeCapture(database: Database.Database): void {
  database.exec(`
    CREATE TEMP TABLE runtime_transaction_change (
      sequence INTEGER PRIMARY KEY,
      domain TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('upsert', 'remove'))
    )
  `);
  for (const schema of DOMAIN_REPOSITORIES.all().map((repository) => repository.schema)) {
    if (schema.client === 'none') continue;
    const domain = sqlText(schema.key);
    for (const operation of ['insert', 'update', 'delete'] as const) {
      const row = operation === 'delete' ? 'OLD' : 'NEW';
      const kind = operation === 'delete' ? 'remove' : 'upsert';
      database.exec(`
        CREATE TEMP TRIGGER ${quote(`capture_${schema.table}_${operation}`)}
        AFTER ${operation.toUpperCase()} ON ${quote(schema.table)}
        BEGIN
          INSERT INTO runtime_transaction_change (domain, id, kind)
          VALUES (${domain}, ${row}.id, '${kind}');
        END
      `);
    }
  }
}

function readTransactionChanges(database: Database.Database): RuntimeChange[] {
  const rows = database.prepare(`
    SELECT current.domain, current.id, current.kind
      FROM runtime_transaction_change AS current
      JOIN (
        SELECT domain, id, MAX(sequence) AS sequence
          FROM runtime_transaction_change
         GROUP BY domain, id
      ) AS latest
        ON latest.sequence = current.sequence
     ORDER BY current.sequence
  `).all() as Array<{ domain: string; id: string; kind: 'upsert' | 'remove' }>;
  return rows.map((row) => ({ domain: row.domain, id: row.id, kind: row.kind }));
}

function executeTransaction(
  database: Database.Database,
  steps: RepositoryTransactionStep[],
  nextCommitSeq: bigint
): RuntimeCommitResult {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('Runtime transaction requires at least one Repository step.');
  const allocatedSequences: RuntimeAllocatedSequence[] = [];
  let changes: RuntimeChange[] = [];
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM temp.runtime_transaction_change');
    executeSteps(database, steps, allocatedSequences);
    changes = readTransactionChanges(database);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { commitSeq: nextCommitSeq.toString(), changes, allocatedSequences };
}

function executeSteps(
  database: Database.Database,
  steps: RepositoryTransactionStep[],
  allocatedSequences: RuntimeAllocatedSequence[]
): void {
  for (const step of steps) {
    if (step.kind !== 'savepoint') {
      executeMutation(database, step, allocatedSequences);
      continue;
    }
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(step.name)) throw new Error(`Invalid savepoint name: ${step.name}`);
    const marker = quote(step.name);
    const sequenceCount = allocatedSequences.length;
    database.exec(`SAVEPOINT ${marker}`);
    try {
      executeSteps(database, step.steps, allocatedSequences);
      database.exec(`RELEASE SAVEPOINT ${marker}`);
    } catch (error) {
      database.exec(`ROLLBACK TO SAVEPOINT ${marker}`);
      database.exec(`RELEASE SAVEPOINT ${marker}`);
      allocatedSequences.length = sequenceCount;
      if (step.onError === 'propagate') throw error;
    }
  }
}

function executeMutation(
  database: Database.Database,
  mutation: RepositoryMutation,
  allocatedSequences: RuntimeAllocatedSequence[]
): void {
  const repository = DOMAIN_REPOSITORIES.domain(mutation.domain);
  const schema = repository.schema;
  if (!schema.mutations.includes(mutation.kind)) {
    throw new Error(`${schema.repository} does not allow ${mutation.kind}.`);
  }

  if (mutation.kind === 'insert') {
    const row = mutation.allocateSequence
      ? allocateNextSequence(database, repository, mutation)
      : mutation.row;
    const encoded = repository.codec.encodeInsert(row);
    const id = requireEncodedId(encoded.id, schema.codec);
    if (mutation.allocateSequence) {
      const value = encoded[mutation.allocateSequence.column];
      if (typeof value !== 'bigint') throw new Error('Allocated sequence was not encoded as SQLite INTEGER.');
      allocatedSequences.push({
        domain: schema.key,
        id,
        column: mutation.allocateSequence.column,
        value: value.toString()
      });
    }
    if (schema.key === 'ContentObject') assertPublishedContentObject(encoded, data.binding.paths.casRootPath);
    const names = Object.keys(encoded);
    const sql = `INSERT INTO ${quote(schema.table)} (${names.map(quote).join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`;
    database.prepare(sql).run(encoded);
  } else if (mutation.kind === 'update') {
    const id = requireRuntimeId(mutation.id);
    const encoded = repository.codec.encodePatch(mutation.patch);
    const assignments = Object.keys(encoded).map((name) => `${quote(name)} = @${name}`);
    const result = database.prepare(`UPDATE ${quote(schema.table)} SET ${assignments.join(', ')} WHERE id = @__id`)
      .run({ ...encoded, __id: id });
    if (result.changes !== 1) throw new Error(`${schema.repository} update expected one row: ${id}`);
  } else {
    const id = requireRuntimeId(mutation.id);
    const result = database.prepare(`DELETE FROM ${quote(schema.table)} WHERE id = ?`).run(id);
    if (result.changes !== 1) throw new Error(`${schema.repository} delete expected one row: ${id}`);
  }
}

function allocateNextSequence(
  database: Database.Database,
  repository: DomainRepository,
  mutation: RepositoryInsertMutation
): DomainRow {
  const allocation = mutation.allocateSequence;
  if (!allocation) return mutation.row;
  const column = repository.codec.column(allocation.column);
  if (!column || column.type !== 'INTEGER' || !allocation.column.endsWith('_seq')) {
    throw new Error(`${repository.name}.${allocation.column} is not an allocatable sequence.`);
  }
  if (allocation.column in mutation.row) throw new Error(`${repository.name}.${allocation.column} was supplied and allocated.`);
  const scope = repository.codec.encodeWhere(allocation.scope);
  const encodedRowScope = repository.codec.encodeWhere(
    Object.fromEntries(Object.keys(scope).map((name) => [name, mutation.row[name]]))
  );
  for (const name of Object.keys(scope)) {
    if (scope[name] !== encodedRowScope[name]) {
      throw new Error(`${repository.name} sequence scope does not match the inserted row: ${name}`);
    }
  }
  const predicates: string[] = [];
  const parameters: EncodedRow = {};
  for (const [name, value] of Object.entries(scope)) {
    if (value === null) predicates.push(`${quote(name)} IS NULL`);
    else {
      predicates.push(`${quote(name)} = @${name}`);
      parameters[name] = value;
    }
  }
  const sql = `SELECT COALESCE(MAX(${quote(allocation.column)}), 0) + 1 AS next_value FROM ${quote(repository.schema.table)}${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''}`;
  const result = database.prepare(sql).get(parameters) as { next_value: bigint };
  if (typeof result.next_value !== 'bigint' || result.next_value <= 0n) throw new Error('SQLite sequence allocation failed.');
  return { ...mutation.row, [allocation.column]: result.next_value };
}

function executeSnapshot(
  database: Database.Database,
  reads: RepositoryRead[],
  commitSeq: bigint
): SnapshotBarrier<Array<DomainRow | DomainRow[] | null>> {
  if (!Array.isArray(reads)) throw new TypeError('Snapshot reads must be an array.');
  database.exec('BEGIN');
  try {
    const snapshot = reads.map((read) => executeRead(database, read));
    database.exec('COMMIT');
    return { snapshotCommitSeq: commitSeq.toString(), snapshot };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function executeRead(database: Database.Database, read: RepositoryRead): DomainRow | DomainRow[] | null {
  const repository = DOMAIN_REPOSITORIES.domain(read.domain);
  const schema = repository.schema;
  if (read.kind === 'get') {
    const row = database.prepare(`SELECT * FROM ${quote(schema.table)} WHERE id = ?`).get(requireRuntimeId(read.id));
    return row ? repository.codec.decode(row as Record<string, unknown>) : null;
  }
  if (!Number.isSafeInteger(read.limit) || read.limit <= 0 || read.limit > 1000) {
    throw new RangeError('Repository list limit must be an integer from 1 to 1000.');
  }
  const encodedWhere = repository.codec.encodeWhere(read.where ?? {});
  const predicates: string[] = [];
  const parameters: EncodedRow & { __limit?: bigint } = {};
  for (const [name, value] of Object.entries(encodedWhere)) {
    if (value === null) predicates.push(`${quote(name)} IS NULL`);
    else {
      predicates.push(`${quote(name)} = @${name}`);
      parameters[name] = value;
    }
  }
  const orderColumn = read.orderBy?.column ?? 'id';
  if (!repository.codec.hasColumn(orderColumn)) throw new Error(`${schema.repository} cannot order by ${orderColumn}.`);
  const direction = read.orderBy?.direction === 'desc' ? 'DESC' : 'ASC';
  parameters.__limit = BigInt(read.limit);
  const sql = `SELECT * FROM ${quote(schema.table)}${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY ${quote(orderColumn)} ${direction} LIMIT @__limit`;
  return (database.prepare(sql).all(parameters) as Array<Record<string, unknown>>).map((row) => repository.codec.decode(row));
}

function assertPublishedContentObject(row: EncodedRow, casRootPath: string): void {
  const digest = row.sha256;
  const storageKey = row.storage_key;
  const byteLength = row.byte_length;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('ContentObject.sha256 must be lowercase SHA-256.');
  const expectedKey = `sha256/${digest.slice(0, 2)}/${digest}`;
  if (storageKey !== expectedKey) throw new Error('ContentObject.storage_key does not match its digest.');
  if (typeof byteLength !== 'bigint' || byteLength < 0n) throw new Error('ContentObject.byte_length must be non-negative.');
  const absolutePath = path.resolve(casRootPath, ...expectedKey.split('/'));
  if (!absolutePath.startsWith(`${path.resolve(casRootPath)}${path.sep}`)) throw new Error('ContentObject CAS path escapes the active root.');
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || BigInt(stat.size) !== byteLength) throw new Error('ContentObject CAS file is missing or has the wrong length.');
}

function post(message: DatabaseWorkerResponse): void {
  port.postMessage(message);
}

function requireParentPort(): NonNullable<typeof parentPort> {
  if (!parentPort) throw new Error('SQLite database worker requires parentPort.');
  return parentPort;
}

function serializeError(error: unknown): SerializedWorkerError {
  const value = error as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
  return {
    name: typeof value?.name === 'string' ? value.name : 'Error',
    message: typeof value?.message === 'string' ? value.message : String(error),
    ...(typeof value?.stack === 'string' ? { stack: value.stack } : {}),
    ...(typeof value?.code === 'string' ? { code: value.code } : {})
  };
}

function requireEncodedId(value: EncodedRow[string], codecName: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${codecName}.id must be a non-empty string.`);
  return value;
}

function requireRuntimeId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Runtime row id must be a non-empty string.');
  return value;
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quote(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQLite identifier: ${identifier}`);
  return `"${identifier}"`;
}
