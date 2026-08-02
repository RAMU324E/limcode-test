import Database from 'better-sqlite3';
import type { RootBinding } from './contracts';
import { RUNTIME_KERNEL_EPOCH } from './contracts';
import {
  auditDatabaseIntegrity,
  assertCurrentSchema,
  assertDatabaseBinding,
  configureWriterConnection
} from './databaseSchema';
import {
  RUNTIME_DOMAIN_SCHEMAS,
  domainSchemaDigest
} from './schema/domainManifest';
import type { RuntimeDomainSchema } from './schema/types';

const LEGACY_CLIENT_MAPPING_DOMAIN_KEYS = new Set([
  'MessageTurnLink',
  'ProcessOriginLink'
]);

export interface RuntimeManifestMigrationResult {
  upgraded: boolean;
  upgradedDomains: string[];
}

/**
 * Reconciles the only shipped epoch-3 manifest drift: two relationship domains became summary
 * feed records without changing their physical SQLite tables. Unknown drift still fails closed.
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
      const upgradedDomains = inspectSupportedManifestDrift(database);
      if (upgradedDomains.length === 0) {
        assertCurrentSchema(database, binding);
        database.exec('COMMIT');
        return { upgraded: false, upgradedDomains: [] };
      }

      // Only a positively identified, supported migration pays for the full-file audit. A no-op
      // activation performs the fast schema/manifest/binding check above and never reaches here.
      auditDatabaseIntegrity(database);

      const update = database.prepare(`
        UPDATE schema_manifest
           SET client_mapping = @clientMapping,
               schema_digest = @schemaDigest
         WHERE domain_key = @domainKey
           AND client_mapping = @previousClientMapping
           AND schema_digest = @previousSchemaDigest
           AND runtime_kernel_epoch = @runtimeKernelEpoch
      `);
      for (const domainKey of upgradedDomains) {
        const schema = requireSchema(domainKey);
        const previous = previousClientMappingSchema(schema);
        const result = update.run({
          domainKey,
          clientMapping: schema.client,
          schemaDigest: domainSchemaDigest(schema),
          previousClientMapping: previous.client,
          previousSchemaDigest: domainSchemaDigest(previous),
          runtimeKernelEpoch: BigInt(RUNTIME_KERNEL_EPOCH)
        });
        if (result.changes !== 1) {
          throw new Error(`Runtime manifest changed while upgrading ${domainKey}.`);
        }
      }
      assertCurrentSchema(database, binding);
      database.exec('COMMIT');
      return { upgraded: true, upgradedDomains };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

function inspectSupportedManifestDrift(database: Database.Database): string[] {
  const rows = database.prepare('SELECT * FROM schema_manifest ORDER BY domain_key').all() as Array<Record<string, unknown>>;
  if (rows.length !== RUNTIME_DOMAIN_SCHEMAS.length) {
    throw new Error(`Runtime manifest drift is unsupported: expected ${RUNTIME_DOMAIN_SCHEMAS.length} domains, found ${rows.length}.`);
  }
  const expectedByKey = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key, schema]));
  const upgradedDomains: string[] = [];
  for (const row of rows) {
    const domainKey = requireText(row.domain_key, 'schema_manifest.domain_key');
    const schema = expectedByKey.get(domainKey);
    if (!schema) throw new Error(`Runtime manifest drift is unsupported: unknown domain ${domainKey}.`);
    if (manifestMatches(row, schema)) continue;
    if (
      LEGACY_CLIENT_MAPPING_DOMAIN_KEYS.has(domainKey)
      && manifestMatches(row, previousClientMappingSchema(schema))
    ) {
      upgradedDomains.push(domainKey);
      continue;
    }
    throw new Error(`Runtime manifest drift is unsupported for ${domainKey}.`);
  }
  return upgradedDomains;
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

function previousClientMappingSchema(schema: RuntimeDomainSchema): RuntimeDomainSchema {
  return { ...schema, client: 'none' };
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
