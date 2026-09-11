import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import {
  RUNTIME_KERNEL_EPOCH,
  type RootBinding
} from './contracts';
import {
  assertCurrentSchema,
  configureWriterConnection
} from './databaseSchema';
import {
  RUNTIME_DOMAIN_SCHEMAS,
  createRuntimeDomainIndexSql,
  createRuntimeDomainTableSql,
  domainSchemaDigest
} from './schema/domainManifest';
import type { RuntimeDomainSchema } from './schema/types';
import { migrateChildRuntimeDeliveryIntentLinks } from './runtimeDeliveryIntentLinkMigration';
import { assertRuntimeHostsOffline, withRuntimeMaintenance } from './runtimeHostControl';
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';
import { toSqliteFilePath } from './sqliteFilePath';
import {
  RootAuthority,
  RootAuthorityError,
  parseHistoricalRootBinding,
  parseRootBinding,
  sameBindingIdentity,
  type HistoricalRootBinding
} from './rootAuthority';

export const PREVIOUS_RUNTIME_KERNEL_EPOCH = 3;
export const RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE = 'epoch-3-to-4-migration.json';
export const RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY = 'epoch-migration-backups';

const MIGRATION_KIND = 'limcode-runtime-epoch-migration';
const MIGRATION_COMPLETION_KIND = 'limcode-runtime-epoch-migration-completion';
const MIGRATION_LOCK_FILE = 'epoch-3-to-4-migration.lock.json';
const MIGRATION_LOCK_WAIT_MS = 30_000;
const ADDED_DOMAIN_KEYS = new Set([
  'ConversationAttachmentHandleLink',
  'AttachmentObservationLink',
  'CompressionBlockObservationLink',
  'RuntimeDeliveryIntentLink'
]);

export const PREVIOUS_RUNTIME_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = Object.freeze(
  RUNTIME_DOMAIN_SCHEMAS.filter((schema) => !ADDED_DOMAIN_KEYS.has(schema.key))
);

const PREVIOUS_MODEL_CONTEXT_PROJECTION_KEY = 'ModelContextProjection';
export const EPOCH_3_MODEL_CONTEXT_DETAIL_SCHEMA_DIGEST =
  '4c587475862e73a9bf2c172e29d92c047e0e60a674630ce5b54e2e921f00c760';
export const EPOCH_3_MODEL_CONTEXT_SUMMARY_SCHEMA_DIGEST =
  'f84996edbfcb6a9b62d9c42a5140cf279cf3d646e9a75872c52cbeb909c546a9';

export const PREVIOUS_RUNTIME_MANIFEST_VARIANT_CONTRACTS = Object.freeze([
  Object.freeze({
    id: 'epoch-3-v0.0.10-v0.0.11',
    modelContextProjectionClientMapping: 'detail' as const,
    modelContextProjectionSchemaDigest: EPOCH_3_MODEL_CONTEXT_DETAIL_SCHEMA_DIGEST
  }),
  Object.freeze({
    id: 'epoch-3-v0.0.12-v0.0.14',
    modelContextProjectionClientMapping: 'summary' as const,
    modelContextProjectionSchemaDigest: EPOCH_3_MODEL_CONTEXT_SUMMARY_SCHEMA_DIGEST
  })
]);

interface PreviousRuntimeManifestVariant {
  id: string;
  schemas: readonly RuntimeDomainSchema[];
  schemasByKey: ReadonlyMap<string, RuntimeDomainSchema>;
}

const PREVIOUS_RUNTIME_MANIFEST_VARIANTS: readonly PreviousRuntimeManifestVariant[] = Object.freeze(
  PREVIOUS_RUNTIME_MANIFEST_VARIANT_CONTRACTS.map((contract) => {
    const schemas = Object.freeze(PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.map((schema) =>
      schema.key === PREVIOUS_MODEL_CONTEXT_PROJECTION_KEY
        ? Object.freeze({ ...schema, client: contract.modelContextProjectionClientMapping })
        : schema
    ));
    return Object.freeze({
      id: contract.id,
      schemas,
      schemasByKey: new Map(schemas.map((schema) => [schema.key, schema]))
    });
  })
);

export type RuntimeEpochMigrationFaultPoint =
  | 'after-writer-fence'
  | 'before-backup'
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
  backupPath?: string;
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
 * Read-only startup-gate preflight: true only when {@link migratePreviousRuntimeEpochIfRequired}
 * would mutate (a durable migration journal exists or the historical pointer is the exact epoch-3
 * predecessor). Pure current-epoch roots return false so multi-host attach stays offline-free.
 */
export async function previousRuntimeEpochMigrationRequired(authority: RootAuthority): Promise<boolean> {
  const paths = authority.expectedPaths();
  const controlRoot = path.dirname(paths.dataRootPath);
  if (await readJournal(controlRoot)) return true;
  const initialPointer = await authority.readHistoricalPointerForCutover();
  return initialPointer?.runtimeKernelEpoch === PREVIOUS_RUNTIME_KERNEL_EPOCH;
}

/**
 * Upgrades only the exact epoch-3 SQLite/CAS contract immediately preceding epoch 4. The upgrade
 * runs before RuntimeDatabase opens, preserves Conversation/Message/Attachment rows and every
 * existing CAS object, creates the four relation tables, and converts only the exact legacy Child
 * Runtime continuation envelope into the current independent-Link representation. Unknown epochs
 * or schema drift are never guessed.
 *
 * The mutation holds the Runtime maintenance claim and requires every registered Host to be
 * offline; the read-only "not required" branch performs neither.
 */
export async function migratePreviousRuntimeEpochIfRequired(
  authority: RootAuthority,
  options: RuntimeEpochMigrationOptions = {}
): Promise<RuntimeEpochMigrationResult | undefined> {
  const paths = authority.expectedPaths();
  const controlRoot = path.dirname(paths.dataRootPath);
  const existingJournal = await readJournal(controlRoot);
  const initialPointer = await authority.readHistoricalPointerForCutover();
  if (
    !existingJournal
    && (!initialPointer || initialPointer.runtimeKernelEpoch !== PREVIOUS_RUNTIME_KERNEL_EPOCH)
  ) {
    return undefined;
  }

  return withRuntimeMaintenance(paths, async () => {
    await assertRuntimeHostsOffline(paths);
    return withMigrationLock(controlRoot, async () => {
    let journal = await readJournal(controlRoot);
    const previous = await authority.readHistoricalPointerForCutover();
    if (previous?.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH) {
      const binding = await authority.current();
      if (journal) {
        if (!sameBindingIdentity(binding, journal.nextBinding)) {
          throw new RootAuthorityError(
            'runtime-epoch-migration-conflict',
            'Completed pointer does not match the epoch migration journal.'
          );
        }
        await verifyExistingBackup(controlRoot, journal);
        journal.state = 'completed';
        journal.updatedAt = new Date().toISOString();
        await writeJournal(controlRoot, journal);
        await finalizeJournal(controlRoot, journal);
      }
      return {
        binding,
        migrated: Boolean(journal),
        ...(journal ? {
          backupDirectoryName: journal.backupDirectoryName,
          backupPath: backupRootPath(controlRoot, journal)
        } : {})
      };
    }
    if (!previous || previous.runtimeKernelEpoch !== PREVIOUS_RUNTIME_KERNEL_EPOCH) {
      throw new RootAuthorityError(
        'runtime-epoch-migration-unsupported',
        'The historical Runtime pointer is missing or is not the exact epoch-3 predecessor.'
      );
    }

    if (!journal) await assertPreviousEpochRoot(previous);
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
      await assertPreviousEpochRoot(previous);
      if (journal.state === 'fenced') {
        await fault(options, 'before-backup');
        journal.databaseBackupSha256 = await ensureDatabaseBackup(controlRoot, journal);
        journal.state = 'backed_up';
        journal.updatedAt = new Date().toISOString();
        await writeJournal(controlRoot, journal);
        await fault(options, 'after-backup');
      } else {
        await verifyExistingBackup(controlRoot, journal);
      }
      await migrateDatabase(previous.paths.databasePath, previous, next);
    } else if (databaseState === 'current') {
      if (journal.state === 'fenced') {
        throw new RootAuthorityError(
          'runtime-epoch-migration-conflict',
          'Runtime database is upgraded but the durable predecessor backup was never recorded.'
        );
      }
      await verifyExistingBackup(controlRoot, journal);
    } else {
      throw new RootAuthorityError(
        'runtime-epoch-migration-conflict',
        'Runtime database binding matches neither side of the epoch migration journal.'
      );
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
    return {
      binding,
      migrated: true,
      backupDirectoryName: journal.backupDirectoryName,
      backupPath: backupRootPath(controlRoot, journal)
    };
    });
  });
}

async function assertPreviousEpochRoot(binding: HistoricalRootBinding): Promise<void> {
  await assertPreviousEpochManifest(binding);
  const casStat = await fs.stat(binding.paths.casRootPath).catch((error: unknown) => {
    throw new RootAuthorityError(
      'runtime-epoch-migration-cas-missing',
      `Epoch-3 CAS root cannot be read: ${binding.paths.casRootPath}`,
      error
    );
  });
  if (!casStat.isDirectory()) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-cas-missing',
      `Epoch-3 CAS root is not a directory: ${binding.paths.casRootPath}`
    );
  }
  assertPreviousEpochDatabaseFile(binding);
}

async function assertPreviousEpochManifest(binding: HistoricalRootBinding): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(binding.paths.runtimeEpochPath, 'utf8')) as unknown;
  } catch (error) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-epoch-invalid',
      `Epoch-3 Runtime manifest cannot be read: ${binding.paths.runtimeEpochPath}`,
      error
    );
  }
  const record = requireRecord(value, 'RuntimeEpochManifest');
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [
    'kind',
    'runtimeKernelEpoch',
    'dataSetId',
    'rootInstanceId',
    'rootGeneration',
    'initializedAt'
  ].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || record.kind !== 'limcode-runtime-kernel-epoch'
    || record.runtimeKernelEpoch !== PREVIOUS_RUNTIME_KERNEL_EPOCH
    || record.dataSetId !== binding.dataSetId
    || record.rootInstanceId !== binding.rootInstanceId
    || record.rootGeneration !== binding.rootGeneration
    || typeof record.initializedAt !== 'string'
    || record.initializedAt.length === 0
  ) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-epoch-invalid',
      'Epoch-3 Runtime manifest does not match its RootBinding.'
    );
  }
}

function assertPreviousEpochDatabaseFile(binding: HistoricalRootBinding): void {
  const database = new Database(toSqliteFilePath(binding.paths.databasePath), { readonly: true, fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    assertPreviousEpochDatabase(database, binding);
  } finally {
    database.close();
  }
}

function assertPreviousEpochDatabase(
  database: Database.Database,
  binding: HistoricalRootBinding
): void {
  const quickCheck = database.pragma('quick_check') as Array<{ quick_check: string }>;
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
    throw new RootAuthorityError(
      'runtime-epoch-migration-integrity',
      'Epoch-3 SQLite quick_check failed.'
    );
  }
  assertStoredBinding(database, binding);

  try {
    assertRuntimePhysicalSchemaFingerprint(database, PREVIOUS_RUNTIME_DOMAIN_SCHEMAS, {
      label: 'Epoch-3 Runtime physical'
    });
  } catch (error) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-schema-mismatch',
      error instanceof Error ? error.message : 'Epoch-3 Runtime physical DDL fingerprint mismatch.',
      error
    );
  }

  const rows = database.prepare(
    'SELECT * FROM schema_manifest ORDER BY domain_key'
  ).all() as Array<Record<string, unknown>>;
  assertPublishedPreviousEpochManifest(rows);

  const violations = database.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-integrity',
      `Epoch-3 database has ${violations.length} foreign key violations.`
    );
  }
}

async function migrateDatabase(
  file: string,
  previous: HistoricalRootBinding,
  next: RootBinding
): Promise<void> {
  const database = new Database(toSqliteFilePath(file), { fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    configureWriterConnection(database);
    assertPreviousEpochDatabase(database, previous);
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      const added = RUNTIME_DOMAIN_SCHEMAS.filter((schema) => ADDED_DOMAIN_KEYS.has(schema.key));
      for (const schema of added) {
        database.exec(createRuntimeDomainTableSql(schema));
        schema.indexes.forEach((index, ordinal) =>
          database.exec(createRuntimeDomainIndexSql(schema, index, ordinal))
        );
      }
      await migrateChildRuntimeDeliveryIntentLinks(database, previous.paths.casRootPath);
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
      if (update.changes !== 1) {
        throw new RootAuthorityError(
          'runtime-epoch-migration-binding-mismatch',
          'Epoch-3 root_binding compare-and-swap failed.'
        );
      }
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
    throw new RootAuthorityError(
      'runtime-epoch-migration-failed',
      'Epoch-3 SQLite migration failed.',
      error
    );
  } finally {
    database.close();
  }
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
  const database = new Database(toSqliteFilePath(file), { readonly: true, fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    const row = database.prepare(
      'SELECT * FROM root_binding WHERE singleton = 1'
    ).get() as Record<string, unknown> | undefined;
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

async function ensureDatabaseBackup(
  controlRoot: string,
  journal: RuntimeEpochMigrationJournal
): Promise<string> {
  const backupRoot = backupRootPath(controlRoot, journal);
  await ensureSecureDirectory(backupRoot);
  await writeDurableJson(
    path.join(backupRoot, 'root-binding.epoch-3.json'),
    journal.previousBinding
  );
  const previousEpoch = JSON.parse(
    await fs.readFile(journal.previousBinding.paths.runtimeEpochPath, 'utf8')
  ) as unknown;
  await writeDurableJson(
    path.join(backupRoot, 'runtime-kernel-epoch.epoch-3.json'),
    previousEpoch
  );
  const destination = path.join(backupRoot, 'limcode.epoch-3.sqlite');
  const temporary = `${destination}.${process.pid}.tmp`;
  if (!await exists(destination)) {
    await fs.rm(temporary, { force: true });
    await removeSqliteSidecars(temporary);
    const source = new Database(
      toSqliteFilePath(journal.previousBinding.paths.databasePath),
      { readonly: true, fileMustExist: true }
    );
    try {
      try {
        await source.backup(toSqliteFilePath(temporary));
      } catch (error) {
        throw runtimeEpochBackupError('create', temporary, error);
      }
    } finally {
      source.close();
    }
    await fs.chmod(temporary, 0o600);
    try {
      verifyBackupDatabase(temporary, journal.previousBinding);
    } finally {
      await removeSqliteSidecars(temporary);
    }
    await fs.rename(temporary, destination);
    await syncDirectory(backupRoot);
  }
  try {
    verifyBackupDatabase(destination, journal.previousBinding);
    return await sha256File(destination);
  } finally {
    await removeSqliteSidecars(destination);
    await syncDirectory(backupRoot);
  }
}

async function verifyExistingBackup(
  controlRoot: string,
  journal: RuntimeEpochMigrationJournal
): Promise<void> {
  const destination = path.join(
    backupRootPath(controlRoot, journal),
    'limcode.epoch-3.sqlite'
  );
  if (!journal.databaseBackupSha256 || !await exists(destination)) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-backup-missing',
      'Epoch migration backup is missing.'
    );
  }
  try {
    verifyBackupDatabase(destination, journal.previousBinding);
    if (await sha256File(destination) !== journal.databaseBackupSha256) {
      throw new RootAuthorityError(
        'runtime-epoch-migration-backup-invalid',
        'Epoch migration backup digest changed.'
      );
    }
  } finally {
    await removeSqliteSidecars(destination);
    await syncDirectory(path.dirname(destination));
  }
}

function verifyBackupDatabase(file: string, previous: HistoricalRootBinding): void {
  const database = new Database(toSqliteFilePath(file), { readonly: true, fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    assertPreviousEpochDatabase(database, previous);
  } finally {
    database.close();
  }
}

function runtimeEpochBackupError(stage: string, file: string, cause: unknown): RootAuthorityError {
  const code = typeof (cause as { code?: unknown } | null)?.code === 'string'
    ? `; SQLite code ${(cause as { code: string }).code}`
    : '';
  return new RootAuthorityError(
    'runtime-epoch-migration-backup-failed',
    `Epoch-3 SQLite backup ${stage} failed${code}; path length ${file.length}.`,
    cause
  );
}

async function removeSqliteSidecars(file: string): Promise<void> {
  await Promise.all([
    fs.rm(`${file}-wal`, { force: true }),
    fs.rm(`${file}-shm`, { force: true })
  ]);
}

async function finalizeJournal(
  controlRoot: string,
  journal: RuntimeEpochMigrationJournal
): Promise<void> {
  const backupRoot = backupRootPath(controlRoot, journal);
  await writeDurableJson(
    path.join(backupRoot, 'epoch-migration-journal.completed.json'),
    journal
  );
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

async function withMigrationLock<T>(
  controlRoot: string,
  action: () => Promise<T>
): Promise<T> {
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
        throw new RootAuthorityError(
          'runtime-epoch-migration-busy',
          `Runtime epoch migration is owned by PID ${lock.pid}.`
        );
      }
      await delay(100);
    }
  }
  try {
    return await action();
  } finally {
    const current = await readJsonIfExists(lockPath).catch(() => undefined) as
      | Partial<MigrationLock>
      | undefined;
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
  ) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-lock-invalid',
      'Runtime epoch migration lock is invalid.'
    );
  }
  return record as unknown as MigrationLock;
}

async function readJournal(
  controlRoot: string
): Promise<RuntimeEpochMigrationJournal | undefined> {
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
  ) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-journal-invalid',
      'Runtime epoch migration journal is invalid.'
    );
  }
  return {
    kind: MIGRATION_KIND,
    fromEpoch: PREVIOUS_RUNTIME_KERNEL_EPOCH,
    toEpoch: RUNTIME_KERNEL_EPOCH,
    attemptId: record.attemptId,
    state: record.state as RuntimeEpochMigrationJournal['state'],
    backupDirectoryName: record.backupDirectoryName,
    previousBinding: parseHistoricalRootBinding(record.previousBinding),
    nextBinding: parseRootBinding(record.nextBinding),
    ...(typeof record.databaseBackupSha256 === 'string'
      ? { databaseBackupSha256: record.databaseBackupSha256 }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function writeJournal(
  controlRoot: string,
  journal: RuntimeEpochMigrationJournal
): Promise<void> {
  await writeDurableJson(journalPath(controlRoot), journal);
}

function assertJournalBindings(
  journal: RuntimeEpochMigrationJournal,
  previous: HistoricalRootBinding,
  next: RootBinding
): void {
  if (
    !historicalBindingsEqual(journal.previousBinding, previous)
    || !sameBindingIdentity(journal.nextBinding, next)
  ) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-conflict',
      'Runtime epoch migration journal binding identity changed.'
    );
  }
}

function assertStoredBinding(
  database: Database.Database,
  expected: HistoricalRootBinding
): void {
  const row = database.prepare(
    'SELECT * FROM root_binding WHERE singleton = 1'
  ).get() as Record<string, unknown> | undefined;
  if (!row || !storedBindingMatches(row, expected)) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-binding-mismatch',
      'Epoch-3 database RootBinding does not match its pointer.'
    );
  }
}

function storedBindingMatches(
  row: Record<string, unknown>,
  expected: HistoricalRootBinding
): boolean {
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

function assertPublishedPreviousEpochManifest(rows: Array<Record<string, unknown>>): void {
  if (rows.length !== PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.length) {
    throw new RootAuthorityError(
      'runtime-epoch-migration-schema-mismatch',
      'Epoch-3 schema manifest domain count is invalid.'
    );
  }
  for (const variant of PREVIOUS_RUNTIME_MANIFEST_VARIANTS) {
    if (rows.every((row) => {
      const key = requireText(row.domain_key, 'schema_manifest.domain_key');
      const schema = variant.schemasByKey.get(key);
      return Boolean(schema && manifestMatches(row, schema, PREVIOUS_RUNTIME_KERNEL_EPOCH));
    })) return;
  }
  const mismatch = rows.find((row) => {
    const key = requireText(row.domain_key, 'schema_manifest.domain_key');
    return PREVIOUS_RUNTIME_MANIFEST_VARIANTS.every((variant) => {
      const schema = variant.schemasByKey.get(key);
      return !schema || !manifestMatches(row, schema, PREVIOUS_RUNTIME_KERNEL_EPOCH);
    });
  });
  const key = mismatch
    ? requireText(mismatch.domain_key, 'schema_manifest.domain_key')
    : '<mixed-published-variants>';
  throw new RootAuthorityError(
    'runtime-epoch-migration-schema-mismatch',
    `Epoch-3 schema manifest mismatch for ${key}.`
  );
}

function manifestMatches(
  row: Record<string, unknown>,
  schema: RuntimeDomainSchema,
  epoch: number
): boolean {
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

function historicalBindingsEqual(
  left: HistoricalRootBinding,
  right: HistoricalRootBinding
): boolean {
  return left.dataSetId === right.dataSetId
    && left.rootInstanceId === right.rootInstanceId
    && left.rootGeneration === right.rootGeneration
    && left.pointerRevision === right.pointerRevision
    && left.runtimeKernelEpoch === right.runtimeKernelEpoch
    && JSON.stringify(left.paths) === JSON.stringify(right.paths);
}

function journalPath(controlRoot: string): string {
  return path.join(controlRoot, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE);
}

function backupRootPath(
  controlRoot: string,
  journal: Pick<RuntimeEpochMigrationJournal, 'backupDirectoryName'>
): string {
  return path.join(
    controlRoot,
    RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY,
    journal.backupDirectoryName
  );
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
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
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
  await syncDirectoryDurably(directory);
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

async function fault(
  options: RuntimeEpochMigrationOptions,
  point: RuntimeEpochMigrationFaultPoint
): Promise<void> {
  await options.onFaultPoint?.(point);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`);
  return value;
}

if (RUNTIME_KERNEL_EPOCH !== PREVIOUS_RUNTIME_KERNEL_EPOCH + 1) {
  throw new Error('Epoch-3 migration is valid only for the immediate epoch-4 successor.');
}

if (PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.length !== 87) {
  throw new Error(
    `Epoch-3 migration contract must contain 87 domains, found ${PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.length}.`
  );
}

for (const variant of PREVIOUS_RUNTIME_MANIFEST_VARIANTS) {
  if (variant.schemas.length !== PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.length) {
    throw new Error(`Epoch-3 published manifest variant ${variant.id} has an invalid domain count.`);
  }
  const modelContextProjection = variant.schemasByKey.get(PREVIOUS_MODEL_CONTEXT_PROJECTION_KEY);
  const contract = PREVIOUS_RUNTIME_MANIFEST_VARIANT_CONTRACTS.find((candidate) => candidate.id === variant.id);
  if (
    !modelContextProjection
    || !contract
    || modelContextProjection.client !== contract.modelContextProjectionClientMapping
    || domainSchemaDigest(modelContextProjection) !== contract.modelContextProjectionSchemaDigest
  ) {
    throw new Error(`Epoch-3 published manifest variant ${variant.id} fingerprint changed.`);
  }
}
