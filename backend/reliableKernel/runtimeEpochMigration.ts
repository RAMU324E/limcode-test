import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  RUNTIME_KERNEL_EPOCH,
  type RootBinding
} from './contracts';
import {
  assertCurrentSchema,
  configureWriterConnection
} from './databaseSchema';
import { CHILD_EXECUTION_STATUSES } from './childExecutionState';
import {
  METADATA_TABLES,
  RUNTIME_DOMAIN_SCHEMAS,
  RUNTIME_DOMAIN_SCHEMA_BY_KEY,
  RUNTIME_SCHEMA_TRIGGERS,
  createRuntimeDomainIndexSql,
  createRuntimeDomainTableSql,
  domainSchemaDigest
} from './schema/domainManifest';
import type { RuntimeDomainSchema } from './schema/types';
import {
  RootAuthority,
  RootAuthorityError,
  parseHistoricalRootBinding,
  parseRootBinding,
  sameBindingIdentity,
  type HistoricalRootBinding
} from './rootAuthority';

export const PREVIOUS_RUNTIME_KERNEL_EPOCH = 2;
export const RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE = 'epoch-2-to-3-migration.json';
export const RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY = 'epoch-migration-backups';

const MIGRATION_KIND = 'limcode-runtime-epoch-migration';
const MIGRATION_COMPLETION_KIND = 'limcode-runtime-epoch-migration-completion';
const MIGRATION_LOCK_FILE = 'epoch-2-to-3-migration.lock.json';
const MIGRATION_LOCK_WAIT_MS = 30_000;
const ANSWER_SUBMISSION_TEMP_TABLE = 'answer_submission_epoch3';
const ADDED_DOMAIN_KEYS = new Set([
  'ProjectContext',
  'ConversationProjectLink',
  'ChildInterruptionProcessCleanup',
  'TurnFinalOutputFence',
  'ChildInterruptionRequest',
  'ChildInterruptionLineageLink',
  'ChildInterruptionTurnLink',
  'ChildInterruptionIntentLink'
]);
const PREVIOUS_RUNTIME_DELIVERY_INDEXES = Object.freeze([
  'inbox_item_id,target_conversation_id,phase,attempt_seq UNIQUE WHERE target_turn_id IS NULL',
  'inbox_item_id,target_conversation_id,target_turn_id,phase,attempt_seq UNIQUE WHERE target_turn_id IS NOT NULL',
  'retry_of_delivery_id',
  'target_conversation_id,state,created_at'
]);

export const PREVIOUS_RUNTIME_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = Object.freeze(
  RUNTIME_DOMAIN_SCHEMAS
    .filter((schema) => !ADDED_DOMAIN_KEYS.has(schema.key))
    .map(previousEpochSchema)
);

export type RuntimeEpochMigrationFaultPoint =
  | 'after-writer-fence'
  | 'after-backup'
  | 'after-database-commit'
  | 'after-pointer-publication';

export interface RuntimeEpochMigrationOptions {
  onFaultPoint?(point: RuntimeEpochMigrationFaultPoint): Promise<void> | void;
}

export interface RuntimeEpochMigrationResult {
  binding: RootBinding;
  migrated: boolean;
  backupDirectoryName?: string;
}

interface RuntimeEpochMigrationJournal {
  kind: typeof MIGRATION_KIND;
  fromEpoch: typeof PREVIOUS_RUNTIME_KERNEL_EPOCH;
  toEpoch: typeof RUNTIME_KERNEL_EPOCH;
  attemptId: string;
  state: 'fenced' | 'backed_up' | 'database_committed' | 'completed';
  backupDirectoryName: string;
  previousBinding: HistoricalRootBinding;
  nextBinding: RootBinding;
  databaseBackupSha256?: string;
  createdAt: string;
  updatedAt: string;
}

interface MigrationLock {
  kind: 'limcode-runtime-epoch-migration-lock';
  nonce: string;
  pid: number;
  createdAt: string;
}

/**
 * Upgrades only the exact epoch-2 SQLite/CAS contract shipped immediately before epoch 3. The
 * migration runs during Extension Host startup before RuntimeDatabase opens. Unknown epochs or
 * schema drift are rejected without changing the active pointer.
 */
export async function migratePreviousRuntimeEpochIfRequired(
  authority: RootAuthority,
  options: RuntimeEpochMigrationOptions = {}
): Promise<RuntimeEpochMigrationResult | undefined> {
  const paths = authority.expectedPaths();
  const controlRoot = path.dirname(paths.dataRootPath);
  const existingJournal = await readJournal(controlRoot);
  const initialPointer = await authority.readHistoricalPointerForCutover();
  if (!existingJournal && (!initialPointer || initialPointer.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH)) {
    return undefined;
  }
  if (!existingJournal && initialPointer?.runtimeKernelEpoch !== PREVIOUS_RUNTIME_KERNEL_EPOCH) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-unsupported',
      `Runtime epoch ${initialPointer?.runtimeKernelEpoch ?? '<missing>'} cannot be upgraded in place to ${RUNTIME_KERNEL_EPOCH}.`
    );
  }

  return withMigrationLock(controlRoot, async () => {
    let journal = await readJournal(controlRoot);
    let previous = await authority.readHistoricalPointerForCutover();
    if (previous?.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH) {
      const binding = await authority.current();
      if (journal) {
        if (!sameBindingIdentity(binding, journal.nextBinding)) {
          throw new RootAuthorityError('runtime-epoch-migration-conflict', 'Completed pointer does not match the epoch migration journal.');
        }
        journal.state = 'completed';
        journal.updatedAt = new Date().toISOString();
        await writeJournal(controlRoot, journal);
        await finalizeJournal(controlRoot, journal);
      }
      return { binding, migrated: Boolean(journal), ...(journal ? { backupDirectoryName: journal.backupDirectoryName } : {}) };
    }
    if (!previous || previous.runtimeKernelEpoch !== PREVIOUS_RUNTIME_KERNEL_EPOCH) {
      throw new RootAuthorityError('runtime-epoch-migration-unsupported', 'The previous Runtime pointer is missing or is not epoch 2.');
    }

    // On a first attempt, reject unknown predecessor drift before publishing the writer fence. On
    // recovery, the SQLite transaction may already be epoch 3 while the durable active pointer is
    // intentionally still epoch 2, so predecessor validation must wait until we identify which
    // side of the journal the database currently represents.
    if (!journal) await assertPreviousEpochDatabaseFile(previous);
    const next = await authority.stageInPlaceEpochMigration(previous);
    await fault(options, 'after-writer-fence');

    if (!journal) {
      const attemptId = randomUUID();
      journal = {
        kind: MIGRATION_KIND,
        fromEpoch: PREVIOUS_RUNTIME_KERNEL_EPOCH,
        toEpoch: RUNTIME_KERNEL_EPOCH,
        attemptId,
        state: 'fenced',
        backupDirectoryName: `${timestampSlug()}-${attemptId.slice(0, 8)}`,
        previousBinding: previous,
        nextBinding: next,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await writeJournal(controlRoot, journal);
    } else {
      assertJournalBindings(journal, previous, next);
    }

    const databaseState = inspectDatabaseBindingState(previous.paths.databasePath, previous, next);
    if (databaseState === 'previous') {
      // Revalidate after fencing so backup and migration operate on the exact supported source.
      await assertPreviousEpochDatabaseFile(previous);
      if (journal.state === 'fenced') {
        const backupSha256 = await ensureDatabaseBackup(controlRoot, journal);
        journal.databaseBackupSha256 = backupSha256;
        journal.state = 'backed_up';
        journal.updatedAt = new Date().toISOString();
        await writeJournal(controlRoot, journal);
        await fault(options, 'after-backup');
      } else {
        await verifyExistingBackup(controlRoot, journal);
      }
      migrateDatabase(previous.paths.databasePath, previous, next);
    } else if (databaseState === 'current') {
      if (journal.state === 'fenced') {
        throw new RootAuthorityError(
          'runtime-epoch-migration-conflict',
          'Runtime database is upgraded but the durable predecessor backup was never recorded.'
        );
      }
      await verifyExistingBackup(controlRoot, journal);
    } else {
      throw new RootAuthorityError('runtime-epoch-migration-conflict', 'Runtime database binding matches neither side of the migration journal.');
    }
    journal.state = 'database_committed';
    journal.updatedAt = new Date().toISOString();
    await writeJournal(controlRoot, journal);
    await fault(options, 'after-database-commit');

    const binding = await authority.commitInPlaceEpochMigration(previous, next);
    await fault(options, 'after-pointer-publication');
    journal.state = 'completed';
    journal.updatedAt = new Date().toISOString();
    await writeJournal(controlRoot, journal);
    await finalizeJournal(controlRoot, journal);
    return { binding, migrated: true, backupDirectoryName: journal.backupDirectoryName };
  });
}

function previousEpochSchema(schema: RuntimeDomainSchema): RuntimeDomainSchema {
  if (schema.key === 'AnswerSubmission') {
    return Object.freeze({
      ...schema,
      columns: schema.columns.map((column) => column.name === 'turn_id'
        ? Object.freeze({ name: column.name, type: column.type, nullable: true })
        : column)
    });
  }
  if (schema.key === 'RuntimeDelivery') {
    return Object.freeze({ ...schema, indexes: PREVIOUS_RUNTIME_DELIVERY_INDEXES });
  }
  return schema;
}

async function assertPreviousEpochDatabaseFile(binding: HistoricalRootBinding): Promise<void> {
  const database = new Database(binding.paths.databasePath, { readonly: true, fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    assertPreviousEpochDatabase(database, binding);
  } finally {
    database.close();
  }
}

function assertPreviousEpochDatabase(database: Database.Database, binding: HistoricalRootBinding): void {
  const quickCheck = database.pragma('quick_check') as Array<{ quick_check: string }>;
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
    throw new RootAuthorityError('runtime-epoch-migration-integrity', 'Epoch-2 SQLite quick_check failed.');
  }
  assertStoredBinding(database, binding);
  const expectedTables = new Set([
    ...METADATA_TABLES,
    ...PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.map((schema) => schema.table)
  ]);
  const actualTables = new Set((database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all() as Array<{ name: string }>).map((row) => row.name));
  if (!sameSet(expectedTables, actualTables)) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-schema-mismatch',
      `Epoch-2 table set mismatch: expected ${expectedTables.size}, found ${actualTables.size}.`
    );
  }
  const expectedIndexes = expectedNamedIndexes(PREVIOUS_RUNTIME_DOMAIN_SCHEMAS);
  const actualIndexes = new Set((database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"
  ).all() as Array<{ name: string }>).map((row) => row.name));
  if (!sameSet(expectedIndexes, actualIndexes)) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-schema-mismatch',
      `Epoch-2 index set mismatch: expected ${expectedIndexes.size}, found ${actualIndexes.size}.`
    );
  }
  const triggerNames = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>)
    .map((row) => row.name);
  if (triggerNames.length !== 1 || triggerNames[0] !== RUNTIME_SCHEMA_TRIGGERS[0].name) {
    throw new RootAuthorityError('runtime-epoch-migration-schema-mismatch', 'Epoch-2 trigger set is not the supported predecessor contract.');
  }
  const rows = database.prepare('SELECT * FROM schema_manifest ORDER BY domain_key').all() as Array<Record<string, unknown>>;
  if (rows.length !== PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.length) {
    throw new RootAuthorityError('runtime-epoch-migration-schema-mismatch', 'Epoch-2 schema manifest domain count is invalid.');
  }
  const byKey = new Map(PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key, schema]));
  for (const row of rows) {
    const key = requireText(row.domain_key, 'schema_manifest.domain_key');
    const schema = byKey.get(key);
    if (!schema || !manifestMatches(row, schema, PREVIOUS_RUNTIME_KERNEL_EPOCH)) {
      throw new RootAuthorityError('runtime-epoch-migration-schema-mismatch', `Epoch-2 schema manifest mismatch for ${key}.`);
    }
  }
  const nullableTurn = (database.pragma('table_info(answer_submission)') as Array<Record<string, unknown>>)
    .find((column) => column.name === 'turn_id');
  if (!nullableTurn || nullableTurn.notnull !== 0n) {
    throw new RootAuthorityError('runtime-epoch-migration-schema-mismatch', 'Epoch-2 AnswerSubmission.turn_id shape is not recognized.');
  }
  const nullTurnCount = database.prepare('SELECT COUNT(*) AS count FROM answer_submission WHERE turn_id IS NULL').get() as { count: bigint };
  if (nullTurnCount.count !== 0n) {
    throw new RootAuthorityError('runtime-epoch-migration-data-invalid', 'AnswerSubmission rows without source Turn cannot be upgraded safely.');
  }
  const duplicateDelivery = database.prepare(`
    SELECT 1
      FROM runtime_delivery
     GROUP BY inbox_item_id, target_conversation_id, attempt_seq
    HAVING COUNT(*) > 1
     LIMIT 1
  `).get();
  if (duplicateDelivery) {
    throw new RootAuthorityError('runtime-epoch-migration-data-invalid', 'RuntimeDelivery rows violate the epoch-3 attempt identity.');
  }
  const violations = database.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new RootAuthorityError('runtime-epoch-migration-integrity', `Epoch-2 database has ${violations.length} foreign key violations.`);
  }
}

function migrateDatabase(file: string, previous: HistoricalRootBinding, next: RootBinding): void {
  const database = new Database(file, { fileMustExist: true });
  try {
    configureWriterConnection(database);
    assertPreviousEpochDatabase(database, previous);
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      const added = RUNTIME_DOMAIN_SCHEMAS.filter((schema) => ADDED_DOMAIN_KEYS.has(schema.key));
      for (const schema of added) {
        database.exec(createRuntimeDomainTableSql(schema));
        schema.indexes.forEach((index, ordinal) => database.exec(createRuntimeDomainIndexSql(schema, index, ordinal)));
      }
      rebuildAnswerSubmission(database);
      rebuildRuntimeDeliveryIndexes(database);
      migrateLegacyChildExecutionSemantics(database);
      repairForeignCurrentAnswerSubmissions(database);
      database.exec(RUNTIME_SCHEMA_TRIGGERS[1].sql);
      replaceSchemaManifest(database);
      const update = database.prepare(`
        UPDATE root_binding
           SET root_generation = @rootGeneration,
               pointer_revision = @pointerRevision,
               runtime_kernel_epoch = @runtimeKernelEpoch
         WHERE singleton = 1
           AND data_set_id = @dataSetId
           AND root_instance_id = @rootInstanceId
           AND root_generation = @previousRootGeneration
           AND pointer_revision = @previousPointerRevision
           AND runtime_kernel_epoch = @previousEpoch
      `).run({
        rootGeneration: BigInt(next.rootGeneration),
        pointerRevision: BigInt(next.pointerRevision),
        runtimeKernelEpoch: BigInt(next.runtimeKernelEpoch),
        dataSetId: previous.dataSetId,
        rootInstanceId: previous.rootInstanceId,
        previousRootGeneration: BigInt(previous.rootGeneration),
        previousPointerRevision: BigInt(previous.pointerRevision),
        previousEpoch: BigInt(previous.runtimeKernelEpoch)
      });
      if (update.changes !== 1) throw new Error('Epoch-2 root_binding CAS failed.');
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      database.pragma('foreign_keys = ON');
    }
    assertCurrentSchema(database, next);
    database.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    throw new RootAuthorityError('runtime-epoch-migration-failed', 'Epoch-2 SQLite migration failed.', error);
  } finally {
    database.close();
  }
}

function migrateLegacyChildExecutionSemantics(database: Database.Database): void {
  database.exec(`
    UPDATE child_execution
       SET status = CASE
         WHEN status IN ('cancel_subtree_requested', 'cancelling') THEN 'interrupted'
         WHEN status = 'closing' THEN 'closed'
         WHEN status = 'terminated' AND EXISTS (
           SELECT 1
             FROM child_execution_turn_link
            WHERE child_execution_id = child_execution.id
         ) THEN 'interrupted'
         WHEN status = 'terminated' THEN 'closed'
         ELSE status
       END
     WHERE status IN ('cancel_subtree_requested', 'cancelling', 'closing', 'terminated')
  `);
  const supported = new Set<string>(CHILD_EXECUTION_STATUSES);
  const unexpected = (database.prepare('SELECT DISTINCT status FROM child_execution').all() as Array<{ status: string }>)
    .map((row) => row.status)
    .filter((status) => !supported.has(status));
  if (unexpected.length > 0) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-data-invalid',
      `ChildExecution contains unsupported status values: ${unexpected.join(', ')}.`
    );
  }
}

/**
 * Epoch 2 allowed a caller-supplied bridge id to publish from a Turn outside the Child lineage.
 * Preserve those submissions as audit facts, but never leave one authoritative for the bridge.
 */
function repairForeignCurrentAnswerSubmissions(database: Database.Database): void {
  const polluted = database.prepare(`
    SELECT b.id AS bridge_id, b.child_execution_id
      FROM answer_bridge b
      JOIN answer_submission current_submission
        ON current_submission.id = b.current_submission_id
     WHERE NOT EXISTS (
       SELECT 1
         FROM child_execution_turn_link link
        WHERE link.child_execution_id = b.child_execution_id
          AND link.turn_id = current_submission.turn_id
     )
     ORDER BY b.id
  `).all() as Array<{ bridge_id: string; child_execution_id: string }>;
  const latestValid = database.prepare(`
    SELECT submission.id, submission.interrupted, submission.created_at
      FROM answer_submission submission
      JOIN child_execution_turn_link link
        ON link.child_execution_id = @childExecutionId
       AND link.turn_id = submission.turn_id
     WHERE submission.answer_bridge_id = @bridgeId
     ORDER BY submission.submission_seq DESC, submission.id DESC
     LIMIT 1
  `);
  const update = database.prepare(`
    UPDATE answer_bridge
       SET current_submission_id = @submissionId,
           status = @status,
           updated_at = CASE WHEN updated_at < @submissionCreatedAt THEN @submissionCreatedAt ELSE updated_at END
     WHERE id = @bridgeId
  `);
  for (const bridge of polluted) {
    const valid = latestValid.get({
      bridgeId: bridge.bridge_id,
      childExecutionId: bridge.child_execution_id
    }) as { id: string; interrupted: bigint; created_at: string } | undefined;
    if (!valid) {
      throw new RootAuthorityError(
        'runtime-epoch-migration-data-invalid',
        `AnswerBridge ${bridge.bridge_id} points outside its Child lineage and has no valid historical submission.`
      );
    }
    update.run({
      bridgeId: bridge.bridge_id,
      submissionId: valid.id,
      status: valid.interrupted === 1n ? 'interrupted' : 'submitted',
      submissionCreatedAt: valid.created_at
    });
  }
}

function rebuildAnswerSubmission(database: Database.Database): void {
  const schema = requireSchema('AnswerSubmission');
  database.exec(createRuntimeDomainTableSql(schema, ANSWER_SUBMISSION_TEMP_TABLE));
  database.exec(`
    INSERT INTO ${quote(ANSWER_SUBMISSION_TEMP_TABLE)} (
      id, answer_bridge_id, submission_seq, turn_id, interrupted, created_at
    )
    SELECT id, answer_bridge_id, submission_seq, turn_id, interrupted, created_at
      FROM answer_submission
  `);
  database.exec('DROP TABLE answer_submission');
  database.exec(`ALTER TABLE ${quote(ANSWER_SUBMISSION_TEMP_TABLE)} RENAME TO answer_submission`);
  schema.indexes.forEach((index, ordinal) => database.exec(createRuntimeDomainIndexSql(schema, index, ordinal)));
}

function rebuildRuntimeDeliveryIndexes(database: Database.Database): void {
  const schema = requireSchema('RuntimeDelivery');
  const indexes = database.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'index'
       AND tbl_name = 'runtime_delivery'
       AND name NOT LIKE 'sqlite_%'
  `).all() as Array<{ name: string }>;
  for (const index of indexes) database.exec(`DROP INDEX ${quote(index.name)}`);
  schema.indexes.forEach((index, ordinal) => database.exec(createRuntimeDomainIndexSql(schema, index, ordinal)));
}

function replaceSchemaManifest(database: Database.Database): void {
  database.exec('DELETE FROM schema_manifest');
  const insert = database.prepare(`
    INSERT INTO schema_manifest (
      domain_key, table_name, schema_owner, repository_name, codec_name,
      mutations_json, client_mapping, delete_policy, reset_policy, indexes_json,
      schema_digest, runtime_kernel_epoch
    ) VALUES (
      @domainKey, @tableName, @schemaOwner, @repositoryName, @codecName,
      @mutationsJson, @clientMapping, @deletePolicy, @resetPolicy, @indexesJson,
      @schemaDigest, @runtimeKernelEpoch
    )
  `);
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    insert.run({
      domainKey: schema.key,
      tableName: schema.table,
      schemaOwner: schema.schemaOwner,
      repositoryName: schema.repository,
      codecName: schema.codec,
      mutationsJson: JSON.stringify(schema.mutations),
      clientMapping: schema.client,
      deletePolicy: schema.deletePolicy,
      resetPolicy: schema.resetPolicy,
      indexesJson: JSON.stringify(schema.indexes),
      schemaDigest: domainSchemaDigest(schema),
      runtimeKernelEpoch: BigInt(RUNTIME_KERNEL_EPOCH)
    });
  }
}

function inspectDatabaseBindingState(
  file: string,
  previous: HistoricalRootBinding,
  next: RootBinding
): 'previous' | 'current' | 'unknown' {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    const row = database.prepare('SELECT * FROM root_binding WHERE singleton = 1').get() as Record<string, unknown> | undefined;
    if (!row) return 'unknown';
    if (storedBindingMatches(row, previous)) return 'previous';
    if (storedBindingMatches(row, next)) {
      assertCurrentSchema(database, next);
      return 'current';
    }
    return 'unknown';
  } finally {
    database.close();
  }
}

async function ensureDatabaseBackup(controlRoot: string, journal: RuntimeEpochMigrationJournal): Promise<string> {
  const backupRoot = backupRootPath(controlRoot, journal);
  await ensureSecureDirectory(backupRoot);
  await writeDurableJson(path.join(backupRoot, 'root-binding.epoch-2.json'), journal.previousBinding);
  const previousEpoch = JSON.parse(await fs.readFile(journal.previousBinding.paths.runtimeEpochPath, 'utf8')) as unknown;
  await writeDurableJson(path.join(backupRoot, 'runtime-kernel-epoch.epoch-2.json'), previousEpoch);
  const destination = path.join(backupRoot, 'limcode.epoch-2.sqlite');
  const temporary = `${destination}.${process.pid}.tmp`;
  if (!await exists(destination)) {
    await fs.rm(temporary, { force: true });
    const source = new Database(journal.previousBinding.paths.databasePath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(temporary);
    } finally {
      source.close();
    }
    await fs.chmod(temporary, 0o600);
    verifyBackupDatabase(temporary, journal.previousBinding);
    await fs.rename(temporary, destination);
    await syncDirectory(backupRoot);
  }
  verifyBackupDatabase(destination, journal.previousBinding);
  return sha256File(destination);
}

async function verifyExistingBackup(controlRoot: string, journal: RuntimeEpochMigrationJournal): Promise<void> {
  const destination = path.join(backupRootPath(controlRoot, journal), 'limcode.epoch-2.sqlite');
  if (!journal.databaseBackupSha256 || !await exists(destination)) {
    throw new RootAuthorityError('runtime-epoch-migration-backup-missing', 'Epoch migration backup is missing.');
  }
  verifyBackupDatabase(destination, journal.previousBinding);
  const digest = await sha256File(destination);
  if (digest !== journal.databaseBackupSha256) {
    throw new RootAuthorityError('runtime-epoch-migration-backup-invalid', 'Epoch migration backup digest changed.');
  }
}

function verifyBackupDatabase(file: string, previous: HistoricalRootBinding): void {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    assertPreviousEpochDatabase(database, previous);
  } finally {
    database.close();
    for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  }
}

async function finalizeJournal(controlRoot: string, journal: RuntimeEpochMigrationJournal): Promise<void> {
  const backupRoot = backupRootPath(controlRoot, journal);
  await writeDurableJson(path.join(backupRoot, 'epoch-migration-journal.completed.json'), journal);
  await writeDurableJson(path.join(backupRoot, 'epoch-migration-completion.json'), {
    kind: MIGRATION_COMPLETION_KIND,
    attemptId: journal.attemptId,
    fromEpoch: journal.fromEpoch,
    toEpoch: journal.toEpoch,
    previousBinding: journal.previousBinding,
    nextBinding: journal.nextBinding,
    databaseBackupSha256: journal.databaseBackupSha256,
    completedAt: new Date().toISOString()
  });
  await fs.rm(journalPath(controlRoot), { force: true });
  await syncDirectory(controlRoot);
}

async function withMigrationLock<T>(controlRoot: string, action: () => Promise<T>): Promise<T> {
  await ensureSecureDirectory(controlRoot);
  const lockPath = path.join(controlRoot, MIGRATION_LOCK_FILE);
  const deadline = Date.now() + MIGRATION_LOCK_WAIT_MS;
  let owned: MigrationLock | undefined;
  while (!owned) {
    const candidate: MigrationLock = {
      kind: 'limcode-runtime-epoch-migration-lock',
      nonce: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString()
    };
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(candidate)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(controlRoot);
      owned = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lock = await readMigrationLock(lockPath);
      if (!isPidAlive(lock.pid)) {
        await fs.rm(lockPath, { force: true });
        await syncDirectory(controlRoot);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new RootAuthorityError('runtime-epoch-migration-busy', `Runtime epoch migration is owned by PID ${lock.pid}.`);
      }
      await delay(100);
    }
  }
  try {
    return await action();
  } finally {
    const current = await readJsonIfExists(lockPath).catch(() => undefined) as Partial<MigrationLock> | undefined;
    if (current?.nonce === owned.nonce) {
      await fs.rm(lockPath, { force: true });
      await syncDirectory(controlRoot);
    }
  }
}

async function readMigrationLock(file: string): Promise<MigrationLock> {
  const value = await readJsonIfExists(file);
  const record = requireRecord(value, 'RuntimeEpochMigrationLock');
  if (
    record.kind !== 'limcode-runtime-epoch-migration-lock'
    || typeof record.nonce !== 'string'
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.createdAt !== 'string'
  ) throw new RootAuthorityError('runtime-epoch-migration-lock-invalid', 'Runtime epoch migration lock is invalid.');
  return record as unknown as MigrationLock;
}

async function readJournal(controlRoot: string): Promise<RuntimeEpochMigrationJournal | undefined> {
  const value = await readJsonIfExists(journalPath(controlRoot));
  if (value === undefined) return undefined;
  const record = requireRecord(value, 'RuntimeEpochMigrationJournal');
  const states = new Set(['fenced', 'backed_up', 'database_committed', 'completed']);
  if (
    record.kind !== MIGRATION_KIND
    || record.fromEpoch !== PREVIOUS_RUNTIME_KERNEL_EPOCH
    || record.toEpoch !== RUNTIME_KERNEL_EPOCH
    || typeof record.attemptId !== 'string'
    || !states.has(String(record.state))
    || typeof record.backupDirectoryName !== 'string'
    || !/^[0-9TZ-]+-[a-f0-9]{8}$/.test(record.backupDirectoryName)
    || typeof record.createdAt !== 'string'
    || typeof record.updatedAt !== 'string'
  ) throw new RootAuthorityError('runtime-epoch-migration-journal-invalid', 'Runtime epoch migration journal is invalid.');
  return {
    kind: MIGRATION_KIND,
    fromEpoch: PREVIOUS_RUNTIME_KERNEL_EPOCH,
    toEpoch: RUNTIME_KERNEL_EPOCH,
    attemptId: record.attemptId,
    state: record.state as RuntimeEpochMigrationJournal['state'],
    backupDirectoryName: record.backupDirectoryName,
    previousBinding: parseHistoricalRootBinding(record.previousBinding),
    nextBinding: parseRootBinding(record.nextBinding),
    ...(typeof record.databaseBackupSha256 === 'string' ? { databaseBackupSha256: record.databaseBackupSha256 } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function writeJournal(controlRoot: string, journal: RuntimeEpochMigrationJournal): Promise<void> {
  await writeDurableJson(journalPath(controlRoot), journal);
}

function assertJournalBindings(
  journal: RuntimeEpochMigrationJournal,
  previous: HistoricalRootBinding,
  next: RootBinding
): void {
  if (!historicalBindingsEqual(journal.previousBinding, previous) || !sameBindingIdentity(journal.nextBinding, next)) {
    throw new RootAuthorityError('runtime-epoch-migration-conflict', 'Runtime epoch migration journal binding identity changed.');
  }
}

function assertStoredBinding(database: Database.Database, expected: HistoricalRootBinding): void {
  const row = database.prepare('SELECT * FROM root_binding WHERE singleton = 1').get() as Record<string, unknown> | undefined;
  if (!row || !storedBindingMatches(row, expected)) {
    throw new RootAuthorityError('runtime-epoch-migration-binding-mismatch', 'Epoch-2 database RootBinding does not match its pointer.');
  }
}

function storedBindingMatches(row: Record<string, unknown>, expected: HistoricalRootBinding): boolean {
  return row.data_root_path === expected.paths.dataRootPath
    && row.database_path === expected.paths.databasePath
    && row.cas_root_path === expected.paths.casRootPath
    && row.root_pointer_path === expected.paths.rootPointerPath
    && row.root_pending_path === expected.paths.rootPendingPath
    && row.runtime_epoch_path === expected.paths.runtimeEpochPath
    && row.data_set_id === expected.dataSetId
    && row.root_instance_id === expected.rootInstanceId
    && row.root_generation === BigInt(expected.rootGeneration)
    && row.pointer_revision === BigInt(expected.pointerRevision)
    && row.runtime_kernel_epoch === BigInt(expected.runtimeKernelEpoch);
}

function manifestMatches(row: Record<string, unknown>, schema: RuntimeDomainSchema, epoch: number): boolean {
  return row.table_name === schema.table
    && row.schema_owner === schema.schemaOwner
    && row.repository_name === schema.repository
    && row.codec_name === schema.codec
    && row.mutations_json === JSON.stringify(schema.mutations)
    && row.client_mapping === schema.client
    && row.delete_policy === schema.deletePolicy
    && row.reset_policy === schema.resetPolicy
    && row.indexes_json === JSON.stringify(schema.indexes)
    && row.schema_digest === domainSchemaDigest(schema)
    && row.runtime_kernel_epoch === BigInt(epoch);
}

function expectedNamedIndexes(schemas: readonly RuntimeDomainSchema[]): Set<string> {
  return new Set(schemas.flatMap((schema) => schema.indexes.map((index, ordinal) => {
    const unique = index.includes(' UNIQUE');
    return `${unique ? 'ux' : 'ix'}_${schema.table}_${String(ordinal + 1).padStart(2, '0')}`;
  })));
}

function requireSchema(key: string): RuntimeDomainSchema {
  const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(key);
  if (!schema) throw new Error(`Missing Runtime schema ${key}.`);
  return schema;
}

function historicalBindingsEqual(left: HistoricalRootBinding, right: HistoricalRootBinding): boolean {
  return left.dataSetId === right.dataSetId
    && left.rootInstanceId === right.rootInstanceId
    && left.rootGeneration === right.rootGeneration
    && left.pointerRevision === right.pointerRevision
    && left.runtimeKernelEpoch === right.runtimeKernelEpoch
    && JSON.stringify(left.paths) === JSON.stringify(right.paths);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

function journalPath(controlRoot: string): string {
  return path.join(controlRoot, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE);
}

function backupRootPath(controlRoot: string, journal: Pick<RuntimeEpochMigrationJournal, 'backupDirectoryName'>): string {
  return path.join(controlRoot, RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY, journal.backupDirectoryName);
}

async function writeDurableJson(file: string, value: unknown): Promise<void> {
  await ensureSecureDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
  await syncDirectory(path.dirname(file));
}

async function ensureSecureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function fault(options: RuntimeEpochMigrationOptions, point: RuntimeEpochMigrationFaultPoint): Promise<void> {
  await options.onFaultPoint?.(point);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`);
  return value;
}

function quote(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError(`Unsafe SQLite identifier: ${identifier}`);
  return `"${identifier}"`;
}

if (PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.length !== 79) {
  throw new Error(`Epoch-2 migration contract must contain 79 domains, found ${PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.length}.`);
}
