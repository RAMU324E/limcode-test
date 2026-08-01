import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { parentPort, threadId, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { RuntimeAllocatedSequence, RuntimeChange, RuntimeCommitResult, SnapshotBarrier } from './contracts';
import type { ContentObjectMetadata } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import {
  assertCurrentSchema,
  assertDatabaseBinding,
  configureReaderConnection,
  configureWriterConnection,
  initializeCurrentSchema,
  inspectDatabaseFoundation
} from './databaseSchema';
import {
  MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT,
  MODEL_STREAM_TERMINAL_TAIL,
  type ContextContentMaterializationSnapshot,
  type ContextMaterializationRecord,
  type ContextMaterializationSnapshot,
  type DatabaseWorkerData,
  type DatabaseWorkerDiagnostics,
  type DatabaseWorkerRequest,
  type DatabaseWorkerResponse,
  type ModelStreamEventCommitInput,
  type ModelStreamEventCommitResult,
  type ModelRequestCancelInput,
  type ModelRequestCancelResult,
  type SerializedWorkerError
} from './databaseWorkerProtocol';
import {
  DOMAIN_REPOSITORIES,
  assertRuntimeDomainUpdatePatch,
  type DomainRepository,
  type DomainRow,
  type EncodedRow,
  type RepositoryCheckpointPruneMutation,
  type RepositoryInsertMutation,
  type RepositoryListRead,
  type RepositoryMutation,
  type RepositoryRead,
  type RepositorySavepointOnError,
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
      if (request.kind === 'snapshotAll') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeSnapshotAll(reader, request.read, commitSeq);
        post({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'contextMaterialization') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeContextMaterialization(reader, request.rootId, commitSeq);
        post({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'contextContentMaterialization') {
        assertDatabaseBinding(reader, data.binding);
        const structure = executeContextMaterialization(reader, request.rootId, commitSeq);
        const attached = attachContextContent(structure, data.binding.paths.casRootPath);
        post({ type: 'response', id: request.id, ok: true, result: attached.result }, attached.transferList);
        return;
      }
      if (request.kind === 'modelStreamEvent') {
        assertDatabaseBinding(writer, data.binding);
        const result = executeModelStreamEvent(writer, request.input, commitSeq + 1n);
        if (result.commit) {
          commitSeq += 1n;
          post({ type: 'commit', result: result.commit });
        }
        post({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'cancelCurrentModelRequest') {
        assertDatabaseBinding(writer, data.binding);
        const result = executeCancelCurrentModelRequest(writer, request.input, commitSeq + 1n);
        if (result.commit) {
          commitSeq += 1n;
          post({ type: 'commit', result: result.commit });
        }
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
    assertTouchedRuntimeAggregates(database, steps);
    changes = readTransactionChanges(database);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { commitSeq: nextCommitSeq.toString(), changes, allocatedSequences };
}


function executeModelStreamEvent(
  database: Database.Database,
  input: ModelStreamEventCommitInput,
  nextCommitSeq: bigint
): ModelStreamEventCommitResult {
  const modelRequestId = requireRuntimeId(input.modelRequestId);
  const checkpointId = requireRuntimeId(input.checkpointId);
  const attemptSeq = requirePositiveInteger(input.attemptSeq, 'ModelStreamEvent.attemptSeq');
  const socketGeneration = requirePositiveInteger(input.socketGeneration, 'ModelStreamEvent.socketGeneration');
  const streamSeq = requirePositiveInteger(input.streamSeq, 'ModelStreamEvent.streamSeq');
  if (!['output_delta', 'output_item_done', 'terminal_summary'].includes(input.checkpointKind)) {
    throw new TypeError(`Unsupported ModelStream checkpoint kind: ${String(input.checkpointKind)}`);
  }
  if (typeof input.now !== 'string' || input.now.length === 0) throw new TypeError('ModelStreamEvent.now must be non-empty.');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM temp.runtime_transaction_change');
    const requestRaw = database.prepare('SELECT * FROM model_request WHERE id = ?').get(modelRequestId);
    if (!requestRaw) throw new Error(`ModelRequest ${modelRequestId} does not exist.`);
    const request = DOMAIN_REPOSITORIES.codec('ModelRequest').decode(requestRaw as Record<string, unknown>);
    const existing = database.prepare(
      'SELECT model_request_id, attempt_seq, socket_generation, stream_seq, checkpoint_kind, content_object_id '
        + 'FROM model_stream_checkpoint WHERE id = ? LIMIT 1'
    ).get(checkpointId) as {
      model_request_id?: unknown;
      attempt_seq?: unknown;
      socket_generation?: unknown;
      stream_seq?: unknown;
      checkpoint_kind?: unknown;
      content_object_id?: unknown;
    } | undefined;
    if (existing) {
      if (
        existing.model_request_id !== modelRequestId
        || existing.attempt_seq !== attemptSeq
        || existing.socket_generation !== socketGeneration
        || existing.stream_seq !== streamSeq
        || existing.checkpoint_kind !== input.checkpointKind
        || existing.content_object_id !== input.contentObject.id
      ) {
        const error = new Error(`ModelStream checkpoint ${checkpointId} conflicts with an existing event identity.`) as Error & {
          code: string;
        };
        error.code = 'MODEL_STREAM_IDEMPOTENCY_CONFLICT';
        throw error;
      }
      database.exec('ROLLBACK');
      return {
        accepted: false,
        checkpointed: false,
        terminal: request.status === 'terminal',
        ignoredReason: 'duplicate'
      };
    }
    const fence = database.prepare(
      'SELECT id FROM model_stream_fence WHERE model_request_id = ? LIMIT 1'
    ).get(modelRequestId);
    const turn = database.prepare('SELECT status FROM turn WHERE id = ?').get(request.turn_id) as { status?: unknown } | undefined;
    if (fence || request.status === 'terminal' || turn?.status !== 'active') {
      database.exec('ROLLBACK');
      return { accepted: false, checkpointed: false, terminal: true, ignoredReason: 'terminal' };
    }
    if (request.status !== 'streaming') throw new Error(`ModelRequest ${modelRequestId} is not streaming.`);
    const identity = decodeModelStreamIdentity(request.stream_stats_json);
    if (identity.attemptSeq !== attemptSeq) {
      database.exec('ROLLBACK');
      return { accepted: false, checkpointed: false, terminal: false, ignoredReason: 'old-attempt' };
    }
    if (identity.socketGeneration !== socketGeneration) {
      database.exec('ROLLBACK');
      return { accepted: false, checkpointed: false, terminal: false, ignoredReason: 'old-socket-generation' };
    }
    const checkpointCountRow = database.prepare(
      'SELECT COUNT(*) AS count FROM model_stream_checkpoint WHERE model_request_id = ?'
    ).get(modelRequestId) as { count: bigint };
    if (typeof checkpointCountRow.count !== 'bigint') throw new Error('ModelStream checkpoint count was not an INTEGER.');
    if (
      input.checkpointKind !== 'terminal_summary'
      && checkpointCountRow.count >= BigInt(MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT)
    ) {
      database.exec('ROLLBACK');
      return {
        accepted: true,
        checkpointed: false,
        terminal: false,
        ignoredReason: 'checkpoint-capacity'
      };
    }
    const contentId = requireRuntimeId(input.contentObject.id);
    assertPreparedContentInsert(input.contentObject, input.contentInsert);
    const contentSteps: RepositoryTransactionStep[] = preparedContentObjectSteps([{
      metadata: input.contentObject as ContentObjectMetadata,
      ...(input.contentInsert ? { insert: input.contentInsert } : {})
    }], 'model_stream_content');
    executeSteps(database, contentSteps, []);
    insertStreamFact(database, 'ModelStreamCheckpoint', {
      id: checkpointId,
      model_request_id: modelRequestId,
      attempt_seq: attemptSeq,
      socket_generation: socketGeneration,
      stream_seq: streamSeq,
      checkpoint_kind: input.checkpointKind,
      content_object_id: contentId,
      created_at: input.now
    });
    if (input.checkpointKind === 'terminal_summary') {
      const terminalFenceId = requireRuntimeId(input.terminalFenceId);
      if (!input.terminalStats || typeof input.terminalStats !== 'object' || Array.isArray(input.terminalStats)) {
        throw new TypeError('Completed ModelStream event requires terminalStats.');
      }
      const terminalIdentity = decodeModelStreamIdentity(input.terminalStats);
      if (terminalIdentity.attemptSeq !== attemptSeq || terminalIdentity.socketGeneration !== socketGeneration) {
        throw new Error('Completed ModelStream terminalStats do not match the active stream identity.');
      }
      const operation = database.prepare(
        "SELECT id FROM operation WHERE owner_kind = 'model_request' AND owner_id = ? LIMIT 1"
      ).get(modelRequestId) as { id?: unknown } | undefined;
      if (typeof operation?.id !== 'string') throw new Error(`ModelRequest ${modelRequestId} has no Operation.`);
      const attempt = database.prepare(
        'SELECT id FROM attempt WHERE operation_id = ? AND attempt_seq = ? LIMIT 1'
      ).get(operation.id, attemptSeq) as { id?: unknown } | undefined;
      if (typeof attempt?.id !== 'string') throw new Error(`ModelRequest ${modelRequestId} has no attempt ${attemptSeq}.`);
      insertStreamFact(database, 'ModelStreamFence', {
        id: terminalFenceId,
        model_request_id: modelRequestId,
        attempt_seq: attemptSeq,
        socket_generation: socketGeneration,
        terminal_stream_seq: streamSeq,
        outcome: 'completed',
        created_at: input.now
      });
      executeSteps(database, [
        DOMAIN_REPOSITORIES.domain('Attempt').update(attempt.id, {
          status: 'completed', updated_at: input.now, completed_at: input.now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operation.id, {
          status: 'completed', updated_at: input.now
        }),
        DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
          status: 'terminal',
          terminal_state: 'completed',
          usage_json: input.usage,
          stream_stats_json: input.terminalStats,
          updated_at: input.now
        })
      ], []);
      executeSteps(database, [
        DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').pruneAfterTerminalFence(
          modelRequestId,
          attemptSeq,
          socketGeneration,
          checkpointId
        )
      ], []);
      assertModelRequestAggregate(database, modelRequestId);
    } else {
      if (input.terminalFenceId !== null || input.terminalStats !== null || input.usage !== null) {
        throw new TypeError('Non-terminal ModelStream event cannot carry terminal facts.');
      }
    }
    const changes = readTransactionChanges(database);
    database.exec('COMMIT');
    const commit: RuntimeCommitResult = {
      commitSeq: nextCommitSeq.toString(),
      changes,
      allocatedSequences: []
    };
    return {
      accepted: true,
      checkpointed: true,
      terminal: input.checkpointKind === 'terminal_summary',
      commit
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function executeCancelCurrentModelRequest(
  database: Database.Database,
  input: ModelRequestCancelInput,
  nextCommitSeq: bigint
): ModelRequestCancelResult {
  const modelRequestId = requireRuntimeId(input.modelRequestId);
  if (typeof input.terminalState !== 'string' || input.terminalState.length === 0) {
    throw new TypeError('ModelRequest cancellation terminalState must be non-empty.');
  }
  if (typeof input.now !== 'string' || input.now.length === 0) {
    throw new TypeError('ModelRequest cancellation time must be non-empty.');
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM temp.runtime_transaction_change');
    const requestRaw = database.prepare('SELECT * FROM model_request WHERE id = ?').get(modelRequestId);
    if (!requestRaw) throw new Error(`ModelRequest ${modelRequestId} does not exist.`);
    const request = DOMAIN_REPOSITORIES.codec('ModelRequest').decode(requestRaw as Record<string, unknown>);
    const identity = decodeModelStreamIdentity(request.stream_stats_json);
    if (request.status === 'terminal') {
      database.exec('ROLLBACK');
      return {
        cancelled: false,
        terminalState: typeof request.terminal_state === 'string' ? request.terminal_state : null,
        attemptSeq: identity.attemptSeq.toString(),
        socketGeneration: identity.socketGeneration.toString()
      };
    }
    const fence = database.prepare(
      'SELECT id FROM model_stream_fence WHERE model_request_id = ? LIMIT 1'
    ).get(modelRequestId);
    if (fence) throw new Error(`Active ModelRequest ${modelRequestId} unexpectedly has a terminal fence.`);
    const operation = database.prepare(
      "SELECT id FROM operation WHERE owner_kind = 'model_request' AND owner_id = ? LIMIT 1"
    ).get(modelRequestId) as { id?: unknown } | undefined;
    if (typeof operation?.id !== 'string') throw new Error(`ModelRequest ${modelRequestId} has no Operation.`);
    const attempt = database.prepare(
      'SELECT id FROM attempt WHERE operation_id = ? AND attempt_seq = ? LIMIT 1'
    ).get(operation.id, identity.attemptSeq) as { id?: unknown } | undefined;
    if (typeof attempt?.id !== 'string') {
      throw new Error(`ModelRequest ${modelRequestId} has no current attempt ${identity.attemptSeq}.`);
    }
    executeSteps(database, [
      DOMAIN_REPOSITORIES.domain('Attempt').update(attempt.id, {
        status: 'cancelled', updated_at: input.now, completed_at: input.now
      }),
      DOMAIN_REPOSITORIES.domain('Operation').update(operation.id, {
        status: 'cancelled', updated_at: input.now
      }),
      DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
        status: 'terminal', terminal_state: input.terminalState, updated_at: input.now
      })
    ], []);
    assertModelRequestAggregate(database, modelRequestId);
    const changes = readTransactionChanges(database);
    database.exec('COMMIT');
    const commit: RuntimeCommitResult = {
      commitSeq: nextCommitSeq.toString(),
      changes,
      allocatedSequences: []
    };
    return {
      cancelled: true,
      terminalState: input.terminalState,
      attemptSeq: identity.attemptSeq.toString(),
      socketGeneration: identity.socketGeneration.toString(),
      commit
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function decodeModelStreamIdentity(value: unknown): { attemptSeq: bigint; socketGeneration: bigint } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('ModelRequest.stream_stats_json must be an object.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3
    || keys[0] !== 'attemptSeq'
    || keys[1] !== 'retryReason'
    || keys[2] !== 'socketGeneration'
    || (
      record.retryReason !== null
      && record.retryReason !== 'connection_interrupted'
      && record.retryReason !== 'rate_limited'
      && record.retryReason !== 'temporary_service_error'
    )
  ) throw new TypeError('ModelRequest.stream_stats_json has an invalid shape.');
  return {
    attemptSeq: decimalRuntimeInteger(record.attemptSeq, 'stream_stats.attemptSeq'),
    socketGeneration: decimalRuntimeInteger(record.socketGeneration, 'stream_stats.socketGeneration')
  };
}

function decimalRuntimeInteger(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return BigInt(value);
}

function requirePositiveInteger(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n) throw new TypeError(`${label} must be a positive SQLite INTEGER.`);
  return value;
}

function executeSteps(
  database: Database.Database,
  steps: RepositoryTransactionStep[],
  allocatedSequences: RuntimeAllocatedSequence[]
): void {
  for (const step of steps) {
    if (step.kind === 'assert') {
      executeAssertion(database, step.domain, step.id, step.where);
      continue;
    }
    if (step.kind === 'assertAll') {
      executeAssertAll(database, step.domain, step.where, step.expected);
      continue;
    }
    if (step.kind === 'assertNone') {
      executeAssertNone(database, step.domain, step.where);
      continue;
    }
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
      if (!matchesSavepointContinuation(error, step.onError)) throw error;
    }
  }
}

function executeAssertion(
  database: Database.Database,
  domain: string,
  id: string,
  where: DomainRow
): void {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const encoded = repository.codec.encodeWhere(where);
  const predicates = ['id = @__id'];
  const parameters: EncodedRow & { __id: string } = { __id: requireRuntimeId(id) };
  for (const [name, value] of Object.entries(encoded)) {
    if (name === 'id') throw new Error(`${repository.name} assertion id must be supplied separately.`);
    if (value === null) predicates.push(`${quote(name)} IS NULL`);
    else {
      predicates.push(`${quote(name)} = @${name}`);
      parameters[name] = value;
    }
  }
  const matched = database.prepare(
    `SELECT 1 AS matched FROM ${quote(repository.schema.table)} WHERE ${predicates.join(' AND ')} LIMIT 1`
  ).get(parameters);
  if (!matched) {
    const error = new Error(`${repository.name} transaction assertion failed for ${id}.`) as Error & { code: string };
    error.code = 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
    throw error;
  }
}

function executeAssertAll(
  database: Database.Database,
  domain: string,
  where: DomainRow,
  expected: DomainRow
): void {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const encodedWhere = repository.codec.encodeWhere(where);
  const encodedExpected = repository.codec.encodeWhere(expected);
  if (Object.keys(encodedExpected).length === 0) throw new Error(`${repository.name} assertAll requires expected fields.`);
  const predicates: string[] = [];
  const violations: string[] = [];
  const parameters: EncodedRow = {};
  for (const [name, value] of Object.entries(encodedWhere)) {
    if (value === null) predicates.push(`${quote(name)} IS NULL`);
    else {
      const parameter = `where_${name}`;
      predicates.push(`${quote(name)} = @${parameter}`);
      parameters[parameter] = value;
    }
  }
  for (const [name, value] of Object.entries(encodedExpected)) {
    if (value === null) violations.push(`${quote(name)} IS NOT NULL`);
    else {
      const parameter = `expected_${name}`;
      violations.push(`(${quote(name)} IS NULL OR ${quote(name)} != @${parameter})`);
      parameters[parameter] = value;
    }
  }
  const sql = `SELECT id FROM ${quote(repository.schema.table)}`
    + `${predicates.length ? ` WHERE ${predicates.join(' AND ')} AND (${violations.join(' OR ')})` : ` WHERE ${violations.join(' OR ')}`}`
    + ' LIMIT 1';
  const violating = database.prepare(sql).get(parameters) as { id?: unknown } | undefined;
  if (violating) {
    const error = new Error(`${repository.name} transaction assertAll failed for ${String(violating.id)}.`) as Error & { code: string };
    error.code = 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
    throw error;
  }
}

function executeAssertNone(database: Database.Database, domain: string, where: DomainRow): void {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const encoded = repository.codec.encodeWhere(where);
  const { predicates, parameters } = whereClause(encoded);
  if (predicates.length === 0) throw new Error(`${repository.name} assertNone requires predicates.`);
  const matched = database.prepare(
    `SELECT id FROM ${quote(repository.schema.table)} WHERE ${predicates.join(' AND ')} LIMIT 1`
  ).get(parameters) as { id?: unknown } | undefined;
  if (matched) {
    const error = new Error(`${repository.name} transaction assertNone failed for ${String(matched.id)}.`) as Error & { code: string };
    error.code = 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
    throw error;
  }
}

function executeMutation(
  database: Database.Database,
  mutation: RepositoryMutation,
  allocatedSequences: RuntimeAllocatedSequence[]
): void {
  const repository = DOMAIN_REPOSITORIES.domain(mutation.domain);
  const schema = repository.schema;
  const mutationKind = mutation.kind === 'deleteWhere' || mutation.kind === 'pruneModelStreamCheckpoints'
    ? 'delete'
    : mutation.kind;
  if (!schema.mutations.includes(mutationKind)) {
    throw new Error(`${schema.repository} does not allow ${mutationKind}.`);
  }

  if (mutation.kind === 'pruneModelStreamCheckpoints') {
    executeCheckpointPrune(database, mutation);
  } else if (mutation.kind === 'insert') {
    if (schema.key === 'ModelStreamCheckpoint' || schema.key === 'ModelStreamFence') {
      throw new Error(`${schema.key} insert is limited to the fixed writer modelStreamEvent operation.`);
    }
    const allocatedRow = mutation.allocateSequence
      ? allocateNextSequence(database, repository, mutation)
      : mutation.row;
    const row = resolveMessageRevisionSequenceReference(allocatedRow, mutation, allocatedSequences);
    if (schema.key === 'ModelRequest') {
      if (row.status !== 'prepared' || row.terminal_state !== null) {
        throw new Error('ModelRequest insert must start prepared and non-terminal.');
      }
      decodeModelStreamIdentity(row.stream_stats_json);
    }
    if (schema.key === 'Operation' && row.owner_kind === 'model_request' && row.status !== 'pending') {
      throw new Error('ModelRequest Operation must start pending.');
    }
    if (schema.key === 'Attempt') {
      const operation = database.prepare('SELECT owner_kind FROM operation WHERE id = ?').get(row.operation_id) as {
        owner_kind?: unknown;
      } | undefined;
      if (operation?.owner_kind === 'model_request') {
        if (row.status !== 'pending') throw new Error('ModelRequest Attempt must start pending.');
        if (row.attempt_seq !== 1n && row.attempt_seq !== 2n) {
          throw new Error('ModelRequest permits only attempt_seq 1 or 2.');
        }
      }
    }
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
    assertRuntimeDomainUpdatePatch(schema.key, mutation.patch);
    assertRuntimeStateTransition(database, schema.key, id, mutation.patch);
    const encoded = repository.codec.encodePatch(mutation.patch);
    const assignments = Object.keys(encoded).map((name) => `${quote(name)} = @${name}`);
    const result = database.prepare(`UPDATE ${quote(schema.table)} SET ${assignments.join(', ')} WHERE id = @__id`)
      .run({ ...encoded, __id: id });
    if (result.changes !== 1) throw new Error(`${schema.repository} update expected one row: ${id}`);
  } else if (mutation.kind === 'deleteWhere') {
    if (schema.key === 'ModelStreamCheckpoint') {
      throw new Error('ModelStreamCheckpoint rows can only be pruned by the fixed writer stream-finalization operation.');
    }
    const encoded = repository.codec.encodeWhere(mutation.where);
    const { predicates, parameters } = whereClause(encoded);
    if (predicates.length === 0) throw new Error(`${schema.repository}.deleteWhere requires predicates.`);
    const result = database.prepare(`DELETE FROM ${quote(schema.table)} WHERE ${predicates.join(' AND ')}`).run(parameters);
    if (result.changes > mutation.maxChanges) {
      throw new Error(`${schema.repository}.deleteWhere exceeded ${mutation.maxChanges} row.`);

    }
  } else {
    const id = requireRuntimeId(mutation.id);
    if (schema.key === 'ModelStreamCheckpoint') {
      throw new Error('ModelStreamCheckpoint rows can only be pruned by the fixed writer stream-finalization operation.');
    }
    const result = database.prepare(`DELETE FROM ${quote(schema.table)} WHERE id = ?`).run(id);
    if (result.changes !== 1) throw new Error(`${schema.repository} delete expected one row: ${id}`);
  }
}

function assertPreparedContentInsert(
  metadata: DomainRow,
  insert: RepositoryInsertMutation | undefined
): void {
  if (!insert) return;
  if (insert.domain !== 'ContentObject' || insert.allocateSequence || insert.messageRevisionSequenceReferenceId) {
    throw new Error('ModelStream contentInsert must be one plain ContentObject insert.');
  }
  const encodedMetadata = DOMAIN_REPOSITORIES.codec('ContentObject').encodeInsert(metadata);
  const encodedInsert = DOMAIN_REPOSITORIES.codec('ContentObject').encodeInsert(insert.row);
  for (const [column, value] of Object.entries(encodedMetadata)) {
    if (encodedInsert[column] !== value) {
      throw new Error(`ModelStream contentInsert does not match published metadata column ${column}.`);
    }
  }
}

function insertStreamFact(
  database: Database.Database,
  domain: 'ModelStreamCheckpoint' | 'ModelStreamFence',
  row: DomainRow
): void {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const encoded = repository.codec.encodeInsert(row);
  const names = Object.keys(encoded);
  database.prepare(
    `INSERT INTO ${quote(repository.schema.table)} (${names.map(quote).join(', ')}) `
      + `VALUES (${names.map((name) => `@${name}`).join(', ')})`
  ).run(encoded);
}

function executeCheckpointPrune(
  database: Database.Database,
  mutation: RepositoryCheckpointPruneMutation
): void {
  const modelRequestId = requireRuntimeId(mutation.modelRequestId);
  const terminalCheckpointId = requireRuntimeId(mutation.terminalCheckpointId);
  const fence = database.prepare(`
    SELECT attempt_seq, socket_generation
      FROM model_stream_fence
     WHERE model_request_id = ?
     LIMIT 1
  `).get(modelRequestId) as { attempt_seq?: unknown; socket_generation?: unknown } | undefined;
  if (
    fence?.attempt_seq !== mutation.attemptSeq
    || fence.socket_generation !== mutation.socketGeneration
  ) throw new Error('ModelStream checkpoint prune requires the matching terminal fence identity.');
  const terminal = database.prepare(`
    SELECT model_request_id, attempt_seq, socket_generation, checkpoint_kind
      FROM model_stream_checkpoint
     WHERE id = ?
     LIMIT 1
  `).get(terminalCheckpointId) as {
    model_request_id?: unknown;
    attempt_seq?: unknown;
    socket_generation?: unknown;
    checkpoint_kind?: unknown;
  } | undefined;
  if (
    terminal?.model_request_id !== modelRequestId
    || terminal.attempt_seq !== mutation.attemptSeq
    || terminal.socket_generation !== mutation.socketGeneration
    || terminal.checkpoint_kind !== 'terminal_summary'
  ) throw new Error('ModelStream checkpoint prune requires the matching terminal summary.');
  const retained = database.prepare(`
    SELECT id
      FROM model_stream_checkpoint
     WHERE model_request_id = ?
       AND attempt_seq = ?
       AND socket_generation = ?
       AND checkpoint_kind != 'terminal_summary'
     ORDER BY stream_seq DESC
     LIMIT ?
  `).all(
    modelRequestId,
    mutation.attemptSeq,
    mutation.socketGeneration,
    BigInt(MODEL_STREAM_TERMINAL_TAIL)
  ) as Array<{ id: string }>;
  const keep = new Set([terminalCheckpointId, ...retained.map((row) => requireRuntimeId(row.id))]);
  const obsolete = database.prepare(
    'SELECT id FROM model_stream_checkpoint WHERE model_request_id = ?'
  ).all(modelRequestId) as Array<{ id: string }>;
  const deleteStatement = database.prepare('DELETE FROM model_stream_checkpoint WHERE id = ?');
  for (const row of obsolete) {
    const id = requireRuntimeId(row.id);
    if (!keep.has(id)) deleteStatement.run(id);
  }
}

function resolveMessageRevisionSequenceReference(
  row: DomainRow,
  mutation: RepositoryInsertMutation,
  allocatedSequences: RuntimeAllocatedSequence[]
): DomainRow {
  const messageRevisionId = mutation.messageRevisionSequenceReferenceId;
  if (!messageRevisionId) return row;
  if (
    mutation.domain !== 'ContextSegmentSource'
    || row.source_kind !== 'message_revision'
    || row.source_id !== messageRevisionId
    || 'source_revision' in row
  ) {
    throw new Error('Writer Message revision reference has an invalid ContextSegmentSource shape.');
  }
  const allocated = [...allocatedSequences].reverse().find((entry) =>
    entry.domain === 'MessageRevision'
    && entry.id === messageRevisionId
    && entry.column === 'revision_seq'
  );
  if (!allocated) {
    throw new Error(
      `ContextSegmentSource.source_revision references MessageRevision ${messageRevisionId} before its writer allocation.`
    );
  }
  return { ...row, source_revision: allocated.value };
}

function assertTouchedRuntimeAggregates(
  database: Database.Database,
  steps: readonly RepositoryTransactionStep[]
): void {
  const modelRequestIds = new Set<string>();
  const turnIds = new Set<string>();
  const visit = (step: RepositoryTransactionStep): void => {
    if (step.kind === 'savepoint') {
      step.steps.forEach(visit);
      return;
    }
    if (step.kind === 'assert' || step.kind === 'assertAll' || step.kind === 'assertNone') return;
    if (step.domain === 'ModelRequest') {
      const id = step.kind === 'insert' ? step.row.id : 'id' in step ? step.id : null;
      if (typeof id === 'string') modelRequestIds.add(id);
    } else if (step.domain === 'Operation') {
      const id = step.kind === 'insert' ? step.row.id : 'id' in step ? step.id : null;
      if (typeof id === 'string') {
        const owner = database.prepare('SELECT owner_kind, owner_id FROM operation WHERE id = ?').get(id) as {
          owner_kind?: unknown;
          owner_id?: unknown;
        } | undefined;
        if (owner?.owner_kind === 'model_request' && typeof owner.owner_id === 'string') {
          modelRequestIds.add(owner.owner_id);
        }
      }
    } else if (step.domain === 'Attempt') {
      const id = step.kind === 'insert' ? step.row.id : 'id' in step ? step.id : null;
      if (typeof id === 'string') {
        const owner = database.prepare(`
          SELECT operation.owner_kind, operation.owner_id
            FROM attempt
            JOIN operation ON operation.id = attempt.operation_id
           WHERE attempt.id = ?
        `).get(id) as { owner_kind?: unknown; owner_id?: unknown } | undefined;
        if (owner?.owner_kind === 'model_request' && typeof owner.owner_id === 'string') {
          modelRequestIds.add(owner.owner_id);
        }
      }
    } else if (step.domain === 'Turn') {
      const id = step.kind === 'insert' ? step.row.id : 'id' in step ? step.id : null;
      if (typeof id === 'string') turnIds.add(id);
    } else if (step.domain === 'TurnTermination' && step.kind === 'insert') {
      if (typeof step.row.turn_id === 'string') turnIds.add(step.row.turn_id);
    }
  };
  steps.forEach(visit);
  for (const turnId of turnIds) {
    const turn = database.prepare('SELECT status FROM turn WHERE id = ?').get(turnId) as { status?: unknown } | undefined;
    if (turn?.status === 'active') continue;
    const requests = database.prepare('SELECT id FROM model_request WHERE turn_id = ?').all(turnId) as Array<{ id: string }>;
    for (const request of requests) modelRequestIds.add(requireRuntimeId(request.id));
  }
  for (const modelRequestId of modelRequestIds) assertModelRequestAggregate(database, modelRequestId);
}

function assertModelRequestAggregate(database: Database.Database, modelRequestId: string): void {
  const requestRaw = database.prepare('SELECT * FROM model_request WHERE id = ?').get(modelRequestId);
  if (!requestRaw) throw new Error(`ModelRequest ${modelRequestId} does not exist.`);
  const request = DOMAIN_REPOSITORIES.codec('ModelRequest').decode(requestRaw as Record<string, unknown>);
  const identity = decodeModelStreamIdentity(request.stream_stats_json);
  const operations = database.prepare(
    "SELECT id, status FROM operation WHERE owner_kind = 'model_request' AND owner_id = ?"
  ).all(modelRequestId) as Array<{ id: string; status: string }>;
  if (operations.length !== 1) throw new Error(`ModelRequest ${modelRequestId} must own exactly one Operation.`);
  const operation = operations[0];
  const attempts = database.prepare(
    'SELECT id, attempt_seq, status, completed_at FROM attempt WHERE operation_id = ? ORDER BY attempt_seq'
  ).all(operation.id) as Array<{ id: string; attempt_seq: bigint; status: string; completed_at: string | null }>;
  if (attempts.length < 1 || attempts.length > 2) {
    throw new Error(`ModelRequest ${modelRequestId} must have one or two Attempts.`);
  }
  attempts.forEach((attempt, index) => {
    if (attempt.attempt_seq !== BigInt(index + 1)) {
      throw new Error(`ModelRequest ${modelRequestId} Attempt sequence is not contiguous.`);
    }
  });
  const currentAttempt = attempts.find((attempt) => attempt.attempt_seq === identity.attemptSeq);
  if (!currentAttempt) throw new Error(`ModelRequest ${modelRequestId} stream identity has no matching Attempt.`);
  const fence = database.prepare('SELECT * FROM model_stream_fence WHERE model_request_id = ?').get(modelRequestId) as {
    attempt_seq?: unknown;
    socket_generation?: unknown;
    outcome?: unknown;
  } | undefined;
  const status = String(request.status);
  const terminalState = request.terminal_state;
  if (status !== 'terminal' && terminalState !== null) {
    throw new Error(`Non-terminal ModelRequest ${modelRequestId} cannot carry terminal_state.`);
  }
  if (status === 'prepared') {
    if (
      identity.attemptSeq !== 1n
      || identity.socketGeneration !== 0n
      || operation.status !== 'pending'
      || currentAttempt.status !== 'pending'
      || fence
    ) throw new Error(`Prepared ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (status === 'streaming') {
    if (
      identity.socketGeneration <= 0n
      || operation.status !== 'running'
      || currentAttempt.status !== 'running'
      || fence
    ) throw new Error(`Streaming ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (status === 'retrying') {
    if (
      identity.attemptSeq !== 2n
      || identity.socketGeneration !== 0n
      || operation.status !== 'running'
      || currentAttempt.status !== 'pending'
      || attempts[0]?.status !== 'transient_failed'
      || fence
    ) throw new Error(`Retrying ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (status !== 'terminal' || typeof terminalState !== 'string' || terminalState.length === 0) {
    throw new Error(`ModelRequest ${modelRequestId} has an unsupported aggregate status.`);
  }
  if (terminalState === 'completed') {
    if (
      operation.status !== 'completed'
      || currentAttempt.status !== 'completed'
      || fence?.attempt_seq !== identity.attemptSeq
      || fence.socket_generation !== identity.socketGeneration
      || fence.outcome !== 'completed'
    ) throw new Error(`Completed ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (fence) throw new Error(`Non-completed ModelRequest ${modelRequestId} cannot have a terminal fence.`);
  if (
    !['cancelled', 'failed'].includes(currentAttempt.status)
    || operation.status !== currentAttempt.status
  ) throw new Error(`Terminal ModelRequest ${modelRequestId} aggregate is inconsistent.`);
}

function assertRuntimeStateTransition(
  database: Database.Database,
  domain: string,
  id: string,
  patch: DomainRow
): void {
  if (domain === 'ModelRequest') {
    const raw = database.prepare('SELECT * FROM model_request WHERE id = ?').get(id);
    if (!raw) throw new Error(`ModelRequestRepository update expected one row: ${id}`);
    const current = DOMAIN_REPOSITORIES.codec('ModelRequest').decode(raw as Record<string, unknown>);
    const currentStatus = String(current.status);
    const nextStatus = 'status' in patch ? String(patch.status) : currentStatus;
    const allowed: Record<string, readonly string[]> = {
      prepared: ['prepared', 'streaming', 'terminal'],
      streaming: ['streaming', 'retrying', 'terminal'],
      retrying: ['retrying', 'streaming', 'terminal'],
      terminal: []
    };
    if (!allowed[currentStatus]?.includes(nextStatus)) {
      throw new Error(`ModelRequest status cannot transition from ${currentStatus} to ${nextStatus}.`);
    }
    const terminalState = 'terminal_state' in patch ? patch.terminal_state : current.terminal_state;
    if (nextStatus === 'terminal') {
      if (typeof terminalState !== 'string' || terminalState.length === 0) {
        throw new Error('Terminal ModelRequest requires terminal_state.');
      }
    } else if (terminalState !== null) {
      throw new Error('Non-terminal ModelRequest cannot have terminal_state.');
    }
    if ('stream_stats_json' in patch) {
      const currentIdentity = decodeModelStreamIdentity(current.stream_stats_json);
      const nextIdentity = decodeModelStreamIdentity(patch.stream_stats_json);
      const sameAttempt = nextIdentity.attemptSeq === currentIdentity.attemptSeq;
      const oneRetry = currentIdentity.attemptSeq === 1n
        && nextIdentity.attemptSeq === 2n
        && nextIdentity.socketGeneration === 0n;
      if (
        (!sameAttempt && !oneRetry)
        || (sameAttempt && nextIdentity.socketGeneration < currentIdentity.socketGeneration)
      ) {
        throw new Error('ModelRequest stream identity cannot move backwards or skip the single retry transition.');
      }
    }
    return;
  }
  if (domain !== 'Attempt' && domain !== 'Operation') return;
  const table = domain === 'Attempt' ? 'attempt' : 'operation';
  const ownerJoin = domain === 'Attempt'
    ? 'SELECT current.status, owner.owner_kind FROM attempt AS current JOIN operation AS owner ON owner.id = current.operation_id WHERE current.id = ?'
    : 'SELECT current.status, current.owner_kind FROM operation AS current WHERE current.id = ?';
  const current = database.prepare(ownerJoin).get(id) as { status?: unknown; owner_kind?: unknown } | undefined;
  if (!current || current.owner_kind !== 'model_request') return;
  const currentStatus = String(current.status);
  const nextStatus = 'status' in patch ? String(patch.status) : currentStatus;
  const allowed = domain === 'Attempt'
    ? {
        pending: ['pending', 'running', 'cancelled', 'failed'],
        running: ['running', 'transient_failed', 'completed', 'cancelled', 'failed'],
        transient_failed: [], completed: [], cancelled: [], failed: []
      } as Record<string, readonly string[]>
    : {
        pending: ['pending', 'running', 'cancelled', 'failed'],
        running: ['running', 'completed', 'cancelled', 'failed'],
        completed: [], cancelled: [], failed: []
      } as Record<string, readonly string[]>;
  if (!allowed[currentStatus]?.includes(nextStatus)) {
    throw new Error(`${domain} status cannot transition from ${currentStatus} to ${nextStatus} for a ModelRequest.`);
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
  const isSequence = allocation.column.endsWith('_seq');
  const isPendingInputPosition = repository.schema.key === 'PendingTurnInput' && allocation.column === 'position';
  if (!column || column.type !== 'INTEGER' || (!isSequence && !isPendingInputPosition)) {
    throw new Error(`${repository.name}.${allocation.column} is not an allocatable writer INTEGER.`);
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

function matchesSavepointContinuation(error: unknown, onError: RepositorySavepointOnError): boolean {
  if (onError === 'propagate') return false;
  const value = error as { code?: unknown; message?: unknown };
  if (
    typeof value.code !== 'string'
    || !['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(value.code)
    || typeof value.message !== 'string'
  ) return false;
  const marker = 'UNIQUE constraint failed:';
  const markerIndex = value.message.indexOf(marker);
  if (markerIndex < 0) return false;
  const actualColumns = value.message
    .slice(markerIndex + marker.length)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  return onError.constraints.some((constraint) => {
    const table = DOMAIN_REPOSITORIES.domain(constraint.domain).schema.table;
    const expectedColumns = constraint.columns.map((column) => `${table}.${column}`).sort();
    return actualColumns.length === expectedColumns.length
      && actualColumns.every((column, index) => column === expectedColumns[index]);
  });
}

function whereClause(encoded: EncodedRow): { predicates: string[]; parameters: EncodedRow } {
  const predicates: string[] = [];
  const parameters: EncodedRow = {};
  for (const [name, value] of Object.entries(encoded)) {
    if (value === null) predicates.push(`${quote(name)} IS NULL`);
    else {
      predicates.push(`${quote(name)} = @${name}`);
      parameters[name] = value;
    }
  }
  return { predicates, parameters };
}

function executeContextMaterialization(
  database: Database.Database,
  rootId: string,
  commitSeq: bigint
): SnapshotBarrier<ContextMaterializationSnapshot> {
  const normalizedRootId = requireRuntimeId(rootId);
  database.exec('BEGIN');
  try {
    const rootRepository = DOMAIN_REPOSITORIES.domain('ContextSequenceRoot');
    const rawRoot = database.prepare('SELECT * FROM context_sequence_root WHERE id = ?').get(normalizedRootId);
    if (!rawRoot) throw new Error(`ContextSequenceRoot ${normalizedRootId} does not exist.`);
    const root = rootRepository.codec.decode(rawRoot as Record<string, unknown>);
    const rootNodeId = nullableRuntimeId(root.root_node_id, 'ContextSequenceRoot.root_node_id');
    const tailNodeId = nullableRuntimeId(root.tail_node_id, 'ContextSequenceRoot.tail_node_id');
    const tailCount = nonNegativeSafeInteger(root.tail_segment_count, 'ContextSequenceRoot.tail_segment_count');
    const segmentCount = nonNegativeSafeInteger(root.segment_count, 'ContextSequenceRoot.segment_count');
    let records: ContextMaterializationRecord[] = [];
    if (rootNodeId === null) {
      if (tailNodeId !== null || tailCount !== 0 || segmentCount !== 0) {
        throw new Error(`ContextSequenceRoot ${normalizedRootId} has an invalid empty shape.`);
      }
    } else {
      const rootRecord = readContextRecord(database, rootNodeId);
      if (rootRecord.segment.segment_kind === 'compression') {
        if (rootRecord.node.parent_node_id !== null) {
          throw new Error(`Compression root ${normalizedRootId} summary node must not have a parent.`);
        }
        if ((tailCount === 0) !== (tailNodeId === null)) {
          throw new Error(`Compression root ${normalizedRootId} tail pointer/count mismatch.`);
        }
        const tail = tailNodeId === null ? [] : readContextChain(database, tailNodeId, tailCount);
        records = [rootRecord, ...tail];
        if (records.length !== segmentCount) {
          throw new Error(`Compression root ${normalizedRootId} segment_count mismatch.`);
        }
      } else {
        if (tailNodeId !== null || tailCount !== 0) {
          throw new Error(`Ordinary root ${normalizedRootId} must not carry a compression tail.`);
        }
        records = readContextChain(database, rootNodeId, segmentCount);
        if (records[0]?.node.parent_node_id !== null) {
          throw new Error(`Ordinary root ${normalizedRootId} chain does not terminate at NULL.`);
        }
      }
    }
    database.exec('COMMIT');
    return { snapshotCommitSeq: commitSeq.toString(), snapshot: { root, records } };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function attachContextContent(
  barrier: SnapshotBarrier<ContextMaterializationSnapshot>,
  casRootPath: string
): {
  result: SnapshotBarrier<ContextContentMaterializationSnapshot>;
  transferList: ArrayBuffer[];
} {
  const rootPath = path.resolve(casRootPath);
  const unique = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const record of barrier.snapshot.records) {
    const metadata = record.contentObject;
    const id = requireRuntimeId(metadata.id);
    if (unique.has(id)) continue;
    const sha256 = typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256)
      ? metadata.sha256
      : (() => { throw new Error(`ContentObject ${id} has an invalid sha256.`); })();
    const expectedKey = `sha256/${sha256.slice(0, 2)}/${sha256}`;
    if (metadata.storage_key !== expectedKey) throw new Error(`ContentObject ${id} storage key does not match sha256.`);
    const candidate = path.resolve(rootPath, ...expectedKey.split('/'));
    if (!candidate.startsWith(`${rootPath}${path.sep}`)) throw new Error('CAS storage key escapes its active root.');
    const bytes = fs.readFileSync(candidate);
    if (typeof metadata.byte_length !== 'bigint' || BigInt(bytes.length) !== metadata.byte_length) {
      throw new Error(`ContentObject ${id} byte length mismatch.`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new Error(`ContentObject ${id} digest mismatch.`);
    }
    totalBytes += bytes.length;
    if (!Number.isSafeInteger(totalBytes)) throw new RangeError('Materialized Context bytes exceed the safe packed-buffer range.');
    unique.set(id, bytes);
  }
  const packed = new Uint8Array(totalBytes);
  const views = new Map<string, Uint8Array>();
  let offset = 0;
  for (const [id, bytes] of unique) {
    packed.set(bytes, offset);
    views.set(id, packed.subarray(offset, offset + bytes.length));
    offset += bytes.length;
  }
  return {
    result: {
      snapshotCommitSeq: barrier.snapshotCommitSeq,
      snapshot: {
        root: barrier.snapshot.root,
        records: barrier.snapshot.records.map((record) => ({
          ...record,
          content: views.get(requireRuntimeId(record.contentObject.id)) as Uint8Array
        }))
      }
    },
    transferList: packed.byteLength > 0 ? [packed.buffer] : []
  };
}


function readContextChain(
  database: Database.Database,
  startNodeId: string,
  count: number
): ContextMaterializationRecord[] {
  if (count <= 0) throw new Error('Context chain with a start node requires a positive segment count.');
  const rows = database.prepare(`
    WITH RECURSIVE chain(id, parent_node_id, segment_id, created_at, depth) AS (
      SELECT id, parent_node_id, segment_id, created_at, 1
        FROM context_sequence_node
       WHERE id = @startNodeId
      UNION ALL
      SELECT parent.id, parent.parent_node_id, parent.segment_id, parent.created_at, chain.depth + 1
        FROM context_sequence_node AS parent
        JOIN chain ON parent.id = chain.parent_node_id
       WHERE chain.depth < @segmentCount
    )
    SELECT chain.id AS node_id,
           chain.parent_node_id AS node_parent_node_id,
           chain.segment_id AS node_segment_id,
           chain.created_at AS node_created_at,
           segment.id AS segment_id,
           segment.content_object_id AS segment_content_object_id,
           segment.segment_kind AS segment_kind,
           segment.created_at AS segment_created_at,
           content.id AS content_id,
           content.content_type AS content_type,
           content.sha256 AS content_sha256,
           content.byte_length AS content_byte_length,
           content.storage_key AS content_storage_key,
           content.created_at AS content_created_at,
           chain.depth AS depth
      FROM chain
      JOIN context_segment AS segment ON segment.id = chain.segment_id
      JOIN content_object AS content ON content.id = segment.content_object_id
     ORDER BY chain.depth DESC
  `).all({ startNodeId, segmentCount: BigInt(count) }) as Array<Record<string, unknown>>;
  if (rows.length !== count) throw new Error(`Context chain expected ${count} nodes, found ${rows.length}.`);
  return decodeContextRecords(database, rows);
}

function readContextRecord(database: Database.Database, nodeId: string): ContextMaterializationRecord {
  const row = database.prepare(`
    SELECT node.id AS node_id,
           node.parent_node_id AS node_parent_node_id,
           node.segment_id AS node_segment_id,
           node.created_at AS node_created_at,
           segment.id AS segment_id,
           segment.content_object_id AS segment_content_object_id,
           segment.segment_kind AS segment_kind,
           segment.created_at AS segment_created_at,
           content.id AS content_id,
           content.content_type AS content_type,
           content.sha256 AS content_sha256,
           content.byte_length AS content_byte_length,
           content.storage_key AS content_storage_key,
           content.created_at AS content_created_at,
           1 AS depth
      FROM context_sequence_node AS node
      JOIN context_segment AS segment ON segment.id = node.segment_id
      JOIN content_object AS content ON content.id = segment.content_object_id
     WHERE node.id = ?
  `).get(nodeId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`ContextSequenceNode ${nodeId} does not exist or has missing content.`);
  return decodeContextRecords(database, [row])[0];
}

function decodeContextRecords(
  database: Database.Database,
  rows: Array<Record<string, unknown>>
): ContextMaterializationRecord[] {
  const messageSegmentIds = rows
    .filter((row) => row.segment_kind === 'message')
    .map((row) => requireRuntimeId(row.segment_id));
  const roles = new Map<string, string[]>();
  for (let offset = 0; offset < messageSegmentIds.length; offset += 500) {
    const chunk = messageSegmentIds.slice(offset, offset + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const sourceRows = database.prepare(`
      SELECT source.segment_id AS segment_id, revision.role AS role
        FROM context_segment_source AS source
        JOIN message_revision AS revision
          ON revision.id = source.source_id
         AND revision.revision_seq = source.source_revision
       WHERE source.source_kind = 'message_revision'
         AND source.segment_id IN (${placeholders})
       ORDER BY source.segment_id, source.id
    `).all(...chunk) as Array<{ segment_id: string; role: string }>;
    for (const source of sourceRows) {
      const segmentId = requireRuntimeId(source.segment_id);
      if (typeof source.role !== 'string' || source.role.length === 0) {
        throw new Error(`Message ContextSegment ${segmentId} has an invalid role.`);
      }
      const current = roles.get(segmentId) ?? [];
      current.push(source.role);
      roles.set(segmentId, current);
    }
  }
  return rows.map((row) => decodeContextRecord(row, roles.get(String(row.segment_id)) ?? []));
}

function decodeContextRecord(
  row: Record<string, unknown>,
  messageRoles: readonly string[]
): ContextMaterializationRecord {
  const segmentKind = typeof row.segment_kind === 'string' ? row.segment_kind : '';
  let messageRole: string | null = null;
  if (segmentKind === 'message') {
    if (messageRoles.length !== 1) {
      throw new Error(`Message ContextSegment ${String(row.segment_id)} must resolve exactly one immutable MessageRevision role.`);
    }
    messageRole = messageRoles[0];
  }
  return {
    node: DOMAIN_REPOSITORIES.codec('ContextSequenceNode').decode({
      id: row.node_id,
      parent_node_id: row.node_parent_node_id,
      segment_id: row.node_segment_id,
      created_at: row.node_created_at
    }),
    segment: DOMAIN_REPOSITORIES.codec('ContextSegment').decode({
      id: row.segment_id,
      content_object_id: row.segment_content_object_id,
      segment_kind: row.segment_kind,
      created_at: row.segment_created_at
    }),
    contentObject: DOMAIN_REPOSITORIES.codec('ContentObject').decode({
      id: row.content_id,
      content_type: row.content_type,
      sha256: row.content_sha256,
      byte_length: row.content_byte_length,
      storage_key: row.content_storage_key,
      created_at: row.content_created_at
    }),
    messageRole
  };
}

function nullableRuntimeId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string or NULL.`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} must be a non-negative safe SQLite INTEGER.`);
  }
  return Number(value);
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

function executeSnapshotAll(
  database: Database.Database,
  read: RepositoryListRead,
  commitSeq: bigint
): SnapshotBarrier<DomainRow[]> {
  if (read.orderBy?.column !== 'id' || read.orderBy.direction !== 'asc') {
    throw new TypeError('snapshotAll requires id ascending order.');
  }
  database.exec('BEGIN');
  try {
    const rows: DomainRow[] = [];
    let afterId = read.afterId;
    for (;;) {
      const page = executeRead(database, { ...read, ...(afterId ? { afterId } : {}) });
      if (!Array.isArray(page)) throw new TypeError('snapshotAll list did not return rows.');
      rows.push(...page);
      if (page.length < read.limit) break;
      const lastId = page[page.length - 1]?.id;
      if (typeof lastId !== 'string' || lastId.length === 0 || lastId === afterId) {
        throw new Error('snapshotAll pagination did not advance.');
      }
      afterId = lastId;
    }
    database.exec('COMMIT');
    return { snapshotCommitSeq: commitSeq.toString(), snapshot: rows };
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
  const parameters: EncodedRow & { __after_id?: string; __limit?: bigint } = {};
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
  if (read.afterId !== undefined) {
    if (orderColumn !== 'id' || direction !== 'ASC') throw new TypeError('Repository afterId pagination requires id ascending order.');
    parameters.__after_id = requireRuntimeId(read.afterId);
    predicates.push(`${quote('id')} > @__after_id`);
  }
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

function post(message: DatabaseWorkerResponse, transferList: readonly ArrayBuffer[] = []): void {
  port.postMessage(message, transferList);
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
