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
  domainSchemaDigest
} from './schema/domainManifest';
import type { RuntimeDomainSchema } from './schema/types';

export interface RuntimeManifestMigrationResult {
  upgraded: boolean;
  upgradedDomains: string[];
}

interface ClientMappingDrift {
  domainKey: string;
  previousClientMapping: RuntimeClientMapping;
  previousSchemaDigest: string;
}

/**
 * Reconciles client projection metadata without treating it as a physical database migration.
 * The stored row must match today's complete domain schema after substituting only its historical
 * client_mapping value. Table, mutation, index, ownership and epoch drift still fail closed.
 */
export function migrateCurrentRuntimeManifestIfRequired(
  binding: RootBinding
): RuntimeManifestMigrationResult {
  const database = new Database(binding.paths.databasePath, { fileMustExist: true });
  try {
    configureWriterConnection(database);
    try {
      assertCurrentSchema(database, binding);
      return { upgraded: false, upgradedDomains: [] };
    } catch {
      // Validate the exact supported predecessor under the writer lock below. The original schema
      // error is deliberately superseded by a more specific drift error if it is not this case.
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      assertDatabaseBinding(database, binding);
      const drifts = inspectClientMappingDrift(database);
      if (drifts.length === 0) {
        assertCurrentSchema(database, binding);
        database.exec('COMMIT');
        return { upgraded: false, upgradedDomains: [] };
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
      for (const drift of drifts) {
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
      }
      assertCurrentSchema(database, binding);
      database.exec('COMMIT');
      return { upgraded: true, upgradedDomains: drifts.map((drift) => drift.domainKey) };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

function inspectClientMappingDrift(database: Database.Database): ClientMappingDrift[] {
  const rows = database.prepare('SELECT * FROM schema_manifest ORDER BY domain_key').all() as Array<Record<string, unknown>>;
  if (rows.length !== RUNTIME_DOMAIN_SCHEMAS.length) {
    throw new Error(`Runtime manifest drift is unsupported: expected ${RUNTIME_DOMAIN_SCHEMAS.length} domains, found ${rows.length}.`);
  }
  const expectedByKey = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key, schema]));
  const drifts: ClientMappingDrift[] = [];
  for (const row of rows) {
    const domainKey = requireText(row.domain_key, 'schema_manifest.domain_key');
    const schema = expectedByKey.get(domainKey);
    if (!schema) throw new Error(`Runtime manifest drift is unsupported: unknown domain ${domainKey}.`);
    if (manifestMatches(row, schema)) continue;
    const previousClientMapping = requireClientMapping(
      row.client_mapping,
      `schema_manifest.client_mapping for ${domainKey}`
    );
    const previous = previousClientMappingSchema(schema, previousClientMapping);
    if (manifestMatches(row, previous)) {
      drifts.push({
        domainKey,
        previousClientMapping,
        previousSchemaDigest: domainSchemaDigest(previous)
      });
      continue;
    }
    throw new Error(`Runtime manifest drift is unsupported for ${domainKey}.`);
  }
  return drifts;
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
