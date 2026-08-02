import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WorkEnvironmentRecord } from '../../../shared/protocol';
import {
  createRemoteServerWorkEnvironmentRecord,
  remoteWorkEnvironmentIdFromHost
} from '../../../shared/workEnvironmentCatalog';

interface SshConfigEntry {
  alias: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/** Reads VS Code Remote SSH configuration only when the user explicitly requests import. */
export async function readVscodeSshWorkEnvironments(includeDefaultConfig = true): Promise<WorkEnvironmentRecord[]> {
  const byId = new Map<string, WorkEnvironmentRecord>();
  for (const filePath of resolveConfigFiles(includeDefaultConfig)) {
    for (const entry of await readEntries(filePath)) {
      const now = Date.now();
      const record = createRemoteServerWorkEnvironmentRecord({
        id: remoteWorkEnvironmentIdFromHost(entry.alias),
        host: entry.host,
        name: entry.alias,
        source: 'vscodeSshConfig',
        ...(entry.port !== undefined ? { port: entry.port } : {}),
        ...(entry.user ? { user: entry.user } : {}),
        ...(entry.identityFile ? { identityFile: entry.identityFile } : {}),
        available: true,
        createdAt: now,
        updatedAt: now
      }, now);
      byId.set(record.id, record);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id)
  );
}

function resolveConfigFiles(includeDefaultConfig: boolean): string[] {
  const configured = vscode.workspace.getConfiguration('remote.SSH').get<string | string[]>('configFile');
  const files: string[] = [];
  const add = (input: string | undefined): void => {
    const normalized = normalizeConfigPath(input);
    if (normalized && !files.includes(normalized)) files.push(normalized);
  };
  if (Array.isArray(configured)) {
    for (const filePath of configured) add(filePath);
  } else {
    add(configured);
  }
  if (includeDefaultConfig) add(path.join(os.homedir(), '.ssh', 'config'));
  return files;
}

async function readEntries(filePath: string): Promise<SshConfigEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const entries: SshConfigEntry[] = [];
  let aliases: string[] = [];
  let values: Partial<Omit<SshConfigEntry, 'alias'>> = {};
  const flush = (): void => {
    for (const alias of aliases) {
      if (!alias || /[*?!]/.test(alias)) continue;
      entries.push({
        alias,
        host: values.host?.trim() || alias,
        ...(values.user ? { user: values.user } : {}),
        ...(values.port !== undefined ? { port: values.port } : {}),
        ...(values.identityFile ? { identityFile: values.identityFile } : {})
      });
    }
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = unquote(match[2].trim());
    if (key === 'host') {
      flush();
      aliases = value.split(/\s+/).filter(Boolean);
      values = {};
      continue;
    }
    if (aliases.length === 0) continue;
    if (key === 'hostname') values.host = value;
    else if (key === 'user') values.user = value;
    else if (key === 'identityfile') values.identityFile = expandHome(value);
    else if (key === 'port') {
      const port = Number.parseInt(value, 10);
      if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) values.port = port;
    }
  }
  flush();
  return entries;
}

function normalizeConfigPath(input: string | undefined): string | undefined {
  const value = input?.trim();
  return value ? path.resolve(expandHome(unquote(value))) : undefined;
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input.replace(/\$\{env:([^}]+)\}/gi, (_match, name: string) => process.env[name] ?? '');
}

function unquote(input: string): string {
  if (input.length >= 2 && ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'")))) {
    return input.slice(1, -1);
  }
  return input;
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === '"' || character === "'") && line[index - 1] !== '\\') {
      quote = quote === character ? undefined : quote ?? character;
    }
    if (character === '#' && !quote) return line.slice(0, index);
  }
  return line;
}
