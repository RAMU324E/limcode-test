import Database from 'better-sqlite3';
import type { RootBinding, RuntimeClientMapping } from './contracts';
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
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';

const ADDITIVE_DOMAIN_KEY = 'RuntimeDeliveryIntentLink';

export interface RuntimeManifestMigrationResult {
  upgraded: boolean;
  upgradedDomains: string[];
}

interface ClientMappingDrift {
  domainKey: string;
  previousClientMapping: RuntimeClientMapping;
  previousSchemaDigest: string;
}

interface SupportedManifestPredecessor {
  missingAdditiveDomain: boolean;
  clientMappingDrifts: ClientMappingDrift[];
}

/**
 * Reconciles two exact same-epoch predecessor shapes before RuntimeDatabase opens:
 * - historical client projection metadata drift; and
 * - an otherwise-current epoch-4 schema missing only RuntimeDeliveryIntentLink.
 *
 * The additive path creates the relationship table, rewrites the one exact legacy Child Runtime
 * continuation payload, and inserts its independent Link in one SQLite transaction.
 */
export async function migrateCurrentRuntimeManifestIfRequired(
  binding: RootBinding
): Promise<RuntimeManifestMigrationResult> {
  const database = new Database(binding.paths.databasePath, { fileMustExist: true });
  try {
    configureWriterConnection(database);
    try {
      assertCurrentSchema(database, binding);
      assertRuntimePhysicalShape(database, false);
      return { upgraded: false, upgradedDomains: [] };
    } catch {
      // Validate the exact supported predecessor under the writer lock below. The original schema
      // error is deliberately superseded by a specific drift error when it is not one of these cases.
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      assertDatabaseBinding(database, binding);
      const predecessor = inspectSupportedPredecessor(database);
      assertRuntimePhysicalShape(database, predecessor.missingAdditiveDomain);
      const upgradedDomains: string[] = [];

      if (predecessor.missingAdditiveDomain) {
        const schema = requireSchema(ADDITIVE_DOMAIN_KEY);
        database.exec(createRuntimeDomainTableSql(schema));
        schema.indexes.forEach((index, ordinal) => {
          database.exec(createRuntimeDomainIndexSql(schema, index, ordinal));
        });
        insertManifestRow(database, schema);
        await migrateChildRuntimeDeliveryIntentLinks(database, binding.paths.casRootPath);
        upgradedDomains.push(schema.key);
      }

      const update = database.prepare(`
        UPDATE schema_manifest
           SET client_mapping = @clientMapping,
               schema_digest = @schemaDigest
         WHERE domain_key = @domainKey
           AND client_mapping = @previousClientMapping
           AND schema_digest = @previousSchemaDigest
           AND runtime_kernel_epoch = @runtimeKernelEpoch
      `);
      for (const drift of predecessor.clientMappingDrifts) {
        const schema = requireSchema(drift.domainKey);
        const result = update.run({
          domainKey: drift.domainKey,
          clientMapping: schema.client,
          schemaDigest: domainSchemaDigest(schema),
          previousClientMapping: drift.previousClientMapping,
          previousSchemaDigest: drift.previousSchemaDigest,
          runtimeKernelEpoch: BigInt(RUNTIME_KERNEL_EPOCH)
        });
        if (result.changes !== 1) {
          throw new Error(`Runtime manifest changed while reconciling ${drift.domainKey}.`);
        }
        upgradedDomains.push(drift.domainKey);
      }

      assertCurrentSchema(database, binding);
      assertRuntimePhysicalShape(database, false);
      database.exec('COMMIT');
      return {
        upgraded: upgradedDomains.length > 0,
        upgradedDomains: [...new Set(upgradedDomains)]
      };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

function inspectSupportedPredecessor(database: Database.Database): SupportedManifestPredecessor {
  const rows = database.prepare('SELECT * FROM schema_manifest ORDER BY domain_key').all() as Array<Record<string, unknown>>;
  const expectedByKey = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key, schema]));
  const actualKeys = new Set<string>();
  const clientMappingDrifts: ClientMappingDrift[] = [];

  for (const row of rows) {
    const domainKey = requireText(row.domain_key, 'schema_manifest.domain_key');
    if (actualKeys.has(domainKey)) throw new Error(`Runtime manifest contains duplicate domain ${domainKey}.`);
    actualKeys.add(domainKey);
    const schema = expectedByKey.get(domainKey);
    if (!schema) throw new Error(`Runtime manifest drift is unsupported: unknown domain ${domainKey}.`);
    if (manifestMatches(row, schema)) continue;
    const previousClientMapping = requireClientMapping(
      row.client_mapping,
      `schema_manifest.client_mapping for ${domainKey}`
    );
    const previous = previousClientMappingSchema(schema, previousClientMapping);
    if (manifestMatches(row, previous)) {
      clientMappingDrifts.push({
        domainKey,
        previousClientMapping,
        previousSchemaDigest: domainSchemaDigest(previous)
      });
      continue;
    }
    throw new Error(`Runtime manifest drift is unsupported for ${domainKey}.`);
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
  return { missingAdditiveDomain, clientMappingDrifts };
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

function previousClientMappingSchema(
  schema: RuntimeDomainSchema,
  client: RuntimeClientMapping
): RuntimeDomainSchema {
  return { ...schema, client };
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

function requireClientMapping(value: unknown, label: string): RuntimeClientMapping {
  if (value === 'none' || value === 'summary' || value === 'detail' || value === 'window') return value;
  throw new TypeError(`${label} is invalid.`);
}
