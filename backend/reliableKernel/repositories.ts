import type { RuntimeDomainMutation } from './contracts';
import {
  RUNTIME_DOMAIN_SCHEMAS,
  RUNTIME_DOMAIN_SCHEMA_BY_KEY
} from './schema/domainManifest';
import type { ColumnDefinition, RuntimeDomainSchema } from './schema/types';

export type DomainRow = Record<string, unknown>;
export type EncodedRow = Record<string, string | bigint | Buffer | null>;

export interface RepositoryInsertMutation {
  kind: 'insert';
  domain: string;
  row: DomainRow;
  allocateSequence?: {
    column: string;
    scope: DomainRow;
  };
}

export interface RepositoryUpdateMutation {
  kind: 'update';
  domain: string;
  id: string;
  patch: DomainRow;
}

export interface RepositoryDeleteMutation {
  kind: 'delete';
  domain: string;
  id: string;
}

export interface RepositorySavepoint {
  kind: 'savepoint';
  name: string;
  steps: RepositoryTransactionStep[];
  onError: 'propagate' | 'rollback-and-continue';
}

export type RepositoryMutation = RepositoryInsertMutation | RepositoryUpdateMutation | RepositoryDeleteMutation;
export type RepositoryTransactionStep = RepositoryMutation | RepositorySavepoint;

export interface RepositoryGetRead {
  kind: 'get';
  domain: string;
  id: string;
}

export interface RepositoryListRead {
  kind: 'list';
  domain: string;
  where?: DomainRow;
  orderBy?: { column: string; direction: 'asc' | 'desc' };
  limit: number;
}

export type RepositoryRead = RepositoryGetRead | RepositoryListRead;

export class DomainRowCodec {
  private readonly columnsByName: ReadonlyMap<string, ColumnDefinition>;

  public constructor(
    public readonly name: string,
    public readonly schema: RuntimeDomainSchema
  ) {
    this.columnsByName = new Map(schema.columns.map((column) => [column.name, column]));
  }

  public encodeInsert(row: DomainRow): EncodedRow {
    rejectUnknownKeys(row, this.columnsByName, this.name);
    const encoded: EncodedRow = {};
    for (const column of this.schema.columns) {
      const value = row[column.name];
      if (value === undefined) {
        if (column.defaultSql !== undefined) continue;
        if (column.nullable) {
          encoded[column.name] = null;
          continue;
        }
        throw new TypeError(`${this.name}.${column.name} is required.`);
      }
      encoded[column.name] = encodeValue(column, value, this.name);
    }
    return encoded;
  }

  public encodePatch(patch: DomainRow): EncodedRow {
    rejectUnknownKeys(patch, this.columnsByName, this.name);
    if ('id' in patch) throw new TypeError(`${this.name}.id is immutable.`);
    const encoded: EncodedRow = {};
    for (const [name, value] of Object.entries(patch)) {
      const column = this.columnsByName.get(name);
      if (!column) throw new TypeError(`${this.name}.${name} is not a schema column.`);
      if (value === undefined) throw new TypeError(`${this.name}.${name} cannot be undefined.`);
      encoded[name] = encodeValue(column, value, this.name);
    }
    if (Object.keys(encoded).length === 0) throw new TypeError(`${this.name} update patch cannot be empty.`);
    return encoded;
  }

  public encodeWhere(where: DomainRow): EncodedRow {
    rejectUnknownKeys(where, this.columnsByName, this.name);
    const encoded: EncodedRow = {};
    for (const [name, value] of Object.entries(where)) {
      const column = this.columnsByName.get(name);
      if (!column) throw new TypeError(`${this.name}.${name} is not a schema column.`);
      if (value === undefined) throw new TypeError(`${this.name}.${name} cannot be undefined.`);
      encoded[name] = encodeValue(column, value, this.name);
    }
    return encoded;
  }

  public decode(row: Record<string, unknown>): DomainRow {
    const decoded: DomainRow = {};
    for (const column of this.schema.columns) {
      if (!(column.name in row)) throw new TypeError(`${this.name} query row is missing ${column.name}.`);
      const value = row[column.name];
      if (value === null) {
        if (!column.nullable) throw new TypeError(`${this.name}.${column.name} unexpectedly contains NULL.`);
        decoded[column.name] = null;
      } else if (column.json) {
        if (typeof value !== 'string') throw new TypeError(`${this.name}.${column.name} must be JSON text in SQLite.`);
        decoded[column.name] = JSON.parse(value);
      } else if (column.type === 'INTEGER') {
        if (typeof value !== 'bigint') throw new TypeError(`${this.name}.${column.name} must be read with safe integers enabled.`);
        decoded[column.name] = value;
      } else if (column.type === 'BLOB') {
        if (!Buffer.isBuffer(value)) throw new TypeError(`${this.name}.${column.name} must be a Buffer.`);
        decoded[column.name] = Buffer.from(value);
      } else {
        if (typeof value !== 'string') throw new TypeError(`${this.name}.${column.name} must be text.`);
        decoded[column.name] = value;
      }
    }
    return decoded;
  }

  public hasColumn(name: string): boolean {
    return this.columnsByName.has(name);
  }

  public column(name: string): ColumnDefinition | undefined {
    return this.columnsByName.get(name);
  }
}

export class DomainRepository {
  public constructor(
    public readonly name: string,
    public readonly schema: RuntimeDomainSchema,
    public readonly codec: DomainRowCodec
  ) {}

  public insert(row: DomainRow): RepositoryInsertMutation {
    this.requireMutation('insert');
    this.codec.encodeInsert(row);
    return { kind: 'insert', domain: this.schema.key, row: clonePlainRecord(row) };
  }

  public insertWithNextSequence(
    row: DomainRow,
    allocation: { column: string; scope: DomainRow }
  ): RepositoryInsertMutation {
    this.requireMutation('insert');
    const column = this.codec.column(allocation.column);
    if (!column || column.type !== 'INTEGER' || !allocation.column.endsWith('_seq')) {
      throw new TypeError(`${this.name}.${allocation.column} is not an allocatable INTEGER sequence column.`);
    }
    if (allocation.column in row) throw new TypeError(`${this.name}.${allocation.column} must be allocated by the writer.`);
    this.codec.encodeInsert({ ...row, [allocation.column]: '1' });
    this.codec.encodeWhere(allocation.scope);
    return {
      kind: 'insert',
      domain: this.schema.key,
      row: clonePlainRecord(row),
      allocateSequence: {
        column: allocation.column,
        scope: clonePlainRecord(allocation.scope)
      }
    };
  }

  public update(id: string, patch: DomainRow): RepositoryUpdateMutation {
    this.requireMutation('update');
    requireId(id);
    this.codec.encodePatch(patch);
    return { kind: 'update', domain: this.schema.key, id, patch: clonePlainRecord(patch) };
  }

  public delete(id: string): RepositoryDeleteMutation {
    this.requireMutation('delete');
    requireId(id);
    return { kind: 'delete', domain: this.schema.key, id };
  }

  public get(id: string): RepositoryGetRead {
    requireId(id);
    return { kind: 'get', domain: this.schema.key, id };
  }

  public list(options: Omit<RepositoryListRead, 'kind' | 'domain'>): RepositoryListRead {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0 || options.limit > 1000) {
      throw new RangeError('Repository list limit must be an integer from 1 to 1000.');
    }
    if (options.where) this.codec.encodeWhere(options.where);
    if (options.orderBy && !this.codec.hasColumn(options.orderBy.column)) {
      throw new TypeError(`${this.name} cannot order by unknown column ${options.orderBy.column}.`);
    }
    return {
      kind: 'list',
      domain: this.schema.key,
      ...(options.where ? { where: clonePlainRecord(options.where) } : {}),
      ...(options.orderBy ? { orderBy: { ...options.orderBy } } : {}),
      limit: options.limit
    };
  }

  private requireMutation(mutation: RuntimeDomainMutation): void {
    if (!this.schema.mutations.includes(mutation)) {
      throw new Error(`${this.name} does not allow ${mutation}.`);
    }
  }
}

export class DomainRepositorySet {
  private readonly byDomain = new Map<string, DomainRepository>();
  private readonly byName = new Map<string, DomainRepository>();
  private readonly codecsByDomain = new Map<string, DomainRowCodec>();

  public constructor() {
    for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
      const codec = new DomainRowCodec(schema.codec, schema);
      const repository = new DomainRepository(schema.repository, schema, codec);
      this.byDomain.set(schema.key, repository);
      this.byName.set(repository.name, repository);
      this.codecsByDomain.set(schema.key, codec);
    }
  }

  public domain(domainKey: string): DomainRepository {
    const repository = this.byDomain.get(domainKey);
    if (!repository) throw new Error(`Unknown Runtime domain Repository: ${domainKey}`);
    return repository;
  }

  public named(repositoryName: string): DomainRepository {
    const repository = this.byName.get(repositoryName);
    if (!repository) throw new Error(`Unknown Runtime Repository: ${repositoryName}`);
    return repository;
  }

  public codec(domainKey: string): DomainRowCodec {
    const codec = this.codecsByDomain.get(domainKey);
    if (!codec) throw new Error(`Unknown Runtime domain Codec: ${domainKey}`);
    return codec;
  }

  public all(): readonly DomainRepository[] {
    return RUNTIME_DOMAIN_SCHEMAS.map((schema) => this.domain(schema.key));
  }
}

export const DOMAIN_REPOSITORIES = new DomainRepositorySet();

export function savepoint(
  name: string,
  steps: RepositoryTransactionStep[],
  onError: RepositorySavepoint['onError'] = 'propagate'
): RepositorySavepoint {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new TypeError(`Invalid savepoint name: ${name}`);
  return { kind: 'savepoint', name, steps: steps.map(cloneStep), onError };
}

export function schemaForDomain(domainKey: string): RuntimeDomainSchema {
  const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domainKey);
  if (!schema) throw new Error(`Unknown Runtime domain: ${domainKey}`);
  return schema;
}

function encodeValue(column: ColumnDefinition, value: unknown, codecName: string): string | bigint | Buffer | null {
  if (value === null) {
    if (!column.nullable) throw new TypeError(`${codecName}.${column.name} cannot be null.`);
    return null;
  }
  if (column.json) {
    if (typeof value === 'string') {
      JSON.parse(value);
      return value;
    }
    return JSON.stringify(value);
  }
  if (column.type === 'TEXT') {
    if (typeof value !== 'string') throw new TypeError(`${codecName}.${column.name} must be a string.`);
    return value;
  }
  if (column.type === 'BLOB') {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new TypeError(`${codecName}.${column.name} must be bytes.`);
    }
    return Buffer.from(value);
  }
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new TypeError(`${codecName}.${column.name} must be a bigint or decimal integer string.`);
}

function rejectUnknownKeys(
  record: DomainRow,
  columns: ReadonlyMap<string, ColumnDefinition>,
  codecName: string
): void {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError(`${codecName} input must be an object.`);
  for (const key of Object.keys(record)) {
    if (!columns.has(key)) throw new TypeError(`${codecName} input contains unknown field ${key}.`);
  }
}

function requireId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('Runtime row id must be a non-empty string.');
}

function clonePlainRecord(record: DomainRow): DomainRow {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, clonePlainValue(value)]));
}

function clonePlainValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value === 'bigint' || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(clonePlainValue);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, clonePlainValue(nested)]));
}

function cloneStep(step: RepositoryTransactionStep): RepositoryTransactionStep {
  if (step.kind === 'savepoint') return savepoint(step.name, step.steps, step.onError);
  if (step.kind === 'insert') return {
    ...step,
    row: clonePlainRecord(step.row),
    ...(step.allocateSequence ? {
      allocateSequence: {
        column: step.allocateSequence.column,
        scope: clonePlainRecord(step.allocateSequence.scope)
      }
    } : {})
  };
  if (step.kind === 'update') return { ...step, patch: clonePlainRecord(step.patch) };
  return { ...step };
}
