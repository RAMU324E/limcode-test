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
  type ClientKeysetPageInput,
  type ClientKeysetPageResult,
  type ClientProjectionSnapshot,
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
  CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE,
  CLIENT_MESSAGE_WINDOW_LIMIT,
  CLIENT_PAGE_MAX_BYTES,
  CLIENT_PAGE_MAX_ROWS,
  CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES
} from './clientFeedBounds';
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

const CONTEXT_CAS_CACHE_MAX_ENTRIES = 4_096;
const CONTEXT_CAS_CACHE_MAX_BYTES = 32 * 1024 * 1024;

interface VerifiedContextCasCacheEntry {
  id: string;
  sha256: string;
  byteLength: bigint;
  storageKey: string;
  bytes: Buffer;
}

/**
 * Context materialization repeatedly reads immutable CAS objects while compiling adjacent model
 * rounds. Keep only verified bytes in a strict LRU budget so 1000-node histories do not issue 1000
 * filesystem reads on every round. Entries never cross a worker/RootBinding lifetime, and callers
 * receive copies in the packed transfer buffer rather than mutable cache Buffers.
 */
class VerifiedContextCasCache {
  private readonly entries = new Map<string, VerifiedContextCasCacheEntry>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  public read(metadata: DomainRow, resolvedCasRootPath: string): Buffer {
    const identity = contextCasIdentity(metadata);
    const cached = this.entries.get(identity.id);
    if (cached) {
      assertSameContextCasIdentity(cached, identity);
      this.entries.delete(identity.id);
      this.entries.set(identity.id, cached);
      this.hits += 1;
      return cached.bytes;
    }
    this.misses += 1;
    const bytes = readVerifiedCasBytes(metadata, resolvedCasRootPath);
    if (bytes.length <= CONTEXT_CAS_CACHE_MAX_BYTES) {
      while (
        this.entries.size >= CONTEXT_CAS_CACHE_MAX_ENTRIES
        || this.totalBytes + bytes.length > CONTEXT_CAS_CACHE_MAX_BYTES
      ) {
        const oldestId = this.entries.keys().next().value as string | undefined;
        if (!oldestId) break;
        const oldest = this.entries.get(oldestId);
        this.entries.delete(oldestId);
        if (oldest) this.totalBytes -= oldest.bytes.length;
        this.evictions += 1;
      }
      const entry: VerifiedContextCasCacheEntry = { ...identity, bytes };
      this.entries.set(identity.id, entry);
      this.totalBytes += bytes.length;
    }
    return bytes;
  }

  public inspect(): DatabaseWorkerDiagnostics['contextCasCache'] {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      maxEntries: CONTEXT_CAS_CACHE_MAX_ENTRIES,
      maxBytes: CONTEXT_CAS_CACHE_MAX_BYTES,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions
    };
  }
}

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
  const contextCasCache = new VerifiedContextCasCache();

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
        const attached = attachContextContent(structure, data.binding.paths.casRootPath, contextCasCache);
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
      if (request.kind === 'clientProjectionSnapshot') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeClientProjectionSnapshot(
          reader,
          request.activeConversationId,
          commitSeq
        );
        post({ type: 'response', id: request.id, ok: true, result });
        return;
      }
      if (request.kind === 'clientKeysetPage') {
        assertDatabaseBinding(reader, data.binding);
        const result = executeClientKeysetPage(reader, request.input);
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
          currentCommitSeq: commitSeq.toString(),
          contextCasCache: contextCasCache.inspect()
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

  // Message 是独立事实，conversation membership/current revision 也是独立 Link。Link 改变时
  // 重新投影 Message 窗口记录；尚未组成完整窗口的 Message 只产生幂等 remove，不阻塞写事务。
  for (const relation of [
    { table: 'message_part_of_conversation', messageColumn: 'message_id' },
    { table: 'message_current_revision_link', messageColumn: 'message_id' }
  ]) {
    for (const operation of ['insert', 'update', 'delete'] as const) {
      const row = operation === 'delete' ? 'OLD' : 'NEW';
      const kind = operation === 'delete' ? 'remove' : 'upsert';
      database.exec(`
        CREATE TEMP TRIGGER ${quote(`capture_message_from_${relation.table}_${operation}`)}
        AFTER ${operation.toUpperCase()} ON ${quote(relation.table)}
        BEGIN
          INSERT INTO runtime_transaction_change (domain, id, kind)
          VALUES ('Message', ${row}.${quote(relation.messageColumn)}, '${kind}');
        END
      `);
    }
  }

  // RuntimeDeliveryInputLink 本身不是客户端领域；它改变的是 RuntimeDelivery 的派生
  // parent_handling_state，因此在同一 commit 中重新投影对应 Delivery。
  for (const operation of ['insert', 'update'] as const) {
    database.exec(`
      CREATE TEMP TRIGGER ${quote(`capture_runtime_delivery_from_input_link_${operation}`)}
      AFTER ${operation.toUpperCase()} ON runtime_delivery_input_link
      BEGIN
        INSERT INTO runtime_transaction_change (domain, id, kind)
        VALUES ('RuntimeDelivery', NEW.delivery_id, 'upsert');
      END
    `);
  }
}

function readTransactionChanges(database: Database.Database): RuntimeChange[] {
  const rows = database.prepare(`
    SELECT current.sequence, current.domain, current.id, current.kind
      FROM runtime_transaction_change AS current
      JOIN (
        SELECT domain, id, MAX(sequence) AS sequence
          FROM runtime_transaction_change
         GROUP BY domain, id
      ) AS latest
        ON latest.sequence = current.sequence
     ORDER BY current.sequence
  `).all() as Array<{ sequence: bigint; domain: string; id: string; kind: 'upsert' | 'remove' }>;
  const topology = new Map(DOMAIN_REPOSITORIES.all().map((repository, index) => [repository.schema.key, index]));
  return rows
    .map((row) => {
      if (row.kind === 'remove') return { ...row };
      const repository = DOMAIN_REPOSITORIES.domain(row.domain);
      const raw = database.prepare(`SELECT * FROM ${quote(repository.schema.table)} WHERE id = ?`).get(row.id);
      if (!raw) throw new Error(`Committed upsert projection ${row.domain}/${row.id} is missing.`);
      let record = repository.codec.decode(raw as Record<string, unknown>);
      if (row.domain === 'Message') {
        const projected = projectMessageWindowRecord(database, row.id);
        if (!projected) return { ...row, kind: 'remove' as const };
        record = projected;
      }
      if (row.domain === 'AnswerBridge') {
        record = projectAnswerBridgeRecord(database, row.id);
      }
      if (row.domain === 'RuntimeDelivery') {
        const links = database.prepare(`
          SELECT handled_at
            FROM runtime_delivery_input_link
           WHERE delivery_id = ?
           LIMIT 2
        `).all(row.id) as Array<{ handled_at: string | null }>;
        if (links.length > 1) throw new Error(`RuntimeDelivery ${row.id} has multiple input links.`);
        record.parent_handling_state = deriveCommittedParentHandling(record, links[0] ?? null);
      }
      return { ...row, record };
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'remove' ? -1 : 1;
      const leftOrder = topology.get(left.domain);
      const rightOrder = topology.get(right.domain);
      if (leftOrder === undefined || rightOrder === undefined) throw new Error('Runtime change references an unknown domain.');
      const dependencyOrder = left.kind === 'remove' ? rightOrder - leftOrder : leftOrder - rightOrder;
      if (dependencyOrder !== 0) return dependencyOrder;
      return left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0;
    })
    .map(({ sequence: _sequence, ...change }) => change);
}

function projectMessageWindowRecord(database: Database.Database, messageId: string): DomainRow | null {
  const rows = queryPlainRows(database, `
    SELECT message.id,
           membership.conversation_id,
           membership.message_seq,
           message.created_at,
           message.updated_at,
           message.deleted_at,
           revision.id AS revision_id,
           revision.revision_seq,
           revision.role,
           revision.content_object_id,
           content.content_type,
           content.byte_length
      FROM message
      JOIN message_part_of_conversation AS membership ON membership.message_id = message.id
      JOIN message_current_revision_link AS current_revision ON current_revision.message_id = message.id
      JOIN message_revision AS revision ON revision.id = current_revision.revision_id
      JOIN content_object AS content ON content.id = revision.content_object_id
     WHERE message.id = @messageId
     LIMIT 1
  `, { messageId });
  if (rows.length > 1) throw new Error(`Message ${messageId} has multiple client window projections.`);
  return rows[0] ?? null;
}

function projectAnswerBridgeRecord(database: Database.Database, answerBridgeId: string): DomainRow {
  const rows = queryPlainRows(database, `
    SELECT bridge.*,
           submission.submission_seq AS current_submission_seq,
           submission.turn_id AS current_turn_id,
           submission.interrupted AS current_submission_interrupted,
           submission.created_at AS current_submission_created_at,
           payload.id AS current_payload_id,
           payload.title AS current_title,
           payload.byte_length AS current_byte_length
      FROM answer_bridge AS bridge
      LEFT JOIN answer_submission AS submission ON submission.id = bridge.current_submission_id
      LEFT JOIN answer_payload AS payload ON payload.submission_id = submission.id
     WHERE bridge.id = @answerBridgeId
     LIMIT 1
  `, { answerBridgeId });
  if (rows.length !== 1) throw new Error(`AnswerBridge ${answerBridgeId} does not exist.`);
  return rows[0];
}

function deriveCommittedParentHandling(
  delivery: DomainRow,
  inputLink: { handled_at: string | null } | null
): 'unhandled' | 'handled' | 'not_applicable' {
  if (delivery.state === 'pending' || delivery.state === 'failed') return 'unhandled';
  if (delivery.state !== 'consumed') throw new Error(`RuntimeDelivery ${String(delivery.id)} has invalid state.`);
  if (delivery.phase === 'notify_only' && inputLink === null) return 'not_applicable';
  if ((delivery.phase === 'current_turn' || delivery.phase === 'next_turn') && inputLink) {
    return inputLink.handled_at === null ? 'unhandled' : 'handled';
  }
  throw new Error(`Consumed RuntimeDelivery ${String(delivery.id)} has an invalid InputLink combination.`);
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
    if (step.kind === 'assertExactIds') {
      executeAssertExactIds(database, step.domain, step.where, step.expectedIds);
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

function executeAssertExactIds(
  database: Database.Database,
  domain: string,
  where: DomainRow,
  expectedIds: readonly string[]
): void {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const encoded = repository.codec.encodeWhere(where);
  const { predicates, parameters } = whereClause(encoded);
  if (predicates.length === 0) throw new Error(`${repository.name} assertExactIds requires predicates.`);
  const actualIds = (database.prepare(
    `SELECT id FROM ${quote(repository.schema.table)} WHERE ${predicates.join(' AND ')} ORDER BY id ASC`
  ).all(parameters) as Array<{ id: unknown }>).map((row) => requireRuntimeId(row.id));
  const expected = [...expectedIds].map(requireRuntimeId).sort();
  if (
    actualIds.length !== expected.length
    || actualIds.some((id, index) => id !== expected[index])
  ) {
    const error = new Error(`${repository.name} transaction assertExactIds failed.`) as Error & { code: string };
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
    if (
      step.kind === 'assert'
      || step.kind === 'assertAll'
      || step.kind === 'assertNone'
      || step.kind === 'assertExactIds'
    ) return;
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
  if (domain === 'RuntimeDelivery') {
    const current = database.prepare('SELECT state FROM runtime_delivery WHERE id = ?').get(id) as {
      state?: unknown;
    } | undefined;
    if (!current || typeof current.state !== 'string') {
      throw new Error(`RuntimeDeliveryRepository update expected one row: ${id}`);
    }
    const nextState = 'state' in patch ? String(patch.state) : current.state;
    const allowed: Record<string, readonly string[]> = {
      pending: ['pending', 'consumed', 'failed'],
      consumed: [],
      failed: []
    };
    if (!allowed[current.state]?.includes(nextState)) {
      throw new Error(`RuntimeDelivery state cannot transition from ${current.state} to ${nextState}.`);
    }
    return;
  }
  if (domain === 'RuntimeDeliveryInputLink') {
    const current = database.prepare('SELECT handled_at FROM runtime_delivery_input_link WHERE id = ?').get(id) as {
      handled_at?: unknown;
    } | undefined;
    if (!current) throw new Error(`RuntimeDeliveryInputLinkRepository update expected one row: ${id}`);
    const nextHandledAt = 'handled_at' in patch ? patch.handled_at : current.handled_at;
    if (current.handled_at !== null || typeof nextHandledAt !== 'string' || nextHandledAt.length === 0) {
      throw new Error('RuntimeDeliveryInputLink.handled_at may only transition once from NULL to a timestamp.');
    }
    return;
  }
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
  casRootPath: string,
  cache: VerifiedContextCasCache
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
    const bytes = cache.read(metadata, rootPath);
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

function contextCasIdentity(metadata: DomainRow): Omit<VerifiedContextCasCacheEntry, 'bytes'> {
  const id = requireRuntimeId(metadata.id);
  const sha256 = typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256)
    ? metadata.sha256
    : (() => { throw new Error(`ContentObject ${id} has an invalid sha256.`); })();
  const byteLength = typeof metadata.byte_length === 'bigint' && metadata.byte_length >= 0n
    ? metadata.byte_length
    : (() => { throw new Error(`ContentObject ${id} has an invalid byte length.`); })();
  const storageKey = `sha256/${sha256.slice(0, 2)}/${sha256}`;
  if (metadata.storage_key !== storageKey) throw new Error(`ContentObject ${id} storage key does not match sha256.`);
  return { id, sha256, byteLength, storageKey };
}

function assertSameContextCasIdentity(
  cached: VerifiedContextCasCacheEntry,
  current: Omit<VerifiedContextCasCacheEntry, 'bytes'>
): void {
  if (
    cached.sha256 !== current.sha256
    || cached.byteLength !== current.byteLength
    || cached.storageKey !== current.storageKey
  ) {
    throw new Error(`ContentObject ${current.id} metadata changed during one Runtime worker lifetime.`);
  }
}

function readVerifiedCasBytes(metadata: DomainRow, resolvedCasRootPath: string): Buffer {
  const id = requireRuntimeId(metadata.id);
  const sha256 = typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256)
    ? metadata.sha256
    : (() => { throw new Error(`ContentObject ${id} has an invalid sha256.`); })();
  const expectedKey = `sha256/${sha256.slice(0, 2)}/${sha256}`;
  if (metadata.storage_key !== expectedKey) throw new Error(`ContentObject ${id} storage key does not match sha256.`);
  if (!path.isAbsolute(resolvedCasRootPath)) throw new Error('CAS root must be resolved before verified reads.');
  // The path segments are derived only from a validated lowercase SHA-256, so no per-object resolve
  // or traversal check is needed on this 1000-record materialization hot path.
  const candidate = path.join(resolvedCasRootPath, 'sha256', sha256.slice(0, 2), sha256);
  const bytes = fs.readFileSync(candidate);
  if (typeof metadata.byte_length !== 'bigint' || BigInt(bytes.length) !== metadata.byte_length) {
    throw new Error(`ContentObject ${id} byte length mismatch.`);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error(`ContentObject ${id} digest mismatch.`);
  }
  return bytes;
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

function executeClientProjectionSnapshot(
  database: Database.Database,
  activeConversationId: string | null,
  commitSeq: bigint
): SnapshotBarrier<ClientProjectionSnapshot> {
  const conversationId = activeConversationId === null ? null : requireRuntimeId(activeConversationId);
  database.exec('BEGIN');
  try {
    const conversations = queryPlainRows(database, `
      SELECT id, title, status, created_at, updated_at
        FROM conversation
       ORDER BY updated_at DESC, id DESC
       LIMIT @limit
    `, { limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) });
    const emptyWindow = {
      conversationId,
      messages: [],
      conversationReuseLinks: [],
      conversationBranchLinks: [],
      conversationOriginLinks: [],
      agentConversationLinks: [],
      taskList: []
    };
    const emptyTurns = {
      turns: [], executionLeases: [], turnTerminations: [], turnExecutorLinks: [], modelRequests: []
    };
    const emptyTools = {
      messageTurnLinks: [],
      toolCalls: [], toolCallEvents: [], toolExecutions: [], toolOutcomes: [], toolModelResults: [],
      toolResultArtifacts: [], interactionRequests: [], interactionOwnerLinks: [], interactionResponses: [],
      fileChangeSets: [], fileChangeSetMembers: [], fileChangeDecisions: [], fileMutationReceipts: [],
      fileMutationReceiptMembers: [], processes: [], processOriginLinks: [], processOutputChunks: [],
      processReceipts: []
    };
    const emptySubagents = {
      childExecutions: [], childExecutionParentLinks: [], childExecutionTurnLinks: [],
      childExecutionActiveTurnLinks: [], childTurns: [], childTurnTerminations: [], childTurnExecutorLinks: [],
      answerBridges: [], answerSubmissions: [],
      runtimeInboxItems: [], runtimeDeliveries: []
    };
    if (conversationId === null) {
      database.exec('COMMIT');
      return {
        snapshotCommitSeq: commitSeq.toString(),
        snapshot: {
          navigationSummary: { conversations },
          activeConversationWindow: emptyWindow,
          activeTurnSummary: emptyTurns,
          activeToolAndInteractionSummary: emptyTools,
          subagentDeliverySummary: emptySubagents
        }
      };
    }

    const params = { conversationId, limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) };
    const messageRows = queryPlainRows(database, `
      SELECT m.id,
             membership.conversation_id,
             membership.message_seq,
             m.created_at,
             m.updated_at,
             m.deleted_at,
             revision.id AS revision_id,
             revision.revision_seq,
             revision.role,
             revision.content_object_id,
             content.content_type,
             content.byte_length
        FROM message_part_of_conversation AS membership
        JOIN message AS m ON m.id = membership.message_id
        JOIN message_current_revision_link AS current_revision ON current_revision.message_id = m.id
        JOIN message_revision AS revision ON revision.id = current_revision.revision_id
        JOIN content_object AS content ON content.id = revision.content_object_id
       WHERE membership.conversation_id = @conversationId
       ORDER BY membership.message_seq DESC, m.id DESC
       LIMIT @messageLimit
    `, { conversationId, messageLimit: BigInt(CLIENT_MESSAGE_WINDOW_LIMIT) }).reverse();
    const reuseLinks = queryPlainRows(database, `
      SELECT * FROM conversation_reuse_link
       WHERE conversation_id = @conversationId
       ORDER BY created_at DESC, id DESC LIMIT @limit
    `, params);
    const branchLinks = queryPlainRows(database, `
      SELECT * FROM conversation_branch_link
       WHERE target_conversation_id = @conversationId OR source_conversation_id = @conversationId
       ORDER BY created_at DESC, id DESC LIMIT @limit
    `, params);
    const originLinks = queryPlainRows(database, `
      SELECT * FROM conversation_origin_link
       WHERE conversation_id = @conversationId OR source_conversation_id = @conversationId
       ORDER BY created_at DESC, id DESC LIMIT @limit
    `, params);
    const agentConversationLinks = queryPlainRows(database, `
      SELECT * FROM agent_conversation_link
       WHERE conversation_id = @conversationId
       ORDER BY updated_at DESC, id DESC LIMIT @limit
    `, params);
    const turns = queryPlainRows(database, `
      SELECT * FROM turn
       WHERE conversation_id = @conversationId
       ORDER BY created_at DESC, id DESC LIMIT @limit
    `, params);
    const turnIds = turns.map((row) => String(row.id));
    const leases = queryByIds(database, 'execution_lease', 'turn_id', turnIds);
    const terminations = queryByIds(database, 'turn_termination', 'turn_id', turnIds);
    const executorLinks = queryByIds(database, 'turn_executor_link', 'turn_id', turnIds);
    const modelRequests = queryByIds(database, 'model_request', 'turn_id', turnIds);
    const messageTurnLinks = queryByIds(
      database,
      'message_turn_link',
      'message_id',
      messageRows.map((row) => String(row.id))
    );
    const toolCalls = queryByIds(database, 'tool_call', 'turn_id', turnIds);
    const toolCallIds = toolCalls.map((row) => String(row.id));
    const toolCallEvents = queryByIds(database, 'tool_call_event', 'tool_call_id', toolCallIds);
    const toolExecutions = queryByIds(database, 'tool_execution', 'tool_call_id', toolCallIds);
    const toolOutcomes = queryByIds(database, 'tool_outcome', 'tool_call_id', toolCallIds);
    const toolModelResults = queryByIds(database, 'tool_model_result', 'tool_call_id', toolCallIds);
    const toolResultArtifacts = queryByIds(database, 'tool_result_artifact', 'tool_call_id', toolCallIds);
    const fileChangeSets = queryByIds(database, 'file_change_set', 'tool_call_id', toolCallIds);
    const fileChangeSetIds = fileChangeSets.map((row) => String(row.id));
    const fileChangeSetMembers = queryByIds(database, 'file_change_set_member', 'change_set_id', fileChangeSetIds);
    const fileChangeDecisions = queryByIds(database, 'file_change_decision', 'change_set_id', fileChangeSetIds);
    const fileMutationReceipts = queryByIds(database, 'file_mutation_receipt', 'change_set_id', fileChangeSetIds);
    const fileMutationReceiptMembers = queryByIds(
      database,
      'file_mutation_receipt_member',
      'receipt_id',
      fileMutationReceipts.map((row) => String(row.id))
    );
    const taskList = toolCalls
      .filter((row) => row.tool_name === 'update_task_list')
      .map((row) => {
        const outcome = toolOutcomes.find((candidate) => candidate.tool_call_id === row.id) ?? null;
        return {
          tool_call_id: row.id,
          turn_id: row.turn_id,
          call_seq: row.call_seq,
          state: row.status,
          outcome: outcome?.status ?? null,
          ...taskListProjectionFromOutcome(database, outcome, String(row.id))
        };
      });
    const interactionOwnerLinks = queryByIds(database, 'interaction_owner_link', 'turn_id', turnIds);
    const interactionRequestIds = interactionOwnerLinks.map((row) => String(row.request_id));
    const interactionRequests = queryByIds(database, 'interaction_request', 'id', interactionRequestIds);
    const interactionToolCallLinks = queryByIds(database, 'interaction_tool_call_link', 'request_id', interactionRequestIds);
    const interactionResponses = queryByIds(database, 'interaction_response', 'request_id', interactionRequestIds);
    const processRows = queryPlainRows(database, `
      SELECT process.*
        FROM process
        JOIN process_origin_link AS origin ON origin.process_id = process.id
        JOIN tool_call ON tool_call.id = origin.tool_call_id
        JOIN turn ON turn.id = tool_call.turn_id
       WHERE turn.conversation_id = @conversationId
       ORDER BY process.started_at DESC, process.id DESC LIMIT @limit
    `, params);
    const processIds = processRows.map((row) => String(row.id));
    const processOriginLinks = queryByIds(database, 'process_origin_link', 'process_id', processIds);
    const processOutputChunks = queryByIds(database, 'process_output_chunk', 'process_id', processIds);
    const processReceipts = queryByIds(database, 'process_receipt', 'process_id', processIds);

    const childExecutions = queryPlainRows(database, `
      SELECT DISTINCT child.*
        FROM child_execution AS child
        JOIN child_execution_parent_link AS parent_link
          ON parent_link.child_execution_id = child.id
        LEFT JOIN tool_call AS source_call ON source_call.id = parent_link.source_tool_call_id
        LEFT JOIN turn AS source_turn ON source_turn.id = source_call.turn_id
       WHERE child.child_conversation_id = @conversationId
          OR source_turn.conversation_id = @conversationId
       ORDER BY child.created_at DESC, child.id DESC LIMIT @limit
    `, params);
    const childIds = childExecutions.map((row) => String(row.id));
    const childParentLinks = queryByIds(database, 'child_execution_parent_link', 'child_execution_id', childIds);
    const childTurnLinks = queryByIds(database, 'child_execution_turn_link', 'child_execution_id', childIds);
    const childActiveLinks = queryByIds(database, 'child_execution_active_turn_link', 'child_execution_id', childIds);
    const childTurnIds = childTurnLinks.map((row) => String(row.turn_id));
    const childTurns = queryByIds(database, 'turn', 'id', childTurnIds);
    const childTurnTerminations = queryByIds(database, 'turn_termination', 'turn_id', childTurnIds);
    const childTurnExecutorLinks = queryByIds(database, 'turn_executor_link', 'turn_id', childTurnIds);
    const answerBridges = queryByIds(database, 'answer_bridge', 'child_execution_id', childIds)
      .map((bridge) => projectAnswerBridgeRecord(database, String(bridge.id)));
    const bridgeIds = answerBridges.map((row) => String(row.id));
    const answerSubmissions = queryByIds(database, 'answer_submission', 'answer_bridge_id', bridgeIds);
    const deliveries = queryPlainRows(database, `
      SELECT * FROM runtime_delivery
       WHERE target_conversation_id = @conversationId
       ORDER BY created_at DESC, id DESC LIMIT @limit
    `, params);
    const deliveryIds = deliveries.map((row) => String(row.id));
    const deliveryInputLinks = queryByIds(database, 'runtime_delivery_input_link', 'delivery_id', deliveryIds);
    const projectedDeliveries = deliveries.map((delivery) => {
      const matching = deliveryInputLinks.filter((link) => link.delivery_id === delivery.id);
      if (matching.length > 1) throw new Error(`RuntimeDelivery ${String(delivery.id)} has multiple input links.`);
      return {
        ...delivery,
        parent_handling_state: deriveCommittedParentHandling(
          delivery,
          matching[0] ? { handled_at: matching[0].handled_at as string | null } : null
        )
      };
    });
    const inboxIds = deliveries.map((row) => String(row.inbox_item_id));
    const inboxItems = queryByIds(database, 'runtime_inbox_item', 'id', inboxIds);

    const snapshot: ClientProjectionSnapshot = {
      navigationSummary: { conversations },
      activeConversationWindow: {
        conversationId,
        messages: messageRows,
        conversationReuseLinks: reuseLinks,
        conversationBranchLinks: branchLinks,
        conversationOriginLinks: originLinks,
        agentConversationLinks,
        taskList
      },
      activeTurnSummary: {
        turns,
        executionLeases: leases,
        turnTerminations: terminations,
        turnExecutorLinks: executorLinks,
        modelRequests
      },
      activeToolAndInteractionSummary: {
        messageTurnLinks,
        toolCalls,
        toolCallEvents,
        toolExecutions,
        toolOutcomes,
        toolModelResults,
        toolResultArtifacts,
        interactionRequests,
        interactionOwnerLinks,
        interactionToolCallLinks,
        interactionResponses,
        fileChangeSets,
        fileChangeSetMembers,
        fileChangeDecisions,
        fileMutationReceipts,
        fileMutationReceiptMembers,
        processes: processRows,
        processOriginLinks,
        processOutputChunks,
        processReceipts
      },
      subagentDeliverySummary: {
        childExecutions,
        childExecutionParentLinks: childParentLinks,
        childExecutionTurnLinks: childTurnLinks,
        childExecutionActiveTurnLinks: childActiveLinks,
        childTurns,
        childTurnTerminations,
        childTurnExecutorLinks,
        answerBridges,
        answerSubmissions,
        runtimeInboxItems: inboxItems,
        runtimeDeliveries: projectedDeliveries
      }
    };
    database.exec('COMMIT');
    return { snapshotCommitSeq: commitSeq.toString(), snapshot };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function taskListProjectionFromOutcome(
  database: Database.Database,
  outcome: Record<string, unknown> | null,
  toolCallId: string
): { items: unknown[] | null; detail_on_demand: boolean } {
  if (!outcome || outcome.content_object_id === null) return { items: null, detail_on_demand: false };
  const contentObjectId = requireRuntimeId(outcome.content_object_id);
  const raw = database.prepare('SELECT * FROM content_object WHERE id = ?').get(contentObjectId);
  if (!raw) throw new Error(`Task-list ToolOutcome ${toolCallId} references missing ContentObject ${contentObjectId}.`);
  const metadata = DOMAIN_REPOSITORIES.codec('ContentObject').decode(raw as Record<string, unknown>);
  if (
    typeof metadata.byte_length !== 'bigint'
    || metadata.byte_length > BigInt(CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES * 16)
  ) {
    return { items: null, detail_on_demand: true };
  }
  const bytes = readVerifiedCasBytes(metadata, path.resolve(data.binding.paths.casRootPath));
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Task-list ToolOutcome ${toolCallId} content is not JSON: ${String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Task-list ToolOutcome ${toolCallId} content is not an object.`);
  }
  const record = value as Record<string, unknown>;
  const detail = record.detail;
  if (
    record.toolCallId !== toolCallId
    || !detail
    || typeof detail !== 'object'
    || Array.isArray(detail)
    || (detail as Record<string, unknown>).kind !== 'task-list'
    || !Array.isArray((detail as Record<string, unknown>).items)
  ) {
    return { items: null, detail_on_demand: true };
  }
  return {
    items: (detail as Record<string, unknown>).items as unknown[],
    detail_on_demand: false
  };
}

function executeClientKeysetPage(
  database: Database.Database,
  input: ClientKeysetPageInput
): ClientKeysetPageResult {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > CLIENT_PAGE_MAX_ROWS) {
    throw new RangeError(`Client keyset page limit must be from 1 to ${CLIENT_PAGE_MAX_ROWS}.`);
  }
  if ((input.afterSortKey === undefined) !== (input.afterId === undefined)) {
    throw new TypeError('Client keyset cursor requires both afterSortKey and afterId.');
  }
  const afterId = input.afterId === undefined ? undefined : requireRuntimeId(input.afterId);
  database.exec('BEGIN');
  try {
    let candidates: Array<Record<string, unknown>>;
    let sortKey: (row: Record<string, unknown>) => string;
    if (input.query === 'conversation') {
      if (input.sortId !== 'created_at+id') throw new TypeError('Conversation keyset sortId must be created_at+id.');
      const afterSortKey = input.afterSortKey;
      candidates = queryPlainRows(database, `
        SELECT id, title, status, created_at, updated_at
          FROM conversation
         ${afterSortKey === undefined ? '' : 'WHERE created_at > @afterSortKey OR (created_at = @afterSortKey AND id > @afterId)'}
         ORDER BY created_at ASC, id ASC
         LIMIT @limit
      `, {
        ...(afterSortKey === undefined ? {} : { afterSortKey, afterId: afterId! }),
        limit: BigInt(input.limit + 1)
      });
      sortKey = (row) => String(row.created_at);
    } else if (input.query === 'message') {
      if (input.sortId !== 'message_seq') throw new TypeError('Message keyset sortId must be message_seq.');
      const conversationId = requireRuntimeId(input.conversationId);
      const afterSortKey = input.afterSortKey === undefined
        ? undefined
        : requireNonNegativeIntegerString(input.afterSortKey, 'afterSortKey');
      candidates = queryPlainRows(database, `
        SELECT message.id,
               membership.conversation_id,
               membership.message_seq,
               message.created_at,
               message.updated_at,
               message.deleted_at,
               revision.id AS revision_id,
               revision.revision_seq,
               revision.role,
               revision.content_object_id,
               content.content_type,
               content.byte_length
          FROM message_part_of_conversation AS membership
          JOIN message ON message.id = membership.message_id
          JOIN message_current_revision_link AS current_revision ON current_revision.message_id = message.id
          JOIN message_revision AS revision ON revision.id = current_revision.revision_id
          JOIN content_object AS content ON content.id = revision.content_object_id
         WHERE membership.conversation_id = @conversationId
           ${afterSortKey === undefined ? '' : 'AND (membership.message_seq > @afterSortKey OR (membership.message_seq = @afterSortKey AND message.id > @afterId))'}
         ORDER BY membership.message_seq ASC, message.id ASC
         LIMIT @limit
      `, {
        conversationId,
        ...(afterSortKey === undefined ? {} : { afterSortKey: BigInt(afterSortKey), afterId: afterId! }),
        limit: BigInt(input.limit + 1)
      });
      sortKey = (row) => String(row.message_seq);
    } else {
      throw new TypeError(`Unsupported client keyset query: ${String(input.query)}.`);
    }

    let hasMore = candidates.length > input.limit;
    const boundedCandidates = candidates.slice(0, input.limit);
    const rows: Array<Record<string, unknown>> = [];
    for (const candidate of boundedCandidates) {
      const tentative = [...rows, candidate];
      const last = tentative[tentative.length - 1];
      const responseProbe = {
        rows: tentative,
        nextSortKey: sortKey(last),
        nextId: String(last.id),
        hasMore: true
      };
      if (wireJsonBytes(responseProbe) > CLIENT_PAGE_MAX_BYTES) {
        hasMore = true;
        break;
      }
      rows.push(candidate);
    }
    if (rows.length === 0 && boundedCandidates.length > 0) {
      throw new Error('A single client keyset summary exceeds maxPageBytes.');
    }
    const last = rows[rows.length - 1];
    const result: ClientKeysetPageResult = {
      rows,
      ...(last ? { nextSortKey: sortKey(last), nextId: String(last.id) } : {}),
      hasMore: hasMore || rows.length < boundedCandidates.length,
      responseBytes: 0
    };
    result.responseBytes = wireJsonBytes(result);
    if (result.responseBytes > CLIENT_PAGE_MAX_BYTES) throw new Error('Client keyset response exceeds maxPageBytes.');
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function queryPlainRows(
  database: Database.Database,
  sql: string,
  parameters: Record<string, string | bigint> = {}
): Array<Record<string, unknown>> {
  return database.prepare(sql).all(parameters) as Array<Record<string, unknown>>;
}

function queryByIds(
  database: Database.Database,
  table: string,
  column: string,
  ids: readonly string[]
): Array<Record<string, unknown>> {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || !/^[a-z][a-z0-9_]*$/.test(column)) {
    throw new Error('Fixed client projection contains an unsafe identifier.');
  }
  const unique = [...new Set(ids)].slice(0, CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE);
  if (unique.length === 0) return [];
  const parameters: Record<string, string | bigint> = {
    limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE)
  };
  const placeholders = unique.map((id, index) => {
    parameters[`id${index}`] = id;
    return `@id${index}`;
  });
  return queryPlainRows(database, `
    SELECT * FROM ${quote(table)}
     WHERE ${quote(column)} IN (${placeholders.join(',')})
     ORDER BY id ASC LIMIT @limit
  `, parameters);
}

function wireJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, (_key, nested) =>
    typeof nested === 'bigint' ? nested.toString() : nested
  ), 'utf8');
}

function requireNonNegativeIntegerString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return value;
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
