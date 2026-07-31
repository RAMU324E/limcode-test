import type { RuntimeClientMapping, RuntimeDomainMutation } from '../contracts';

export type SqliteStorageClass = 'TEXT' | 'INTEGER' | 'BLOB';

export interface ForeignKeyDefinition {
  table: string;
  column?: string;
  onDelete?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION';
}

export interface ColumnDefinition {
  name: string;
  type: SqliteStorageClass;
  nullable: boolean;
  defaultSql?: string;
  json?: boolean;
  references?: ForeignKeyDefinition;
}

export interface RuntimeDomainSchema {
  key: string;
  table: string;
  schemaOwner: string;
  repository: string;
  codec: string;
  mutations: readonly RuntimeDomainMutation[];
  client: RuntimeClientMapping;
  deletePolicy: string;
  resetPolicy: 'runtime-dataset';
  indexes: readonly string[];
  columns: readonly ColumnDefinition[];
}

interface ColumnOptions {
  nullable?: boolean;
  defaultSql?: string;
  json?: boolean;
  references?: ForeignKeyDefinition;
}

export function text(name: string, options: ColumnOptions = {}): ColumnDefinition {
  return column(name, 'TEXT', options);
}

export function integer(name: string, options: ColumnOptions = {}): ColumnDefinition {
  return column(name, 'INTEGER', options);
}

export function blob(name: string, options: ColumnOptions = {}): ColumnDefinition {
  return column(name, 'BLOB', options);
}

export function timestampColumns(): ColumnDefinition[] {
  return [text('created_at'), text('updated_at')];
}

export function domain(definition: Omit<RuntimeDomainSchema, 'schemaOwner' | 'resetPolicy'>): RuntimeDomainSchema {
  const names = new Set<string>();
  for (const column of definition.columns) {
    if (!/^[a-z][a-z0-9_]*$/.test(column.name)) throw new Error(`Invalid SQLite column: ${column.name}`);
    if (names.has(column.name)) throw new Error(`Duplicate SQLite column: ${definition.table}.${column.name}`);
    names.add(column.name);
  }
  return Object.freeze({
    ...definition,
    schemaOwner: definition.key,
    resetPolicy: 'runtime-dataset' as const,
    mutations: Object.freeze([...definition.mutations]),
    indexes: Object.freeze([...definition.indexes]),
    columns: Object.freeze(definition.columns.map((entry) => Object.freeze({ ...entry })))
  });
}

function column(name: string, type: SqliteStorageClass, options: ColumnOptions): ColumnDefinition {
  return {
    name,
    type,
    nullable: options.nullable === true,
    ...(options.defaultSql !== undefined ? { defaultSql: options.defaultSql } : {}),
    ...(options.json === true ? { json: true } : {}),
    ...(options.references ? { references: options.references } : {})
  };
}
