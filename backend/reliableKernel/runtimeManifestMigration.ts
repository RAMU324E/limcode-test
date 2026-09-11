import Database from 'better-sqlite3';
import type { RootBinding } from './contracts';
import { RUNTIME_KERNEL_EPOCH } from './contracts';
import {
  assertCurrentSchema,
  assertDatabaseBinding,
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

const ADDITIVE_DOMAIN_KEY = 'RuntimeDeliveryIntentLink';

export interface RuntimeManifestMigrationResult {
  upgraded: boolean;
  upgradedDomains: string[];
}

/**
 * Read-only startup-gate preflight: true only when the current root's schema is not the exact
 * current contract, i.e. {@link migrateCurrentRuntimeManifestIfRequired} would either apply the
 * RuntimeDeliveryIntentLink-only additive upgrade or reject drift. An exactly current root
 * returns false so multi-host attach never touches the offline gate.
 */
export async function currentRuntimeManifestMigrationRequired(binding: RootBinding): Promise<boolean> {
  const database = new Database(toSqliteFilePath(binding.paths.databasePath), { fileMustExist: true });
  try {
    configureWriterConnection(database);
    try {
      assertCurrentSchema(database, binding);
      assertRuntimePhysicalShape(database, false);
      return false;
    } catch {
      return true;
    }
  } finally {
    database.close();
  }
}

/**
 * Adds RuntimeDeliveryIntentLink only to the otherwise-exact current epoch-4 schema.
 * Every existing manifest row and physical object must match the current contract; historical
 * client-mapping variants belong exclusively to the bounded epoch-3 upgrader.
 * The relationship table and the exact legacy Child Runtime continuation conversion commit in
 * one transaction. Unknown metadata drift is never reconciled into an accepted predecessor.
 *
 * The check runs read-only; the additive mutation holds the Runtime maintenance claim and
 * requires every registered Host to be offline before BEGIN IMMEDIATE.
 */
export async function migrateCurrentRuntimeManifestIfRequired(
  binding: RootBinding
): Promise<RuntimeManifestMigrationResult> {
  return withRuntimeMaintenance(binding.paths, async () => {
    const database = new Database(toSqliteFilePath(binding.paths.databasePath), { fileMustExist: true });
    try {
      configureWriterConnection(database);
      try {
        assertCurrentSchema(database, binding);
        assertRuntimePhysicalShape(database, false);
        return { upgraded: false, upgradedDomains: [] };
      } catch {
        // Validate the exact supported predecessor under the writer lock below. The original schema
        // error is deliberately superseded by a specific drift error for unsupported predecessors.
      }

      await assertRuntimeHostsOffline(binding.paths);
      database.exec('BEGIN IMMEDIATE');
      try {
        assertDatabaseBinding(database, binding);
        const missingAdditiveDomain = inspectSupportedPredecessor(database);
        assertRuntimePhysicalShape(database, missingAdditiveDomain);

        if (missingAdditiveDomain) {
          const schema = requireSchema(ADDITIVE_DOMAIN_KEY);
          database.exec(createRuntimeDomainTableSql(schema));
          schema.indexes.forEach((index, ordinal) => {
            database.exec(createRuntimeDomainIndexSql(schema, index, ordinal));
          });
          insertManifestRow(database, schema);
          await migrateChildRuntimeDeliveryIntentLinks(database, binding.paths.casRootPath);
        }

        assertCurrentSchema(database, binding);
        assertRuntimePhysicalShape(database, false);
        database.exec('COMMIT');
        return {
          upgraded: missingAdditiveDomain,
          upgradedDomains: missingAdditiveDomain ? [ADDITIVE_DOMAIN_KEY] : []
        };
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } finally {
      database.close();
    }
  });
}

function inspectSupportedPredecessor(database: Database.Database): boolean {
  const rows = database.prepare('SELECT * FROM schema_manifest ORDER BY domain_key').all() as Array<Record<string, unknown>>;
  const expectedByKey = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key, schema]));
  const actualKeys = new Set<string>();

  for (const row of rows) {
    const domainKey = requireText(row.domain_key, 'schema_manifest.domain_key');
    if (actualKeys.has(domainKey)) throw new Error(`Runtime manifest contains duplicate domain ${domainKey}.`);
    actualKeys.add(domainKey);
    const schema = expectedByKey.get(domainKey);
    if (!schema) throw new Error(`Runtime manifest drift is unsupported: unknown domain ${domainKey}.`);
    if (!manifestMatches(row, schema)) {
      throw new Error(`Runtime manifest drift is unsupported for ${domainKey}.`);
    }
  }

  const missing = RUNTIME_DOMAIN_SCHEMAS.filter((schema) => !actualKeys.has(schema.key));
  const missingAdditiveDomain = missing.length === 1 && missing[0]!.key === ADDITIVE_DOMAIN_KEY;
  if (missing.length > 0 && !missingAdditiveDomain) {
    throw new Error(`Runtime manifest drift is unsupported: missing domains ${missing.map((schema) => schema.key).join(', ')}.`);
  }
  const expectedCount = RUNTIME_DOMAIN_SCHEMAS.length - (missingAdditiveDomain ? 1 : 0);
  if (rows.length !== expectedCount) {
    throw new Error(`Runtime manifest drift is unsupported: expected ${expectedCount} domains, found ${rows.length}.`);
  }
  return missingAdditiveDomain;
}

function assertRuntimePhysicalShape(
  database: Database.Database,
  missingAdditiveDomain: boolean
): void {
  const schemas = missingAdditiveDomain
    ? RUNTIME_DOMAIN_SCHEMAS.filter((schema) => schema.key !== ADDITIVE_DOMAIN_KEY)
    : RUNTIME_DOMAIN_SCHEMAS;
  assertRuntimePhysicalSchemaFingerprint(database, schemas);
}

function insertManifestRow(database: Database.Database, schema: RuntimeDomainSchema): void {
  database.prepare(`
    INSERT INTO schema_manifest (
      domain_key, table_name, schema_owner, repository_name, codec_name,
      mutations_json, client_mapping, delete_policy, reset_policy, indexes_json,
      schema_digest, runtime_kernel_epoch
    ) VALUES (
      @domainKey, @tableName, @schemaOwner, @repositoryName, @codecName,
      @mutationsJson, @clientMapping, @deletePolicy, @resetPolicy, @indexesJson,
      @schemaDigest, @runtimeKernelEpoch
    )
  `).run({
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

function manifestMatches(row: Record<string, unknown>, schema: RuntimeDomainSchema): boolean {
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
    && row.runtime_kernel_epoch === BigInt(RUNTIME_KERNEL_EPOCH);
}

function requireSchema(domainKey: string): RuntimeDomainSchema {
  const schema = RUNTIME_DOMAIN_SCHEMAS.find((candidate) => candidate.key === domainKey);
  if (!schema) throw new Error(`Runtime schema ${domainKey} is missing.`);
  return schema;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}
