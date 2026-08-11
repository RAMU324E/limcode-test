import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readProcessStartFingerprint } from '../backend/reliableKernel/processProtocol';

export const WORKSPACE_RUNTIME_OWNER_FILE = 'owner.json';

export interface WorkspaceRuntimeOwnerMetadata {
  workspaceKey: string;
  ownerToken: string;
  pid: number;
  processStartIdentity: string;
  startedAt: string;
}

export interface WorkspaceRuntimeOwnerClaim {
  readonly claimPath: string;
  readonly metadata: WorkspaceRuntimeOwnerMetadata;
  release(): Promise<void>;
}

export class WorkspaceRuntimeOwnerBusyError extends Error {
  public readonly code = 'workspace-runtime-owner-busy';

  public constructor(
    public readonly claimPath: string,
    public readonly owner: WorkspaceRuntimeOwnerMetadata
  ) {
    super(`Workspace Runtime is already owned by PID ${owner.pid}.`);
    this.name = 'WorkspaceRuntimeOwnerBusyError';
  }
}

export class WorkspaceRuntimeOwnerClaimError extends Error {
  public constructor(
    public readonly code: 'workspace-runtime-owner-invalid' | 'workspace-runtime-owner-mismatch',
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = 'WorkspaceRuntimeOwnerClaimError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * Claims one caller-chosen workspace Runtime path for the lifetime of this Extension Host.
 * Publication and stale-owner isolation use directory rename as the cross-process boundary.
 */
export async function acquireWorkspaceRuntimeOwnerClaim(input: {
  claimPath: string;
  workspaceKey: string;
}): Promise<WorkspaceRuntimeOwnerClaim> {
  const claimPath = requireAbsolutePath(input.claimPath);
  const workspaceKey = requireText(input.workspaceKey, 'workspaceKey');
  const metadata: WorkspaceRuntimeOwnerMetadata = {
    workspaceKey,
    ownerToken: randomUUID(),
    pid: process.pid,
    processStartIdentity: readProcessStartFingerprint(process.pid),
    startedAt: new Date().toISOString()
  };

  await fs.mkdir(path.dirname(claimPath), { recursive: true, mode: 0o700 });
  for (;;) {
    if (await tryPublishClaim(claimPath, metadata)) {
      return new AcquiredWorkspaceRuntimeOwnerClaim(claimPath, metadata);
    }

    const owner = await readOwnerMetadata(claimPath);
    if (!owner) continue;
    if (owner.workspaceKey !== workspaceKey) {
      throw new WorkspaceRuntimeOwnerClaimError(
        'workspace-runtime-owner-mismatch',
        `Workspace Runtime claim path belongs to a different workspace: ${claimPath}`
      );
    }
    if (recordedOwnerIsAlive(owner)) {
      const currentOwner = await readOwnerMetadata(claimPath);
      if (!currentOwner || currentOwner.ownerToken !== owner.ownerToken) continue;
      throw new WorkspaceRuntimeOwnerBusyError(claimPath, currentOwner);
    }
    await isolateDeadOwner(claimPath, owner.ownerToken);
  }
}

class AcquiredWorkspaceRuntimeOwnerClaim implements WorkspaceRuntimeOwnerClaim {
  private released = false;

  public constructor(
    public readonly claimPath: string,
    public readonly metadata: WorkspaceRuntimeOwnerMetadata
  ) {}

  public async release(): Promise<void> {
    if (this.released) return;
    const owner = await readOwnerMetadata(this.claimPath);
    if (!owner || owner.ownerToken !== this.metadata.ownerToken) {
      throw new WorkspaceRuntimeOwnerClaimError(
        'workspace-runtime-owner-mismatch',
        `Workspace Runtime claim is no longer owned by token ${this.metadata.ownerToken}: ${this.claimPath}`
      );
    }

    const releasedPath = generationPath(this.claimPath, `released-${this.metadata.ownerToken}`);
    await fs.rename(this.claimPath, releasedPath);
    this.released = true;
    await fs.rm(releasedPath, { recursive: true, force: true });
  }
}

async function tryPublishClaim(
  claimPath: string,
  metadata: WorkspaceRuntimeOwnerMetadata
): Promise<boolean> {
  const candidatePath = `${claimPath}.candidate-${metadata.ownerToken}`;
  await fs.rm(candidatePath, { recursive: true, force: true });
  await fs.mkdir(candidatePath, { mode: 0o700 });
  let published = false;
  try {
    await fs.writeFile(
      path.join(candidatePath, WORKSPACE_RUNTIME_OWNER_FILE),
      `${JSON.stringify(metadata)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    await fs.rename(candidatePath, claimPath);
    published = true;
    return true;
  } catch (error) {
    if (await isClaimContention(error, claimPath)) return false;
    throw error;
  } finally {
    if (!published) await fs.rm(candidatePath, { recursive: true, force: true });
  }
}

async function isolateDeadOwner(claimPath: string, ownerToken: string): Promise<void> {
  // The deterministic destination is a generation fence. Concurrent contenders that observed the
  // same dead owner collide here instead of accidentally renaming a newer canonical claim.
  const isolatedPath = generationPath(claimPath, `dead-${ownerToken}`);
  try {
    await fs.rename(claimPath, isolatedPath);
  } catch (error) {
    if (isMissingError(error) || isAlreadyExistsError(error)) return;
    throw error;
  }
}

async function readOwnerMetadata(claimPath: string): Promise<WorkspaceRuntimeOwnerMetadata | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(claimPath, WORKSPACE_RUNTIME_OWNER_FILE), 'utf8');
  } catch (error) {
    // The canonical directory may have been released between publication contention and this read.
    if (isMissingError(error)) return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw invalidOwnerError(claimPath, error);
  }
  if (!isOwnerMetadata(value)) throw invalidOwnerError(claimPath);
  return value;
}

function recordedOwnerIsAlive(owner: WorkspaceRuntimeOwnerMetadata): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }

  try {
    return readProcessStartFingerprint(owner.pid) === owner.processStartIdentity;
  } catch {
    // If the platform cannot inspect a verifiably live process, do not steal its Runtime.
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}

function isOwnerMetadata(value: unknown): value is WorkspaceRuntimeOwnerMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Partial<WorkspaceRuntimeOwnerMetadata>;
  return typeof owner.workspaceKey === 'string'
    && owner.workspaceKey.length > 0
    && typeof owner.ownerToken === 'string'
    && owner.ownerToken.length > 0
    && typeof owner.pid === 'number'
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.processStartIdentity === 'string'
    && owner.processStartIdentity.length > 0
    && typeof owner.startedAt === 'string'
    && Number.isFinite(Date.parse(owner.startedAt));
}

async function isClaimContention(error: unknown, claimPath: string): Promise<boolean> {
  if (isAlreadyExistsError(error)) return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) return false;
  try {
    return (await fs.stat(claimPath)).isDirectory();
  } catch {
    return false;
  }
}

function generationPath(claimPath: string, generation: string): string {
  return `${claimPath}.generation-${generation.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function invalidOwnerError(claimPath: string, cause?: unknown): WorkspaceRuntimeOwnerClaimError {
  return new WorkspaceRuntimeOwnerClaimError(
    'workspace-runtime-owner-invalid',
    `Workspace Runtime claim metadata is invalid: ${claimPath}`,
    cause
  );
}

function requireAbsolutePath(value: unknown): string {
  const text = requireText(value, 'claimPath');
  if (!path.isAbsolute(text)) throw new TypeError('claimPath must be absolute.');
  return path.resolve(text);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}
